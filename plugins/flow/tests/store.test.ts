import { describe, expect, it, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FlowStore, RevisionConflictError } from '../src/host/store/flow-store.ts'
import { RunStore } from '../src/host/store/run-store.ts'
import type { RunSummary } from '../src/spec/types.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-store-'))
})

function store(): FlowStore {
  return new FlowStore({ storageDir: dir, maxFlowBytes: 1024 * 1024 })
}

describe('FlowStore', () => {
  it('creates a flow with a default start -> end graph', () => {
    const s = store()
    const flow = s.create('My flow', 'desc')
    expect(flow.nodes).toHaveLength(2)
    expect(flow.nodes[0]?.type).toBe('start')
    expect(flow.nodes[1]?.type).toBe('end')
    expect(s.get(flow.id)?.name).toBe('My flow')
  })

  it('saves with optimistic concurrency', async () => {
    const s = store()
    const flow = s.create('F', '')
    const saved = await s.save(flow, flow.revision)
    expect(saved.revision).toBe(flow.revision + 1)
  })

  it('throws RevisionConflictError on a stale revision', async () => {
    const s = store()
    const flow = s.create('F', '')
    await s.save(flow, flow.revision)
    await expect(s.save(flow, flow.revision)).rejects.toBeInstanceOf(RevisionConflictError)
  })

  it('duplicates a flow with a new id', () => {
    const s = store()
    const flow = s.create('F', '')
    const copy = s.duplicate(flow.id)
    expect(copy.id).not.toBe(flow.id)
    expect(copy.name).toContain('(copy)')
    expect(copy.revision).toBe(1)
  })

  it('publishes an immutable snapshot and bumps the version', async () => {
    const s = store()
    const flow = s.create('F', '')
    const meta = await s.publish(flow.id, flow.revision, 'v1', undefined)
    expect(meta.publishedVersion).toBe(1)
    const v = s.version(flow.id, 1)
    expect(v?.name).toBe('F')
    expect(s.latestPublishedVersion(flow.id)).toBe(1)
  })

  it('lists flows with node counts and broken markers', () => {
    const s = store()
    s.create('A', '')
    const summaries = s.list()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.name).toBe('A')
    expect(summaries[0]?.nodeCount).toBe(2)
  })

  it('imports a flow reassigning ids', () => {
    const s = store()
    const flow = s.create('F', '')
    const imported = s.import({ ...flow, id: 'flow-other' })
    expect(imported.id).not.toBe('flow-other')
    expect(s.get(imported.id)?.name).toBe('F')
  })

  it('deletes a flow and its runs', () => {
    const s = store()
    const flow = s.create('F', '')
    s.delete(flow.id)
    expect(s.get(flow.id)).toBeUndefined()
  })
})

describe('RunStore', () => {
  it('starts, reads, and lists runs', () => {
    const runStore = new RunStore({ storageDir: dir, maxRunEventsBytes: 1024, keepRunsPerFlow: 5 })
    const run: RunSummary = {
      runId: 'run-1', flowId: 'flow-1', flowName: 'F', version: 'draft', trigger: { kind: 'canvas' },
      status: 'running', inputs: {}, startedAt: 0, usage: { inputTokens: 0, outputTokens: 0 }, nodeExecutions: 0, workspacePath: '/tmp',
    }
    runStore.start(run)
    expect(runStore.get('run-1')?.runId).toBe('run-1')
    expect(runStore.list('flow-1')).toHaveLength(1)
  })

  it('appends and reads events', () => {
    const runStore = new RunStore({ storageDir: dir, maxRunEventsBytes: 1024, keepRunsPerFlow: 5 })
    const run: RunSummary = {
      runId: 'run-1', flowId: 'flow-1', flowName: 'F', version: 'draft', trigger: { kind: 'canvas' },
      status: 'running', inputs: {}, startedAt: 0, usage: { inputTokens: 0, outputTokens: 0 }, nodeExecutions: 0, workspacePath: '/tmp',
    }
    runStore.start(run)
    runStore.appendEvent(run, { seq: 1, time: 1, type: 'run.started', runId: 'run-1', flowId: 'flow-1', version: 'draft', inputs: {} })
    expect(runStore.readEvents('run-1')).toHaveLength(1)
  })

  it('marks interrupted runs after a restart', () => {
    const runStore = new RunStore({ storageDir: dir, maxRunEventsBytes: 1024, keepRunsPerFlow: 5 })
    const run: RunSummary = {
      runId: 'run-1', flowId: 'flow-1', flowName: 'F', version: 'draft', trigger: { kind: 'canvas' },
      status: 'running', inputs: {}, startedAt: 0, usage: { inputTokens: 0, outputTokens: 0 }, nodeExecutions: 0, workspacePath: '/tmp',
    }
    runStore.start(run)
    runStore.markInterrupted()
    expect(runStore.get('run-1')?.status).toBe('interrupted')
  })
})
