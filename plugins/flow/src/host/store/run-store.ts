/**
 * Run summary and event storage: JSON summary + append-only JSONL event file
 * under `runs/<flowId>/<runId>/`. The run dir is created on start and pruned
 * when the per-flow retention limit is exceeded.
 *
 * @module @dsh-plugins/flow/host/store/run-store
 */

import fs from 'node:fs'
import path from 'node:path'
import type { RunEvent, RunSummary } from '../../spec/types.ts'
import { ID_PATTERN } from '../../spec/types.ts'
import { runSummarySchema } from '../schemas.ts'
import { writeAtomic } from './atomic.ts'

/** Storage configuration for the run store. */
export interface RunStoreConfig {
  storageDir: string
  maxRunEventsBytes: number
  keepRunsPerFlow: number
}

/** Loads and saves run summaries and event streams. */
export class RunStore {
  private readonly runsDir: string
  /** In-memory runId -> flowId index, seeded by {@link markInterrupted}. */
  private readonly index = new Map<string, string>()

  constructor(private readonly config: RunStoreConfig) {
    this.runsDir = path.join(config.storageDir, 'runs')
    fs.mkdirSync(this.runsDir, { recursive: true })
  }

  private assertId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}`)
  }

  private runDir(flowId: string, runId: string): string {
    this.assertId(flowId)
    this.assertId(runId)
    return path.join(this.runsDir, flowId, runId)
  }

  /** Start a run: write its summary and create its event file. */
  start(run: RunSummary): void {
    const dir = this.runDir(run.flowId, run.runId)
    fs.mkdirSync(dir, { recursive: true })
    writeAtomic(path.join(dir, 'summary.json'), JSON.stringify(run))
    this.index.set(run.runId, run.flowId)
  }

  /** Update a run summary. */
  update(run: RunSummary): void {
    const dir = this.runDir(run.flowId, run.runId)
    writeAtomic(path.join(dir, 'summary.json'), JSON.stringify(run))
  }

  /** Read a run summary by runId, using the in-memory index with a directory scan fallback. */
  get(runId: string): RunSummary | undefined {
    this.assertId(runId)
    const flowId = this.index.get(runId)
    if (flowId !== undefined) {
      return this.readSummary(flowId, runId)
    }
    for (const flowDir of fs.readdirSync(this.runsDir)) {
      const summary = this.readSummary(flowDir, runId)
      if (summary !== undefined) {
        this.index.set(runId, flowDir)
        return summary
      }
    }
    return undefined
  }

  private readSummary(flowId: string, runId: string): RunSummary | undefined {
    const summaryPath = path.join(this.runsDir, flowId, runId, 'summary.json')
    try {
      return runSummarySchema.parse(JSON.parse(fs.readFileSync(summaryPath, 'utf8')))
    } catch {
      return undefined
    }
  }

  /** List runs for a flow, newest first, capped at the retention limit. */
  list(flowId: string, limit = this.config.keepRunsPerFlow): RunSummary[] {
    this.assertId(flowId)
    const dir = path.join(this.runsDir, flowId)
    const out: RunSummary[] = []
    if (!fs.existsSync(dir)) return out
    for (const name of fs.readdirSync(dir)) {
      const summary = this.readSummary(flowId, name)
      if (summary !== undefined) out.push(summary)
    }
    return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  }

  /** Append an event line to a run's event file. */
  appendEvent(run: RunSummary, event: RunEvent): void {
    const dir = this.runDir(run.flowId, run.runId)
    const filePath = path.join(dir, 'events.jsonl')
    const line = `${JSON.stringify(event)}\n`
    const size = this.eventBytes.get(run.runId) ?? (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0)
    const next = size + Buffer.byteLength(line)
    this.eventBytes.set(run.runId, next)
    // Non-terminal events stop being written once the byte limit is exceeded;
    // `run.finished` is always written so the stream can end.
    if (next > this.config.maxRunEventsBytes && event.type !== 'run.finished') {
      this.truncated.add(run.runId)
      return
    }
    fs.appendFileSync(filePath, line, 'utf8')
  }

  /** Track per-run event byte counts without re-stat'ing each event. */
  private readonly eventBytes = new Map<string, number>()
  /** Runs whose persisted events were truncated past the byte limit. */
  private readonly truncated = new Set<string>()

  /** Whether a run's persisted events were truncated. */
  wasTruncated(runId: string): boolean {
    return this.truncated.has(runId)
  }

  /** Read all persisted events for a run. */
  readEvents(runId: string): RunEvent[] {
    this.assertId(runId)
    const flowId = this.index.get(runId)
    if (flowId !== undefined) {
      const events = this.readEventsFrom(runId, flowId)
      if (events !== undefined) return events
    }
    for (const flowDir of fs.readdirSync(this.runsDir)) {
      const events = this.readEventsFrom(runId, flowDir)
      if (events !== undefined) {
        this.index.set(runId, flowDir)
        return events
      }
    }
    return []
  }

  private readEventsFrom(runId: string, flowId: string): RunEvent[] | undefined {
    const filePath = path.join(this.runsDir, flowId, runId, 'events.jsonl')
    if (!fs.existsSync(filePath)) return undefined
    const out: RunEvent[] = []
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (line === '') continue
      try {
        out.push(JSON.parse(line) as RunEvent)
      } catch {
        // Skip a corrupt event line.
      }
    }
    return out
  }

  /** Delete a run's directory and events. */
  deleteRun(flowId: string, runId: string): void {
    const dir = this.runDir(flowId, runId)
    this.index.delete(runId)
    this.eventBytes.delete(runId)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }

  /** Prune runs past the retention limit for a flow. */
  prune(flowId: string): void {
    const runs = this.list(flowId, Number.MAX_SAFE_INTEGER)
    for (const old of runs.slice(this.config.keepRunsPerFlow)) {
      this.deleteRun(flowId, old.runId)
    }
  }

  /** Mark running/waiting runs as interrupted after a restart. */
  markInterrupted(): void {
    for (const flowDir of fs.readdirSync(this.runsDir)) {
      const dir = path.join(this.runsDir, flowDir)
      for (const name of fs.readdirSync(dir)) {
        const summaryPath = path.join(dir, name, 'summary.json')
        try {
          const run = runSummarySchema.parse(JSON.parse(fs.readFileSync(summaryPath, 'utf8')))
          this.index.set(run.runId, run.flowId)
          if (run.status === 'running' || run.status === 'waiting') {
            const next = {
              ...run,
              status: 'interrupted' as const,
              finishedAt: Date.now(),
              error: { code: 'INTERRUPTED', message: 'host restarted' },
            }
            writeAtomic(summaryPath, JSON.stringify(next))
          }
        } catch {
          // Skip unreadable summaries.
        }
      }
    }
  }
}
