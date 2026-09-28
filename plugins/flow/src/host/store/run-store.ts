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
  }

  /** Update a run summary. */
  update(run: RunSummary): void {
    const dir = this.runDir(run.flowId, run.runId)
    writeAtomic(path.join(dir, 'summary.json'), JSON.stringify(run))
  }

  /** Read a run summary by runId, scanning all flow dirs. */
  get(runId: string): RunSummary | undefined {
    this.assertId(runId)
    for (const flowDir of fs.readdirSync(this.runsDir)) {
      const summaryPath = path.join(this.runsDir, flowDir, runId, 'summary.json')
      try {
        return runSummarySchema.parse(JSON.parse(fs.readFileSync(summaryPath, 'utf8')))
      } catch {
        // Not this flow; keep scanning.
      }
    }
    return undefined
  }

  /** List runs for a flow, newest first, capped at the retention limit. */
  list(flowId: string, limit = this.config.keepRunsPerFlow): RunSummary[] {
    this.assertId(flowId)
    const dir = path.join(this.runsDir, flowId)
    const out: RunSummary[] = []
    if (!fs.existsSync(dir)) return out
    for (const name of fs.readdirSync(dir)) {
      try {
        out.push(runSummarySchema.parse(JSON.parse(fs.readFileSync(path.join(dir, name, 'summary.json'), 'utf8'))))
      } catch {
        // Unreadable run is skipped.
      }
    }
    return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  }

  /** Append an event line to a run's event file. */
  appendEvent(run: RunSummary, event: RunEvent): void {
    const dir = this.runDir(run.flowId, run.runId)
    const filePath = path.join(dir, 'events.jsonl')
    const line = `${JSON.stringify(event)}\n`
    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
    if (size + Buffer.byteLength(line) > this.config.maxRunEventsBytes) return
    fs.appendFileSync(filePath, line, 'utf8')
  }

  /** Read all persisted events for a run. */
  readEvents(runId: string): RunEvent[] {
    this.assertId(runId)
    for (const flowDir of fs.readdirSync(this.runsDir)) {
      const filePath = path.join(this.runsDir, flowDir, runId, 'events.jsonl')
      if (!fs.existsSync(filePath)) continue
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
    return []
  }

  /** Delete a run's directory and events. */
  deleteRun(flowId: string, runId: string): void {
    const dir = this.runDir(flowId, runId)
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
          if (run.status === 'running' || run.status === 'waiting') {
            const next = { ...run, status: 'interrupted' as const }
            writeAtomic(summaryPath, JSON.stringify(next))
          }
        } catch {
          // Skip unreadable summaries.
        }
      }
    }
  }
}
