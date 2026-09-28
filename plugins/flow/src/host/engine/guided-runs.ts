/**
 * Guided runs: runs of a guided flow that a model carries out and reports
 * step by step through `flow_workflow report`. Each report becomes a regular
 * run event, so the run view, canvas overlays, persistence, and event stream
 * are the same as for engine runs. A run ends when its end step is reported
 * done, when it is cancelled, or when it outlives the run duration limit.
 *
 * @module @dsh-plugins/flow/host/engine/guided-runs
 */

import { randomUUID } from 'node:crypto'
import type { FlowDocument, JsonValue, RunSummary } from '../../spec/types.ts'
import { compileGuided, type GuidedStep } from '../../spec/guided.ts'
import { specOf } from '../../spec/nodes/index.ts'
import { foldRunEvents } from '../../spec/run-view.ts'
import type { RunStore } from '../store/run-store.ts'
import type { EventHub } from './events.ts'
import type { RunEmitter } from './scheduler.ts'

/** A step status a model reports. */
export const GUIDED_REPORT_STATUSES = ['running', 'done', 'failed', 'skipped'] as const
export type GuidedReportStatus = (typeof GUIDED_REPORT_STATUSES)[number]

/** A report or status request that cannot be applied; the message is returned to the model. */
export class GuidedRunError extends Error {
  constructor(readonly code: 'RUN_NOT_ACTIVE' | 'UNKNOWN_STEP', message: string) {
    super(message)
    this.name = 'GuidedRunError'
  }
}

/** Progress of a guided run, as the tool returns it. */
export interface GuidedProgress {
  runId: string
  status: RunSummary['status']
  done: number
  total: number
  pending: string[]
  steps: Record<string, { status: string; summary?: string }>
}

interface GuidedRun {
  summary: RunSummary
  doc: FlowDocument
  steps: GuidedStep[]
  emitter: RunEmitter
  /** Step node id -> execKey of the attempt reported running and not yet finished. */
  open: Map<string, string>
  rounds: Map<string, number>
  last: Map<string, { status: string; summary?: string }>
  timer: ReturnType<typeof setTimeout>
}

/** What {@link GuidedRuns} needs from the engine. */
export interface GuidedRunsDeps {
  runStore: RunStore
  eventHub: EventHub
  emitterFor(summary: RunSummary): RunEmitter
  maxRunDurationMs: number
  flowName(flowId: string): string | undefined
  warn(message: string): void
}

/** The live guided runs of this process. */
export class GuidedRuns {
  private readonly runs = new Map<string, GuidedRun>()

  constructor(private readonly deps: GuidedRunsDeps) {}

  /** Whether a guided run is live here. */
  has(runId: string): boolean {
    return this.runs.has(runId)
  }

  /**
   * Start a guided run: record it, emit `run.started`, and mark the start step done.
   * @param doc - the guided flow version being followed.
   * @param version - the version recorded on the run.
   * @param inputs - validated start inputs.
   * @param sessionId - the session following the run, when known.
   * @param workspacePath - the session's working directory, when known.
   * @returns the run summary.
   */
  create(doc: FlowDocument, version: number | 'draft', inputs: Record<string, JsonValue>, sessionId: string | undefined, workspacePath: string | undefined): RunSummary {
    const runId = `run-${randomUUID().slice(0, 12)}`
    const summary: RunSummary = {
      runId,
      flowId: doc.id,
      flowName: doc.name,
      version,
      trigger: { kind: 'guided', ...(sessionId === undefined ? {} : { sessionId }) },
      status: 'running',
      inputs,
      ...(sessionId === undefined ? {} : { sessionId }),
      startedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
      nodeExecutions: 0,
      ...(workspacePath === undefined ? {} : { workspacePath }),
    }
    this.deps.runStore.start(summary)
    const emitter = this.deps.emitterFor(summary)
    const run: GuidedRun = {
      summary,
      doc,
      steps: compileGuided(doc, { flowName: this.deps.flowName }),
      emitter,
      open: new Map(),
      rounds: new Map(),
      last: new Map(),
      timer: setTimeout(() => { this.finish(runId, 'failed', undefined, { code: 'RUN_TIMEOUT', message: 'the guided run was not finished in time' }) }, this.deps.maxRunDurationMs),
    }
    run.timer.unref?.()
    this.runs.set(runId, run)
    emitter.emit({ seq: emitter.seq++, time: Date.now(), type: 'run.started', runId, flowId: doc.id, version, inputs })
    const start = doc.nodes.find(node => node.type === 'start')
    if (start !== undefined) {
      const execKey = `${start.id}#1`
      emitter.emit({ seq: emitter.seq++, time: Date.now(), type: 'node.started', execKey, nodeId: start.id, path: [], attempt: 1, inputs })
      emitter.emit({ seq: emitter.seq++, time: Date.now(), type: 'node.finished', execKey, nodeId: start.id, path: [], attempt: 1, status: 'succeeded', outputs: inputs, firedPorts: ['next'] })
    }
    return summary
  }

