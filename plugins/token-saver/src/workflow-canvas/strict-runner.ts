/**
 * Strict runs: execute a canvas graph in `ctx.workflowEngine` with the fixed
 * interpreter script. Each run gets an idle root Session whose Agent is the
 * parent of every step's child agent; the model never drives the flow. The
 * runner turns the interpreter's progress lines into canvas run records and
 * owns every live run until it settles or the plugin unloads.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas/strict-runner
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { WorkflowRun } from '@deepseek-ai/dsh-workflow'
import { boundContextSummary, errorChain } from '@deepseek-ai/dsh-llm'
import type { CanvasGraph, CanvasRun, CanvasRunNode, RunState } from '../protocol.ts'
import { launchSession, type LaunchedSession } from '../shared/session-launch.ts'
import { tokenSaverSource } from '../shared/message-source.ts'
import { interpreterScript, type InterpreterResult, type ProgressEvent } from './interpreter.ts'
import { buildStrictPlan, PROGRESS_TAG, type PlanLimits } from './plan.ts'
import { MAX_RUN_OUTPUT_CHARS, MAX_SUMMARY_CHARS } from './schema.ts'
import type { CanvasStore } from './store.ts'

/** Strict-run configuration. */
export interface StrictRunnerConfig {
  /** Agent preset of the run Session; it must compose a workflow engine. */
  agentPreset?: string | undefined
  /** Child-agent ceiling for one run, passed to the engine. */
  maxAgentsPerRun: number
  limits: PlanLimits
}

/** A strict run that cannot start; the message is shown on the canvas. */
export class StrictRunError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StrictRunError'
  }
}

interface LiveRun {
  workflow: WorkflowRun
  session: LaunchedSession
}

function isProgress(value: unknown): value is ProgressEvent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.tag === PROGRESS_TAG && typeof record.node === 'string' && typeof record.status === 'string' && Array.isArray(record.path)
}

function isResult(value: unknown): value is InterpreterResult {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).output === 'string'
    && typeof (value as Record<string, unknown>).failed === 'boolean'
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Starts, tracks, and cancels strict runs. */
export class StrictRunner {
  private readonly live = new Map<string, LiveRun>()
  /** Workflow-engine run id → canvas run id. */
  private readonly byWorkflow = new Map<string, string>()

  constructor(private readonly ctx: Context, private readonly store: CanvasStore, private readonly config: StrictRunnerConfig) {
    ctx.on('workflow/log', (info, message) => {
      const runId = this.byWorkflow.get(info.id)
      if (runId === undefined) return
      let event: unknown
      try {
        event = JSON.parse(message)
      } catch (narration: unknown) {
        // Only the interpreter's JSON lines carry progress.
        return
      }
      if (isProgress(event)) void this.record(runId, event)
    })
    ctx.effect(() => async () => {
      const runs = [...this.live.values()]
      for (const run of runs) run.workflow.cancel('the canvas plugin is unloading')
      await Promise.allSettled(runs.map(async (run) => {
        await run.workflow.dispose()
        await run.session.handle.dispose()
      }))
    }, 'token-saver.strict-runs')
  }

  /**
   * Whether a run is executing in this process.
   * @param runId - the canvas run id.
   * @returns true while the engine run is live.
   */
  isLive(runId: string): boolean {
    return this.live.has(runId)
  }

  /**
   * Ask a live run to stop.
   * @param runId - the canvas run id.
   * @returns false when the run is not live here.
   */
  cancel(runId: string): boolean {
    const run = this.live.get(runId)
    if (run === undefined) return false
    run.workflow.cancel('cancelled from the canvas')
    return true
  }

