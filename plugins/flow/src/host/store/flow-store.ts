/**
 * Flow document and version storage: JSON files under a controlled directory,
 * written atomically and serialized per flow. Drafts, published immutable
 * snapshots, and meta files live under `flows/<flowId>/`.
 *
 * @module @dsh-plugins/flow/host/store/flow-store
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FlowDocument, FlowLookup, VarField } from '../../spec/types.ts'
import { ID_PATTERN } from '../../spec/types.ts'
import { flowDocumentSchema, flowMetaSchema, versionMetaSchema } from '../schemas.ts'
import { FileLock, writeAtomic } from './atomic.ts'

/** Flow meta: published version and optional tool registration. */
export interface FlowMeta {
  publishedVersion?: number
  tool?: { enabled: boolean; name: string; description: string }
  createdAt: number
}

/** A version meta file. */
export interface VersionMeta {
  version: number
  note: string
  publishedAt: number
}

/** A flow list item, with an explicit broken marker instead of silent hiding. */
export interface FlowSummary {
  id: string
  name: string
  description: string
  updatedAt: number
  publishedVersion?: number
  toolName?: string
  nodeCount: number
  broken?: boolean
  reason?: string
}

/** Thrown when a save uses a stale revision. */
export class RevisionConflictError extends Error {
  constructor() {
    super('flow has been modified by another window')
    this.name = 'RevisionConflictError'
  }
}

/** Storage configuration for the flow store. */
export interface FlowStoreConfig {
  storageDir: string
  maxFlowBytes: number
}

/** Loads and saves flows and their published versions under one storage directory. */
export class FlowStore {
  private readonly flowsDir: string
  private readonly runsDir: string
  private readonly locks = new Map<string, FileLock>()

  constructor(private readonly config: FlowStoreConfig) {
    this.flowsDir = path.join(config.storageDir, 'flows')
    this.runsDir = path.join(config.storageDir, 'runs')
    fs.mkdirSync(this.flowsDir, { recursive: true })
    fs.mkdirSync(this.runsDir, { recursive: true })
  }

  private lock(key: string): FileLock {
    let lock = this.locks.get(key)
    if (lock === undefined) {
      lock = new FileLock()
      this.locks.set(key, lock)
    }
    return lock
  }