  /**
   * The live run's flow version and summary.
   * @param runId - the run.
   * @returns the run, or undefined when it is not live here.
   */
  get(runId: string): { doc: FlowDocument; summary: RunSummary } | undefined {
    const run = this.runs.get(runId)
    return run === undefined ? undefined : { doc: run.doc, summary: run.summary }
  }

  /**
   * Record the session that follows a run.
   * @param runId - the run.
   * @param sessionId - the session.
   */
  attach(runId: string, sessionId: string): void {
    const run = this.runs.get(runId)
    if (run === undefined) return
    run.summary = { ...run.summary, trigger: { kind: 'guided', sessionId }, sessionId }
    this.update(run)
  }

  /**
   * Apply one step report. Reporting the end step done finishes the run.
   * @param runId - the run.
   * @param nodeId - the step's node id.
   * @param status - the reported status.
   * @param summary - a short result summary.
   * @param branch - for decisions: the chosen branch, by label or port id.
   * @param outputs - for the end step: the result fields.
   * @returns the run's progress after the report.
   */
  report(runId: string, nodeId: string, status: GuidedReportStatus, summary: string | undefined, branch: string | undefined, outputs: JsonValue | undefined): GuidedProgress {
    const run = this.runs.get(runId)
    if (run === undefined) throw new GuidedRunError('RUN_NOT_ACTIVE', `guided run ${runId} is not active; start the workflow again`)
    const node = run.doc.nodes.find(candidate => candidate.id === nodeId)
    if (node === undefined || !run.steps.some(step => step.nodeId === nodeId)) {
      throw new GuidedRunError('UNKNOWN_STEP', `unknown step ${JSON.stringify(nodeId)}; steps are ${run.steps.map(step => step.nodeId).join(', ')}`)
    }
    const { emitter } = run
    let execKey = run.open.get(nodeId)
    if (execKey === undefined && status !== 'skipped') {
      const round = (run.rounds.get(nodeId) ?? 0) + 1
      run.rounds.set(nodeId, round)
      execKey = `${nodeId}#${round}`
      run.open.set(nodeId, execKey)
      emitter.emit({ seq: emitter.seq++, time: Date.now(), type: 'node.started', execKey, nodeId, path: [], attempt: 1, inputs: null })
      run.summary = { ...run.summary, nodeExecutions: run.summary.nodeExecutions + 1 }
    }
    const text = summary?.trim() ?? ''
    run.last.set(nodeId, { status, ...(text === '' ? {} : { summary: text }) })
    if (status === 'running') return this.progressOf(run)

    run.open.delete(nodeId)
    const key = execKey ?? `${nodeId}#skipped`
    const ports = specOf(node).ports(node)
    const wanted = branch?.trim().toLowerCase()
    const chosen = wanted === undefined || wanted === '' ? undefined : ports.find(port => port.id.toLowerCase() === wanted || port.label.toLowerCase() === wanted)
    const firedPorts = status !== 'done' ? [] : chosen !== undefined ? [chosen.id] : ports.some(port => port.id === 'next') ? ['next'] : []
    const stepOutputs: Record<string, JsonValue> = {
      ...(text === '' ? {} : { summary: text }),
      ...(chosen === undefined ? {} : { branch: chosen.label }),
      ...(outputs !== undefined && outputs !== null && typeof outputs === 'object' && !Array.isArray(outputs) ? outputs : {}),
    }
    emitter.emit({
      seq: emitter.seq++,
      time: Date.now(),
      type: 'node.finished',
      execKey: key,
      nodeId,
      path: [],
      attempt: 1,
      status: status === 'done' ? 'succeeded' : status === 'failed' ? 'failed' : 'skipped',
      outputs: stepOutputs,
      firedPorts,
      ...(status === 'failed' ? { error: { code: 'STEP_FAILED', message: text === '' ? 'the step failed' : text } } : {}),
    })
    const progress = this.progressOf(run)
    if (node.type === 'end' && status === 'done') {
      const result: JsonValue = outputs !== undefined && outputs !== null && typeof outputs === 'object' && !Array.isArray(outputs) ? outputs : { text }
      this.finish(runId, 'succeeded', result)
      return { ...progress, status: 'succeeded' }
    }
    return progress
  }