  /**
   * Validate and start a strict run.
   * @param graph - the workflow to run.
   * @param cwd - the workspace directory of the run Session.
   * @param input - the text the run starts from.
   * @returns the canvas run id and the run Session id.
   */
  async start(graph: CanvasGraph, cwd: string, input: string): Promise<{ runId: string; sessionId: string }> {
    const plan = buildStrictPlan(graph, id => this.store.get(id), this.config.limits, input)
    const session = await launchSession(this.ctx, {
      cwd,
      title: `${graph.name} · strict`,
      source: tokenSaverSource('canvas-run', boundContextSummary(`Strict run of canvas workflow ${graph.name}`)),
      ...(this.config.agentPreset === undefined ? {} : { agentPreset: this.config.agentPreset }),
    })
    const agent = session.handle.agent
    let workflow: WorkflowRun
    const runId = `run-${randomUUID()}`
    try {
      const engine = this.ctx.agentPresets.serviceFor(agent, 'workflowEngine') ?? this.ctx.get('workflowEngine')
      if (engine === undefined) {
        throw new StrictRunError('strict mode needs a workflow engine; set the canvas strictAgentPreset to a preset that composes dsh-workflow-ptc')
      }
      const now = Date.now()
      const run: CanvasRun = {
        runId,
        graphId: graph.id,
        sessionId: agent.session.id,
        mode: 'strict',
        state: 'running',
        startedAt: now,
        updatedAt: now,
        nodes: Object.fromEntries(graph.nodes.map(node => [node.id, { status: 'pending' as const, updatedAt: now }])),
      }
      await this.store.saveRun(run)
      workflow = engine.start({
        script: interpreterScript(),
        meta: { name: `canvas-${graph.id}`, description: graph.description === '' ? graph.name : graph.description },
        args: plan,
        parent: agent,
        maxTotalAgents: this.config.maxAgentsPerRun,
      })
    } catch (error: unknown) {
      await session.handle.dispose()
      throw error
    }
    this.live.set(runId, { workflow, session })
    this.byWorkflow.set(workflow.id, runId)
    void this.finish(runId, workflow, session)
    return { runId, sessionId: agent.session.id }
  }

  private async record(runId: string, event: ProgressEvent): Promise<void> {
    try {
      await this.store.updateRun(runId, (run) => {
        const now = Date.now()
        const nested = event.path.length > 0
        const nodeId = nested ? event.path[0]! : event.node
        const previous = run.nodes[nodeId]
        if (previous === undefined) return run
        let next: CanvasRunNode
        if (nested) {
          // Nested steps narrate on their top-level loop or subflow node.
          next = { ...previous, summary: clip(`${event.title === '' ? event.node : event.title} · ${event.status}`, MAX_SUMMARY_CHARS), updatedAt: now }
        } else {
          next = { ...previous, status: event.status, updatedAt: now }
          if (event.summary !== undefined) {
            if (event.summary === '') delete next.summary
            else next.summary = clip(event.summary, MAX_SUMMARY_CHARS)
          }
          if (event.branch !== undefined) next.branch = event.branch
          if (event.iteration !== undefined) next.iteration = event.iteration
        }
        return { ...run, updatedAt: now, nodes: { ...run.nodes, [nodeId]: next } }
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`token-saver: strict run ${runId} progress was not recorded: ${errorChain(error)}`)
    }
  }

  private async finish(runId: string, workflow: WorkflowRun, session: LaunchedSession): Promise<void> {
    const result = await workflow.result
    let state: RunState
    let output: string | undefined
    let error = result.error
    if (result.stopReason === 'completed' && isResult(result.value)) {
      state = result.value.failed ? 'failed' : 'done'
      output = result.value.output
      if (result.value.failed) error ??= 'a step failed'
    } else if (result.stopReason === 'cancelled') {
      state = 'cancelled'
    } else {
      state = 'failed'
      error ??= 'the workflow script returned an unexpected value'
    }
    try {
      await this.store.updateRun(runId, (run) => {
        const now = Date.now()
        const nodes = Object.fromEntries(Object.entries(run.nodes).map(([id, node]) =>
          [id, node.status === 'pending' || node.status === 'running' ? { ...node, status: 'skipped' as const, updatedAt: now } : node]))
        return {
          ...run,
          state,
          updatedAt: now,
          nodes,
          ...(output === undefined ? {} : { output: clip(output, MAX_RUN_OUTPUT_CHARS) }),
          ...(error === undefined ? {} : { error: clip(error, MAX_SUMMARY_CHARS) }),
        }
      })
    } catch (writeError: unknown) {
      this.ctx.logger.warn(`token-saver: strict run ${runId} result was not recorded: ${errorChain(writeError)}`)
    }
    try {
      await workflow.dispose()
      await session.handle.dispose()
    } catch (disposeError: unknown) {
      this.ctx.logger.warn(`token-saver: strict run ${runId} cleanup failed: ${errorChain(disposeError)}`)
    } finally {
      this.live.delete(runId)
      this.byWorkflow.delete(workflow.id)
    }
  }
}