  private assertId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}`)
  }

  /** List all flows, newest updated first, with explicit broken markers. */
  list(): FlowSummary[] {
    const out: FlowSummary[] = []
    for (const name of fs.readdirSync(this.flowsDir)) {
      if (!name.endsWith('.json') || name.endsWith('.meta.json')) continue
      const flowId = name.slice(0, -'.json'.length)
      if (!ID_PATTERN.test(flowId)) continue
      const read = this.readFlowFile(path.join(this.flowsDir, name))
      const meta = this.getMeta(flowId)
      if (!read.ok) {
        out.push({ id: flowId, name: flowId, description: '', updatedAt: 0, nodeCount: 0, broken: true, reason: read.reason })
        continue
      }
      const doc = read.doc
      out.push({
        id: doc.id,
        name: doc.name,
        description: doc.description,
        updatedAt: doc.updatedAt,
        nodeCount: doc.nodes.length,
        ...(meta?.publishedVersion === undefined ? {} : { publishedVersion: meta.publishedVersion }),
        ...(meta?.tool?.enabled === true ? { toolName: meta.tool.name } : {}),
      })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Read one flow draft by id. */
  get(id: string): FlowDocument | undefined {
    this.assertId(id)
    const read = this.readFlowFile(path.join(this.flowsDir, `${id}.json`))
    return read.ok ? read.doc : undefined
  }

  private readFlowFile(filePath: string): { ok: true; doc: FlowDocument } | { ok: false; reason: string } {
    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf8')
    } catch (error: unknown) {
      return { ok: false, reason: `unreadable draft: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (Buffer.byteLength(raw) > this.config.maxFlowBytes) return { ok: false, reason: `draft exceeds maxFlowBytes (${this.config.maxFlowBytes})` }
    try {
      return { ok: true, doc: flowDocumentSchema.parse(JSON.parse(raw)) }
    } catch (error: unknown) {
      return { ok: false, reason: `invalid draft: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` }
    }
  }

  /** Read a flow meta by id. */
  getMeta(id: string): FlowMeta | undefined {
    this.assertId(id)
    const filePath = path.join(this.flowsDir, `${id}.meta.json`)
    try {
      return flowMetaSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    } catch {
      return undefined
    }
  }

  private writeMeta(id: string, meta: FlowMeta): void {
    this.assertId(id)
    writeAtomic(path.join(this.flowsDir, `${id}.meta.json`), JSON.stringify(meta))
  }

  /** Create a new flow with a default start -> end graph. */
  create(name: string, description: string): FlowDocument {
    const id = `flow-${randomUUID().slice(0, 12)}`
    const now = Date.now()
    const doc: FlowDocument = {
      schemaVersion: 1,
      id,
      name,
      description,
      nodes: [
        { id: `${id}-start`, type: 'start', title: 'Start', position: { x: 0, y: 0 }, data: { fields: [] } },
        { id: `${id}-end`, type: 'end', title: 'End', position: { x: 300, y: 0 }, data: { mode: 'variables', inputs: [] } },
      ],
      edges: [
        { id: `${id}-e1`, source: `${id}-start`, sourceHandle: 'next', target: `${id}-end` },
      ],
      revision: 1,
      updatedAt: now,
    }
    this.writeDraft(doc)
    this.writeMeta(id, { createdAt: now })
    return doc
  }

  /** Save (replace) an existing flow, enforcing optimistic concurrency. */
  save(flow: FlowDocument, baseRevision: number): Promise<FlowDocument> {
    this.assertId(flow.id)
    return this.lock(flow.id).run(async () => {
      const current = this.get(flow.id)
      if (current === undefined) throw new Error(`flow ${flow.id} not found`)
      if (current.revision !== baseRevision) throw new RevisionConflictError()
      const next = { ...flow, revision: baseRevision + 1, updatedAt: Date.now() }
      this.writeDraft(next)
      return next
    })
  }

  private writeDraft(doc: FlowDocument): void {
    const json = JSON.stringify(doc)
    if (Buffer.byteLength(json) > this.config.maxFlowBytes) {
      throw new Error(`flow ${doc.id} exceeds ${this.config.maxFlowBytes} bytes`)
    }
    this.assertId(doc.id)
    writeAtomic(path.join(this.flowsDir, `${doc.id}.json`), json)
  }

  /** Delete a flow, its meta, its versions, and its runs. */
  delete(id: string): void {
    this.assertId(id)
    for (const file of [`${id}.json`, `${id}.meta.json`]) {
      this.unlinkIfPresent(path.join(this.flowsDir, file))
    }
    const flowDir = path.join(this.flowsDir, id)
    if (fs.existsSync(flowDir)) {
      fs.rmSync(flowDir, { recursive: true, force: true })
    }
    // Remove the run directory for this flow.
    this.unlinkIfPresent(path.join(this.runsDir, id))
  }

  private unlinkIfPresent(filePath: string): void {
    try {
      fs.rmSync(filePath, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }

  /** Duplicate a flow into a new id, resetting revision and dropping meta/tool/versions. */
  duplicate(id: string): FlowDocument {
    const source = this.get(id)
    if (source === undefined) throw new Error(`flow ${id} not found`)
    const newId = `flow-${randomUUID().slice(0, 12)}`
    const now = Date.now()
    // Node/edge ids stay unchanged: they are only unique within a document, and
    // rewriting them would leave dangling references (R5 / DANGLING_REF).
    const doc: FlowDocument = {
      ...source,
      id: newId,
      name: `${source.name} (copy)`,
      revision: 1,
      updatedAt: now,
    }
    this.writeDraft(doc)
    this.writeMeta(newId, { createdAt: now })
    return doc
  }

  /** Publish a flow: validate is the caller's job, here we snapshot and bump version. */
  publish(id: string, baseRevision: number, note: string, tool: { enabled: boolean; name: string; description?: string } | undefined): Promise<FlowMeta> {
    this.assertId(id)
    return this.lock(id).run(async () => {
      const current = this.get(id)
      if (current === undefined) throw new Error(`flow ${id} not found`)
      if (current.revision !== baseRevision) throw new RevisionConflictError()
      const meta = this.getMeta(id) ?? { createdAt: Date.now() }
      const version = (meta.publishedVersion ?? 0) + 1
      const versionsDir = path.join(this.flowsDir, id, 'versions')
      fs.mkdirSync(versionsDir, { recursive: true })
      const snapshot = { ...current, revision: baseRevision }
      writeAtomic(path.join(versionsDir, `${version}.json`), JSON.stringify(snapshot))
      writeAtomic(path.join(versionsDir, `${version}.meta.json`), JSON.stringify({ version, note, publishedAt: Date.now() } satisfies VersionMeta))
      const nextMeta: FlowMeta = {
        ...meta,
        publishedVersion: version,
        ...(tool === undefined ? {} : { tool: { enabled: tool.enabled, name: tool.name, description: tool.description ?? '' } }),
      }
      this.writeMeta(id, nextMeta)
      return nextMeta
    })
  }

  /** List published versions, newest first. */
  versions(id: string): VersionMeta[] {
    this.assertId(id)
    const versionsDir = path.join(this.flowsDir, id, 'versions')
    const out: VersionMeta[] = []
    if (!fs.existsSync(versionsDir)) return out
    for (const name of fs.readdirSync(versionsDir)) {
      if (!name.endsWith('.meta.json')) continue
      const version = Number(name.slice(0, -'.meta.json'.length))
      try {
        out.push(versionMetaSchema.parse(JSON.parse(fs.readFileSync(path.join(versionsDir, name), 'utf8'))))
      } catch {
        out.push({ version, note: 'unreadable', publishedAt: 0 })
      }
    }
    return out.sort((a, b) => b.version - a.version)
  }

  /** Read a specific published version. */
  version(id: string, version: number): FlowDocument | undefined {
    this.assertId(id)
    try {
      return flowDocumentSchema.parse(JSON.parse(fs.readFileSync(path.join(this.flowsDir, id, 'versions', `${version}.json`), 'utf8')))
    } catch {
      return undefined
    }
  }

  /** The latest published version number, if any. */
  latestPublishedVersion(id: string): number | undefined {
    return this.getMeta(id)?.publishedVersion
  }

  /** Import a flow, reassigning the flow id and resetting revision. */
  import(doc: FlowDocument): FlowDocument {
    if (doc.schemaVersion !== 1) throw new Error(`unsupported schema version ${doc.schemaVersion}`)
    const newId = `flow-${randomUUID().slice(0, 12)}`
    const now = Date.now()
    const next: FlowDocument = {
      ...doc,
      id: newId,
      name: doc.name,
      revision: 1,
      updatedAt: now,
    }
    this.writeDraft(next)
    this.writeMeta(newId, { createdAt: now })
    return next
  }

  /** The subflow lookup: resolve a flow's start inputs and end outputs. */
  readonly lookup: FlowLookup = (flowId, version) => {
    let doc: FlowDocument | undefined
    if (version === 'draft') doc = this.get(flowId)
    else if (version === 'published') {
      const v = this.latestPublishedVersion(flowId)
      doc = v === undefined ? undefined : this.version(flowId, v)
    } else {
      doc = this.version(flowId, version)
    }
    if (doc === undefined) return undefined
    return { inputs: startInputs(doc), outputs: endOutputs(doc), subflows: subflowRefs(doc) }
  }
}

/** The start node's input fields. */
function startInputs(doc: FlowDocument): VarField[] {
  const start = doc.nodes.find(node => node.type === 'start')
  return start?.type === 'start'
    ? start.data.fields.map(f => ({ name: f.name, schema: f.schema, ...(f.required === undefined ? {} : { required: f.required }) }))
    : []
}

/** The end node's output fields. */
function endOutputs(doc: FlowDocument): VarField[] {
  const end = doc.nodes.find(node => node.type === 'end')
  if (end?.type === 'end') {
    if (end.data.mode === 'text') return [{ name: 'text', schema: { type: 'string' } }]
    return end.data.inputs.map(binding => ({ name: binding.name, schema: binding.schema }))
  }
  return []
}

/** The subflows a document references directly. */
function subflowRefs(doc: FlowDocument): { flowId: string; version: 'published' | 'draft' }[] {
  return doc.nodes.flatMap(node => node.type === 'subflow' && node.data.flowId !== '' ? [{ flowId: node.data.flowId, version: node.data.version }] : [])
}
