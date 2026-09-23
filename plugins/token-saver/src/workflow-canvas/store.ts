/**
 * Canvas graph/run storage: JSON files under a controlled directory, written
 * atomically (temp + rename) and serialized per file.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas/store
 */

import fs from 'node:fs'
import path from 'node:path'
import { CanvasGraph, CanvasRun, ID_PATTERN } from '../protocol.ts'

/** A zod-like validator for graph/run payloads (structural, not nominal). */
export interface Validator<T> {
  parse(value: unknown): T
}

/** Storage configuration for the canvas. */
export interface CanvasStoreConfig {
  storageDir: string
  maxGraphBytes: number
  keepRuns: number
}

/** A per-file write lock so concurrent writes to one file do not interleave. */
class FileLock {
  private chain: Promise<unknown> = Promise.resolve()
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }
}

/** Loads and saves canvas graphs and runs under one storage directory. */
export class CanvasStore {
  private readonly graphsDir: string
  private readonly runsDir: string
  private readonly locks = new Map<string, FileLock>()

  constructor(private readonly config: CanvasStoreConfig, private readonly graphValidator: Validator<CanvasGraph>, private readonly runValidator: Validator<CanvasRun>) {
    this.graphsDir = path.join(config.storageDir, 'graphs')
    this.runsDir = path.join(config.storageDir, 'runs')
    fs.mkdirSync(this.graphsDir, { recursive: true })
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

  /** List all graphs, newest updated first. */
  list(): CanvasGraph[] {
    const out: CanvasGraph[] = []
    for (const name of fs.readdirSync(this.graphsDir)) {
      if (!name.endsWith('.json')) continue
      const graph = this.readGraphFile(path.join(this.graphsDir, name))
      if (graph !== undefined) out.push(graph)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Read one graph by id. */
  get(id: string): CanvasGraph | undefined {
    this.assertId(id)
    return this.readGraphFile(path.join(this.graphsDir, `${id}.json`))
  }

  private readGraphFile(filePath: string): CanvasGraph | undefined {
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      if (raw.length > this.config.maxGraphBytes) return undefined
      return this.graphValidator.parse(JSON.parse(raw))
    } catch {
      return undefined
    }
  }

  /** Save (create or replace) a graph. */
  save(graph: CanvasGraph): Promise<void> {
    this.assertId(graph.id)
    const json = JSON.stringify(graph)
    if (json.length > this.config.maxGraphBytes) {
      throw new Error(`graph ${graph.id} exceeds ${this.config.maxGraphBytes} bytes`)
    }
    return this.lock(graph.id).run(async () => {
      writeAtomic(path.join(this.graphsDir, `${graph.id}.json`), json)
    })
  }

  /** Delete a graph by id. */
  delete(id: string): void {
    this.assertId(id)
    const filePath = path.join(this.graphsDir, `${id}.json`)
    try {
      fs.unlinkSync(filePath)
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
    }
  }

  /** List the most recent runs for a graph, newest first. */
  runsFor(graphId: string, limit = this.config.keepRuns): CanvasRun[] {
    this.assertId(graphId)
    const out: CanvasRun[] = []
    for (const name of fs.readdirSync(this.runsDir)) {
      if (!name.endsWith('.json')) continue
      const run = this.readRunFile(path.join(this.runsDir, name))
      if (run !== undefined && run.graphId === graphId) out.push(run)
    }
    return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  }

  /** Read one run by runId. */
  getRun(runId: string): CanvasRun | undefined {
    this.assertId(runId)
    return this.readRunFile(path.join(this.runsDir, `${runId}.json`))
  }

  private readRunFile(filePath: string): CanvasRun | undefined {
    try {
      return this.runValidator.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    } catch {
      return undefined
    }
  }

  /** Save (create or replace) a run, pruning older runs past `keepRuns`. */
  saveRun(run: CanvasRun): Promise<void> {
    this.assertId(run.runId)
    const json = JSON.stringify(run)
    return this.lock(run.runId).run(async () => {
      writeAtomic(path.join(this.runsDir, `${run.runId}.json`), json)
      const all = this.runsFor(run.graphId, Number.MAX_SAFE_INTEGER)
      for (const old of all.slice(this.config.keepRuns)) {
        try {
          fs.unlinkSync(path.join(this.runsDir, `${old.runId}.json`))
        } catch {
          /* best effort */
        }
      }
    })
  }
}

/** Atomically write a file (temp + rename). */
function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, filePath)
}