  /**
   * A run's progress: live runs from their reports, finished runs from their persisted events.
   * @param runId - the run.
   * @returns the progress, or undefined for an unknown run.
   */
  progress(runId: string): GuidedProgress | undefined {
    const run = this.runs.get(runId)
    if (run !== undefined) return this.progressOf(run)
    const summary = this.deps.runStore.get(runId)
    if (summary === undefined) return undefined
    const view = foldRunEvents(this.deps.runStore.readEvents(runId))
    const steps: GuidedProgress['steps'] = {}
    for (const node of view.nodes) {
      const text = node.outputs !== null && typeof node.outputs === 'object' && !Array.isArray(node.outputs) ? node.outputs['summary'] : undefined
      steps[node.nodeId] = { status: node.status, ...(typeof text === 'string' ? { summary: text } : {}) }
    }
    const values = Object.values(steps)
    return { runId, status: summary.status, done: values.filter(step => step.status !== 'running').length, total: values.length, pending: [], steps }
  }

  /**
   * End a live run.
   * @param runId - the run.
   * @param status - the final status.
   * @param outputs - the result, for a successful run.
   * @param error - the reason, for a failed or cancelled run.
   */
  finish(runId: string, status: 'succeeded' | 'failed' | 'cancelled', outputs?: JsonValue, error?: { code: string; message: string }): void {
    const run = this.runs.get(runId)
    if (run === undefined) return
    clearTimeout(run.timer)
    this.runs.delete(runId)
    const now = Date.now()
    try {
      run.emitter.emit({
        seq: run.emitter.seq++,
        time: now,
        type: 'run.finished',
        status,
        ...(outputs === undefined ? {} : { outputs }),
        ...(error === undefined ? {} : { error }),
        usage: run.summary.usage,
        durationMs: now - run.summary.startedAt,
      })
      run.summary = { ...run.summary, status, finishedAt: now, ...(outputs === undefined ? {} : { outputs }), ...(error === undefined ? {} : { error }) }
      this.update(run)
      this.deps.runStore.prune(run.summary.flowId)
    } finally {
      this.deps.eventHub.close(runId)
    }
  }

  /** Cancel every live run of a flow. */
  cancelFlow(flowId: string): void {
    for (const [runId, run] of [...this.runs]) if (run.summary.flowId === flowId) this.finish(runId, 'cancelled')
  }

  /** Plugin teardown: the following sessions can no longer report, so live runs end as interrupted. */
  dispose(): void {
    for (const [runId, run] of [...this.runs]) {
      clearTimeout(run.timer)
      this.runs.delete(runId)
      run.summary = { ...run.summary, status: 'interrupted', finishedAt: Date.now(), error: { code: 'INTERRUPTED', message: 'the flow plugin stopped' } }
      this.update(run)
      this.deps.eventHub.close(runId)
    }
  }

  private progressOf(run: GuidedRun): GuidedProgress {
    const steps: GuidedProgress['steps'] = {}
    for (const step of run.steps) steps[step.nodeId] = run.last.get(step.nodeId) ?? { status: 'pending' }
    const entries = Object.entries(steps)
    return {
      runId: run.summary.runId,
      status: run.summary.status,
      done: entries.filter(([, step]) => step.status !== 'pending' && step.status !== 'running').length,
      total: entries.length,
      pending: entries.filter(([, step]) => step.status === 'pending').map(([id]) => id),
      steps,
    }
  }

  private update(run: GuidedRun): void {
    try {
      this.deps.runStore.update(run.summary)
    } catch (error: unknown) {
      this.deps.warn(`flow: guided run summary update failed for ${run.summary.runId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
