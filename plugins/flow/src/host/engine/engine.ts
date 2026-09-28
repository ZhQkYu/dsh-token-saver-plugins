/**
 * FlowEngine: the run orchestrator. Implements the {@link RunController} the
 * run routes delegate to. Validates and compiles a flow before a run exists,
 * runs it through the scheduler, persists and streams its events, and owns
 * cancel/answer/debug and plugin teardown.
 *
 * @module @dsh-plugins/flow/host/engine/engine
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { randomUUID } from 'node:crypto'
import type { AnswerSpec, FlowDocument, FlowLookup, FlowNode, FrameStep, InputBinding, Issue, JsonValue, RunEvent, RunSummary, VarField } from '../../spec/types.ts'
import { ID_PATTERN, RUN_EVENTS_PING_MS } from '../../spec/types.ts'
import { coerce } from '../../spec/coerce.ts'
import { iterBindings, iterTemplates } from '../../spec/validate.ts'
import { specOf } from '../../spec/nodes/index.ts'
import { templateVariables } from '../../spec/template.ts'
import { compile, FlowValidationError, type ExecutionPlan } from './compile.ts'
import { classifyRunAbort, runFlow, runContainerFrame, runScopeFrame, RunAbort, Semaphore, type RunContext, type RunEmitter, type RunResult } from './scheduler.ts'
import { RunBudget, NodeError } from './budget.ts'
import { createFrame } from './frames.ts'
import { EventHub } from './events.ts'
import { buildExecutors } from '../executors/registry.ts'
import type { FlowServices, Interaction } from '../executors/index.ts'
import type { FlowStore } from '../store/flow-store.ts'
import type { RunStore } from '../store/run-store.ts'
import { RunAgentManager } from '../services/run-agent.ts'
import { createGuardedFetch } from '../services/guarded-fetch.ts'
import { validateLimitsOf, type FlowLimits } from '../limits.ts'
import { knownToolSchemas } from '../known-tools.ts'
import { recordValue } from './record.ts'

/** Engine configuration drawn from the resolved limits. */
export interface EngineConfig extends FlowLimits {
  agent: { provider: string }
  tools: { prefix: string }
}

/** How long plugin teardown waits for aborted runs to finalize. */
export const DISPOSE_WAIT_MS = 3000

/** Thrown when a run's start inputs fail validation before the run starts. */
export class InputValidationError extends Error {
  constructor(readonly field: string, readonly code: string, message: string) {
    super(message)
    this.name = 'InputValidationError'
  }
}

/** Thrown when a run cannot start for a reason other than flow validation (missing flow, workspace, node). */
export class RunStartError extends Error {
  constructor(readonly code: 'FLOW_NOT_FOUND' | 'WORKSPACE_NOT_FOUND' | 'NODE_NOT_FOUND' | 'DEBUG_UNSUPPORTED', message: string, readonly status: 400 | 404 = 400) {
    super(message)
    this.name = 'RunStartError'
  }
}

/** A canvas interaction: emit `run.waiting` and resolve on `run.answer`. */
class CanvasInteraction implements Interaction {
  private readonly waiting = new Map<string, { resolve: (value: { text?: string; optionId?: string }) => void; reject: (reason: unknown) => void; spec: AnswerSpec }>()

  constructor(private readonly emitter: RunEmitter, private readonly onWaitingChange: (waiting: boolean) => void) {}

  async ask(execKey: string, question: string, answerSpec: AnswerSpec, signal: AbortSignal): Promise<{ text?: string; optionId?: string }> {
    signal.throwIfAborted()
    this.emitter.emit({ seq: this.emitter.seq++, time: Date.now(), type: 'run.waiting', execKey, question, answer: answerSpec })
    return await new Promise<{ text?: string; optionId?: string }>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.waiting.get(execKey) !== entry) return
        this.settle(execKey)
        reject(signal.reason ?? new Error('run cancelled while waiting for an answer'))
      }
      const entry = {
        spec: answerSpec,
        resolve: (value: { text?: string; optionId?: string }): void => { signal.removeEventListener('abort', onAbort); resolve(value) },
        reject: (reason: unknown): void => { signal.removeEventListener('abort', onAbort); reject(reason) },
      }
      this.waiting.set(execKey, entry)
      signal.addEventListener('abort', onAbort, { once: true })
      this.onWaitingChange(true)
    })
  }

  /** Whether an answer is acceptable for the pending question at `execKey`. */
  accepts(execKey: string, answer: { text?: string; optionId?: string }): boolean | undefined {
    const entry = this.waiting.get(execKey)
    if (entry === undefined) return undefined
    if (entry.spec.kind === 'text') return answer.text !== undefined
    if (answer.optionId !== undefined) return entry.spec.options.some(option => option.id === answer.optionId)
    return entry.spec.allowOther && answer.text !== undefined
  }

  answer(execKey: string, answer: { text?: string; optionId?: string }): boolean {
    const entry = this.waiting.get(execKey)
    if (entry === undefined) return false
    this.settle(execKey)
    entry.resolve(answer)
    this.emitter.emit({ seq: this.emitter.seq++, time: Date.now(), type: 'run.resumed', execKey })
    return true
  }

  /** Reject all unanswered waits (used at finalize). */
  dispose(): void {
    for (const [execKey, entry] of [...this.waiting]) {
      this.settle(execKey)
      entry.reject(new Error('run ended while waiting for an answer'))
    }
  }

  private settle(execKey: string): void {
    this.waiting.delete(execKey)
    if (this.waiting.size === 0) this.onWaitingChange(false)
  }
}

/** A session interaction that routes questions through `ctx.userQuestions`. */
class SessionInteraction implements Interaction {
  constructor(private readonly ctx: Context, private readonly agent: Agent) {}

  async ask(execKey: string, question: string, answerSpec: AnswerSpec, signal: AbortSignal): Promise<{ text?: string; optionId?: string }> {
    const service = this.ctx.get('userQuestions')
    if (service === undefined) throw new NodeError('SERVICE_UNAVAILABLE', 'question node requires the userQuestions service')
    const id = `flow-${execKey}`.replace(/[^A-Za-z0-9_-]/g, '_')
    const item = answerSpec.kind === 'options'
      ? { id, question, options: answerSpec.options.map(option => ({ label: option.label })) }
      : { id, question }
    let result: Awaited<ReturnType<typeof service.ask>>
    try {
      result = await service.ask({ questions: [item], agent: this.agent, signal })
    } catch (error: unknown) {
      const code = (error as { code?: unknown }).code
      if (code === 'CALLER_NOT_LIVE' || code === 'DELEGATED_CALLER') {
        throw new NodeError('QUESTION_UNAVAILABLE', error instanceof Error ? error.message : String(error))
      }
      throw error
    }
    const answer = result.answers.find(entry => entry.id === id) ?? result.answers[0]
    if (answer === undefined) return {}
    const label = answer.selected[0]
    if (answerSpec.kind === 'text') return { text: answer.custom ?? label ?? '' }
    // Validation rejects duplicate labels, so a label identifies one option.
    const optionId = answerSpec.options.find(option => option.label === label)?.id
    return { ...(optionId === undefined ? {} : { optionId }), ...(answer.custom === undefined && label === undefined ? {} : { text: answer.custom ?? label }) }
  }
}

/** A live run, tracking its abort controller, agent manager, emitter, and completion. */
interface LiveRun {
  runId: string
  flowId: string
  controller: AbortController
  agentManager: RunAgentManager
  budget: RunBudget
  emitter: RunEmitter
  done: Promise<RunSummary>
  timer?: ReturnType<typeof setTimeout>
}

/** The flow engine. */
export class FlowEngine {
  private readonly eventHub = new EventHub()
  private readonly live = new Map<string, LiveRun>()
  private readonly executors = buildExecutors()
  private readonly interactions = new Map<string, CanvasInteraction>()

  constructor(
    private readonly ctx: Context,
    private readonly flowStore: FlowStore,
    private readonly runStore: RunStore,
    private readonly config: EngineConfig,
  ) {}

  /**
   * Start a run. Every precondition is checked synchronously before the run
   * exists: a failure throws ({@link FlowValidationError}, {@link InputValidationError},
   * {@link RunStartError}) and nothing is written.
   */
  async start(request: {
    flowId: string
    version: number | 'draft' | 'published'
    inputs: JsonValue
    workspaceId?: string
    workspacePath?: string
    caller?: { agent: Agent; parent: ToolExecutionToken; rootCallId: ToolCallId; callId: string }
  }): Promise<{ runId: string }> {
    const doc = this.resolveFlow(request.flowId, request.version)
    if (doc === undefined) throw new RunStartError('FLOW_NOT_FOUND', `flow ${request.flowId} (${String(request.version)}) not found`, 404)
    const plan = compile(doc, this.flowStore.lookup, this.validateLimits())
    this.checkServiceAvailability(doc, request.caller !== undefined)
    const workspacePath = this.resolveWorkspace(request.workspaceId, request.workspacePath)
    const inputs = validateStartInputs(doc, request.inputs, this.config.maxValueBytes)

    const runId = `run-${randomUUID().slice(0, 12)}`
    const version = request.version === 'published' ? (this.flowStore.latestPublishedVersion(doc.id) ?? 'draft') : request.version
    const summary: RunSummary = {
      runId,
      flowId: doc.id,
      flowName: doc.name,
      version,
      trigger: request.caller === undefined ? { kind: 'canvas' } : { kind: 'tool', sessionId: request.caller.agent.session.id, callId: request.caller.callId },
      status: 'running',
      inputs,
      startedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
      nodeExecutions: 0,
      workspacePath,
    }
    const live = this.createLive(summary, workspacePath, doc.name)
    if (request.caller !== undefined) live.agentManager.caller = request.caller
    const interaction = request.caller === undefined ? this.canvasInteraction(live) : new SessionInteraction(this.ctx, request.caller.agent)
    live.done = this.execute(live, plan, inputs, workspacePath, interaction, doc, version)
    return { runId }
  }

  /** Whether a run exists (live or persisted). */
  hasRun(runId: string): boolean {
    return ID_PATTERN.test(runId) && (this.live.has(runId) || this.runStore.get(runId) !== undefined)
  }

  /** Cancel a live run. */
  async cancel(runId: string): Promise<boolean> {
    const live = this.live.get(runId)
    if (live === undefined) return false
    live.controller.abort(new RunAbort('user'))
    return true
  }

  /** Cancel every live run of a flow (used before deleting it). */
  async cancelFlow(flowId: string): Promise<void> {
    const runs = [...this.live.values()].filter(run => run.flowId === flowId)
    for (const run of runs) run.controller.abort(new RunAbort('user'))
    await Promise.all(runs.map(run => run.done.catch(() => undefined)))
  }

  /**
   * Answer a waiting question.
   * @returns `'ok'`, `'not-waiting'` when no question waits at `execKey`, or `'invalid'` when the answer does not fit the question.
   */
  async answer(runId: string, execKey: string, answer: { text?: string; optionId?: string }): Promise<'ok' | 'not-waiting' | 'invalid'> {
    const interaction = this.interactions.get(runId)
    const fits = interaction?.accepts(execKey, answer)
    if (interaction === undefined || fits === undefined) return 'not-waiting'
    if (!fits) return 'invalid'
    return interaction.answer(execKey, answer) ? 'ok' : 'not-waiting'
  }

  /** The cooperative timeout budget used when a flow is exposed as a tool. */
  timeoutMs(): number {
    return this.config.maxRunDurationMs
  }

  /** Wait for a run to finish (success, failure, or cancel), then return its final summary. */
  async awaitRun(runId: string): Promise<RunSummary | undefined> {
    const live = this.live.get(runId)
    if (live !== undefined) return await live.done
    return ID_PATTERN.test(runId) ? this.runStore.get(runId) : undefined
  }

  /**
   * Stream a run's events as NDJSON: persisted events after `after`, then live
   * events, closing after `run.finished`. Only `node.delta` events are ever
   * coalesced under backpressure; no other event is dropped.
   */
  eventsStream(runId: string, after: number, signal: AbortSignal): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let teardown = (): void => {}
    let onPull = (): void => {}
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false
        let lastSeq = after
        let pendingDelta: Extract<RunEvent, { type: 'node.delta' }> | undefined
        let buffered: RunEvent[] | undefined = []
        const enqueue = (value: unknown): void => {
          if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
        }
        const flushDelta = (): void => {
          if (pendingDelta === undefined) return
          const delta = pendingDelta
          pendingDelta = undefined
          enqueue(delta)
        }
        const close = (): void => {
          if (closed) return
          flushDelta()
          closed = true
          teardown()
          controller.close()
        }
        onPull = flushDelta
        const write = (event: RunEvent): void => {
          if (closed || event.seq <= lastSeq) return
          lastSeq = event.seq
          if (event.type === 'node.delta' && (controller.desiredSize ?? 1) <= 0) {
            if (pendingDelta !== undefined && pendingDelta.execKey === event.execKey) {
              pendingDelta = { ...pendingDelta, seq: event.seq, text: pendingDelta.text + event.text }
              return
            }
            flushDelta()
            pendingDelta = event
            return
          }
          flushDelta()
          enqueue(event)
          if (event.type === 'run.finished') close()
        }
        const unsubscribe = this.eventHub.subscribe(runId, (event) => {
          if (buffered !== undefined) buffered.push(event)
          else write(event)
        })
        const unclose = this.eventHub.onClose(runId, close)
        const ping = setInterval(() => { flushDelta(); enqueue({ type: 'ping' }) }, RUN_EVENTS_PING_MS)
        const onAbort = (): void => { close() }
        teardown = () => {
          unsubscribe()
          unclose()
          clearInterval(ping)
          signal.removeEventListener('abort', onAbort)
        }
        signal.addEventListener('abort', onAbort, { once: true })

        for (const event of this.runStore.readEvents(runId)) write(event)
        const live = buffered
        buffered = undefined
        for (const event of live.sort((a, b) => a.seq - b.seq)) write(event)
        if (!closed) enqueue({ type: 'ping' })
        // A finished run has nothing more to send once its persisted events are replayed.
        if (!this.live.has(runId)) close()
      },
      pull: () => { onPull() },
      cancel: () => { teardown() },
    })
  }

  /**
   * Run a single node with literal inputs (debug). Only the target node is
   * validated; its inputs are the request's literals coerced by binding schema.
   */
  async debug(flow: FlowDocument, nodeId: string, rawInputs: JsonValue, workspaceId: string): Promise<{ runId: string }> {
    const node = flow.nodes.find(n => n.id === nodeId)
    if (node === undefined) throw new RunStartError('NODE_NOT_FOUND', `node ${nodeId} not found`, 404)
    const executor = this.executors[node.type]
    if (executor === undefined || NON_DEBUGGABLE.has(node.type)) throw new RunStartError('DEBUG_UNSUPPORTED', `${node.type} nodes cannot be run on their own`)
    const issues = validateSingleNode(flow, node, this.flowStore.lookup).filter(issue => issue.severity === 'error')
    if (issues.length > 0) throw new FlowValidationError(issues)
    this.checkServiceAvailability({ ...flow, nodes: [node] }, false)
    const workspacePath = this.resolveWorkspace(workspaceId, undefined)
    const inputs = coerceDebugInputs(node, rawInputs)

    // A one-node synthetic plan runs through the same scheduler path: retries, timeouts, signals, and recording.
    const debugNode: FlowNode = { ...withLiteralInputs(node, inputs), parentId: undefined }
    const debugDoc: FlowDocument = { ...flow, nodes: [debugNode], edges: [] }
    const plan: ExecutionPlan = {
      doc: debugDoc,
      scopes: new Map([['root', { scope: 'root', nodes: [debugNode], inEdges: new Map([[node.id, []]]), outEdges: new Map([[node.id, []]]), entry: [node.id], order: [node.id] }]]),
    }
    const runId = `run-${randomUUID().slice(0, 12)}`
    const summary: RunSummary = {
      runId,
      flowId: flow.id,
      flowName: flow.name,
      version: 'draft',
      trigger: { kind: 'debug', nodeId },
      status: 'running',
      inputs,
      startedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
      nodeExecutions: 0,
      workspacePath,
    }
    const live = this.createLive(summary, workspacePath, flow.name)
    const interaction = this.canvasInteraction(live)
    live.done = (async () => {
      live.emitter.emit({ seq: live.emitter.seq++, time: Date.now(), type: 'run.started', runId, flowId: flow.id, version: 'draft', inputs })
      const ctx = this.buildRunContext(live, workspacePath, interaction, plan)
      let result: RunResult
      try {
        const frame = createFrame('root', [], plan, undefined, ctx.signal)
        const scope = plan.scopes.get('root')
        if (scope === undefined) throw new Error('debug plan has no root scope')
        const outcome = await runScopeFrame(scope, frame, ctx, [flow.id])
        const status = frame.status.get(node.id)
        const aborted = classifyRunAbort(ctx.signal)
        if (aborted !== undefined) result = { status: aborted.status, ...(aborted.error === undefined ? {} : { error: aborted.error }), usage: live.budget.usage() }
        else if (status === 'succeeded') result = { status: 'succeeded', outputs: frame.outputs.get(node.id) ?? {}, usage: live.budget.usage() }
        else result = { status: 'failed', error: outcome.error ?? { code: 'NODE_FAILED', message: `node ended ${status ?? 'unknown'}`, nodeId }, usage: live.budget.usage() }
      } catch (error: unknown) {
        result = { status: 'failed', error: toRunError(error), usage: live.budget.usage() }
      }
      return await this.finalize(live, result)
    })()
    return { runId }
  }

  /** Dispose all live runs (plugin unload). */
  async dispose(): Promise<void> {
    const runs = [...this.live.values()]
    for (const run of runs) run.controller.abort(new RunAbort('dispose'))
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(runs.map(run => run.done.catch(() => undefined))),
      new Promise<void>(resolve => { timer = setTimeout(resolve, DISPOSE_WAIT_MS) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (this.live.size > 0) this.ctx.logger.warn(`flow: ${this.live.size} run(s) did not finalize within ${DISPOSE_WAIT_MS}ms of teardown`)
    for (const interaction of this.interactions.values()) interaction.dispose()
    this.interactions.clear()
    for (const runId of this.live.keys()) this.eventHub.close(runId)
  }

  private createLive(summary: RunSummary, workspacePath: string, flowName: string): LiveRun {
    this.runStore.start(summary)
    const controller = new AbortController()
    const budget = new RunBudget({
      maxNodeExecutions: this.config.maxNodeExecutionsPerRun,
      maxLlmCalls: this.config.maxLlmCallsPerRun,
      maxAgentNodes: this.config.maxAgentNodesPerRun,
      maxRunDurationMs: this.config.maxRunDurationMs,
    })
    const agentManager = new RunAgentManager(this.ctx, {
      ...(this.config.runAgentPreset === undefined ? {} : { agentPreset: this.config.runAgentPreset }),
      ...(this.config.runPermissionPreset === undefined ? {} : { permissionPreset: this.config.runPermissionPreset }),
      archiveRunSessions: this.config.archiveRunSessions,
      workspacePath,
      title: `[Flow] ${flowName}`,
    }, summary.runId, controller.signal)
    agentManager.onSessionCreated = (sessionId) => { this.patchSummary(summary.runId, current => ({ ...current, sessionId })) }
    const live: LiveRun = {
      runId: summary.runId,
      flowId: summary.flowId,
      controller,
      agentManager,
      budget,
      emitter: this.buildEmitter(summary),
      done: Promise.resolve(summary),
      timer: setTimeout(() => { controller.abort(new RunAbort('timeout')) }, this.config.maxRunDurationMs),
    }
    live.timer?.unref?.()
    this.live.set(summary.runId, live)
    return live
  }

  private canvasInteraction(live: LiveRun): CanvasInteraction {
    const interaction = new CanvasInteraction(live.emitter, (waiting) => {
      this.patchSummary(live.runId, current => current.status === 'running' || current.status === 'waiting' ? { ...current, status: waiting ? 'waiting' : 'running' } : current)
    })
    this.interactions.set(live.runId, interaction)
    return interaction
  }

  private patchSummary(runId: string, patch: (current: RunSummary) => RunSummary): void {
    try {
      const current = this.runStore.get(runId)
      if (current !== undefined) this.runStore.update(patch(current))
    } catch (error: unknown) {
      this.ctx.logger.warn(`flow: run summary update failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private buildEmitter(summary: RunSummary): RunEmitter {
    const recordChars = this.config.recordValueChars
    return {
      // Seq starts at 1 so a client resuming with `after=0` receives every event.
      seq: 1,
      emit: (event) => {
        const recorded = recordEvent(event, recordChars)
        if (recorded.type !== 'node.delta') {
          try {
            this.runStore.appendEvent(summary, recorded)
          } catch (error: unknown) {
            this.ctx.logger.warn(`flow: event persistence failed for ${summary.runId}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        this.eventHub.emit(summary.runId, recorded)
      },
    }
  }

  private async execute(live: LiveRun, plan: ExecutionPlan, inputs: Record<string, JsonValue>, workspacePath: string, interaction: Interaction, doc: FlowDocument, version: number | 'draft'): Promise<RunSummary> {
    let result: RunResult
    try {
      live.emitter.emit({ seq: live.emitter.seq++, time: Date.now(), type: 'run.started', runId: live.runId, flowId: doc.id, version, inputs })
      const ctx = this.buildRunContext(live, workspacePath, interaction, plan)
      result = await runFlow(plan, inputs, ctx, [], [doc.id])
    } catch (error: unknown) {
      const aborted = classifyRunAbort(live.controller.signal)
      result = { status: aborted?.status ?? 'failed', error: aborted?.error ?? toRunError(error), usage: live.budget.usage() }
    }
    return await this.finalize(live, result)
  }

  /** The single exit of every run: exactly one `run.finished`, then cleanup; no step can skip a later one. */
  private async finalize(live: LiveRun, result: RunResult): Promise<RunSummary> {
    if (live.timer !== undefined) clearTimeout(live.timer)
    const aborted = classifyRunAbort(live.controller.signal)
    const status = result.status === 'succeeded' ? 'succeeded' : aborted?.status ?? result.status
    const error = status === 'succeeded' ? undefined : aborted?.error ?? result.error
    const usage = live.budget.usage()
    const durationMs = live.budget.durationMs()
    const base = this.safeGet(live.runId)
    const finalSummary: RunSummary = {
      ...(base ?? { runId: live.runId, flowId: live.flowId, flowName: live.flowId, version: 'draft', trigger: { kind: 'canvas' }, inputs: null, startedAt: live.budget.startedAt }),
      status,
      ...(result.outputs === undefined || status !== 'succeeded' ? {} : { outputs: result.outputs }),
      ...(error === undefined ? {} : { error }),
      finishedAt: Date.now(),
      usage,
      nodeExecutions: live.budget.nodeExecutions,
      ...(live.agentManager.sessionId() === undefined ? {} : { sessionId: live.agentManager.sessionId() }),
      ...(this.runStore.wasTruncated(live.runId) ? { eventsTruncated: true } : {}),
    }
    const steps: [string, () => unknown][] = [
      ['emit run.finished', () => live.emitter.emit({
        seq: live.emitter.seq++,
        time: Date.now(),
        type: 'run.finished',
        status,
        ...(finalSummary.outputs === undefined ? {} : { outputs: finalSummary.outputs }),
        ...(error === undefined ? {} : { error }),
        usage,
        durationMs,
      })],
      ['update summary', () => { this.runStore.update(finalSummary) }],
      ['dispose run session', () => live.agentManager.dispose()],
      ['dispose interaction', () => { this.interactions.get(live.runId)?.dispose(); this.interactions.delete(live.runId) }],
      ['prune runs', () => { this.runStore.prune(live.flowId) }],
    ]
    for (const [label, step] of steps) {
      try {
        await step()
      } catch (stepError: unknown) {
        this.ctx.logger.warn(`flow: finalize step "${label}" failed for ${live.runId}: ${stepError instanceof Error ? stepError.message : String(stepError)}`)
      }
    }
    this.live.delete(live.runId)
    this.eventHub.close(live.runId)
    return finalSummary
  }

  private safeGet(runId: string): RunSummary | undefined {
    try {
      return this.runStore.get(runId)
    } catch {
      // An unreadable summary is rebuilt from the live run below.
      return undefined
    }
  }

  private buildRunContext(live: LiveRun, workspacePath: string, interaction: Interaction, plan: ExecutionPlan): RunContext {
    const subflowPlans = new Map<string, ExecutionPlan>()
    let callCounter = 0
    const ctx: RunContext = {
      runId: live.runId,
      workspacePath,
      budget: live.budget,
      semaphore: new Semaphore(this.config.maxConcurrentNodes),
      services: this.buildServices(),
      interaction,
      agent: () => live.agentManager.binding(),
      emitter: live.emitter,
      executors: this.executors,
      plan,
      limits: this.config,
      signal: live.controller.signal,
      abortRun: (reason) => { if (!live.controller.signal.aborted) live.controller.abort(reason) },
      runSubflow: async (nodeId, flowId, version, inputs, basePath, flowStack, signal) => {
        if (flowStack.includes(flowId)) throw new NodeError('SUBFLOW_RECURSION', `subflow ${flowId} is already on the call chain`)
        if (flowStack.length > this.config.maxNestingDepth) throw new NodeError('SUBFLOW_DEPTH', `subflow nesting exceeds ${this.config.maxNestingDepth}`)
        const subDoc = this.resolveFlow(flowId, version)
        if (subDoc === undefined) throw new NodeError('SUBFLOW_MISSING', `subflow ${flowId} (${String(version)}) not found`)
        // Cached per run only: a draft or republished subflow must be re-read by the next run.
        const key = `${flowId}@${String(version)}`
        let subPlan = subflowPlans.get(key)
        if (subPlan === undefined) {
          try {
            subPlan = compile(subDoc, this.flowStore.lookup, this.validateLimits())
          } catch (error: unknown) {
            if (error instanceof FlowValidationError) throw new NodeError('SUBFLOW_INVALID', `subflow ${flowId} is invalid: ${error.message}`)
            throw error
          }
          subflowPlans.set(key, subPlan)
        }
        const subInputs = coerceFieldsOrThrow(startFields(subDoc), inputs, 'INPUT_TYPE')
        const sub = await runFlow(subPlan, subInputs, ctx, [...basePath, { node: nodeId }], [...flowStack, subDoc.id], signal)
        if (sub.status === 'succeeded') return sub.outputs ?? {}
        signal.throwIfAborted()
        throw new NodeError(sub.error?.code ?? 'SUBFLOW_FAILED', `subflow ${flowId}: ${sub.error?.message ?? 'failed'}`)
      },
      runContainer: (containerId, inner, index, parentFrame, flowStack, signal) => {
        const path: FrameStep[] = [...parentFrame.path, { node: containerId, index }]
        return runContainerFrame(parentFrame.plan, containerId, inner, path, parentFrame, ctx, flowStack, signal)
      },
      nextCallId: () => `flow-${live.runId}-${++callCounter}`,
    }
    return ctx
  }

  private buildServices(): FlowServices {
    const ctx = this.ctx
    return {
      llm: { stream: (options) => ctx.llm.stream(options) },
      tools: {
        execute: async (input) => {
          const result = await ctx.tools.execute({
            callId: brandString<ToolCallId>(input.callId),
            name: input.name,
            arguments: input.arguments,
            ...(input.agent === undefined ? {} : { agent: input.agent }),
            ...(input.parent === undefined ? {} : { parent: input.parent }),
            ...(input.rootCallId === undefined ? {} : { rootCallId: input.rootCallId }),
            signal: input.signal,
          })
          return {
            isError: result.isError,
            value: result.isError ? null : result.value,
            content: result.content as { type: string; text?: string }[],
            ...(result.isError ? { error: { message: result.error.message } } : {}),
          }
        },
      },
      ptc: ctx.get('ptcRuntime'),
      subagents: ctx.get('subagents'),
      fetch: createGuardedFetch({
        timeoutMs: this.config.http.timeoutMs,
        maxResponseBytes: this.config.http.maxResponseBytes,
        maxRedirects: this.config.http.maxRedirects,
        allowPrivateNetwork: this.config.http.allowPrivateNetwork,
        allowedHosts: this.config.http.allowedHosts,
      }),
      defaultModel: () => {
        const selection = ctx.agentDefaultModel.currentSelection()
        return { provider: selection.provider, model: selection.model }
      },
      defaultProvider: this.config.agent.provider,
      maxRegexInputChars: this.config.maxRegexInputChars,
      sandboxPolicy: { resolve: (request) => ctx.sandboxPolicy.resolve({ mode: request.mode }) },
    }
  }

  private resolveFlow(flowId: string, version: number | 'draft' | 'published'): FlowDocument | undefined {
    if (!ID_PATTERN.test(flowId)) return undefined
    if (version === 'draft') return this.flowStore.get(flowId)
    if (version === 'published') {
      const v = this.flowStore.latestPublishedVersion(flowId)
      return v === undefined ? undefined : this.flowStore.version(flowId, v)
    }
    return this.flowStore.version(flowId, version)
  }

  private validateLimits(): ReturnType<typeof validateLimitsOf> {
    // Scoped (preset/agent) tools are absent from the global schema list, so an unknown tool stays a warning.
    return { ...validateLimitsOf(this.config), toolNames: new Set(knownToolSchemas(this.ctx).map(tool => tool.name)), strictTools: false }
  }

  private resolveWorkspace(workspaceId: string | undefined, workspacePath: string | undefined): string {
    if (workspaceId !== undefined) {
      const workspace = this.ctx.workspaceRegistry.get(brandString<WorkspaceId>(workspaceId))
      if (workspace === undefined) throw new RunStartError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`)
      return workspace.path
    }
    if (workspacePath !== undefined) return workspacePath
    throw new RunStartError('WORKSPACE_NOT_FOUND', 'a workspace is required: pass workspaceId, or call the flow tool from a session with a working directory')
  }

  private checkServiceAvailability(doc: FlowDocument, sessionQuestions: boolean): void {
    const issues: Issue[] = []
    const missing = (node: FlowNode, service: string): void => {
      issues.push({ severity: 'error', code: 'SERVICE_UNAVAILABLE', message: `${node.type} node requires the ${service} service`, nodeId: node.id })
    }
    for (const node of doc.nodes) {
      if (node.type === 'code' && this.ctx.get('ptcRuntime') === undefined) missing(node, 'ptcRuntime')
      if (node.type === 'agent' && this.ctx.get('subagents') === undefined) missing(node, 'subagents')
      if (node.type === 'question' && sessionQuestions && this.ctx.get('userQuestions') === undefined) missing(node, 'userQuestions')
    }
    if (issues.length > 0) throw new FlowValidationError(issues)
  }
}

/** Node types that only make sense inside a whole flow. */
const NON_DEBUGGABLE = new Set<FlowNode['type']>(['start', 'end', 'comment', 'break', 'continue', 'assign', 'loop', 'batch', 'subflow'])

/** Validate one node in isolation: its own rules and template variables, not the graph around it. */
function validateSingleNode(flow: FlowDocument, node: FlowNode, lookup: FlowLookup): Issue[] {
  const issues = specOf(node).validate(node, { doc: flow, lookup })
  const names = new Set(iterBindings(node).map(binding => binding.name))
  for (const { template, field } of iterTemplates(node)) {
    for (const variable of templateVariables(template)) {
      if (!names.has(variable)) issues.push({ severity: 'error', code: 'TEMPLATE_UNKNOWN_VAR', message: `template variable "{{${variable}}}" is not an input`, nodeId: node.id, field })
    }
  }
  return issues
}

/** Replace a debug node's binding sources with the request's literal values so resolution never looks outside the node. */
function withLiteralInputs(node: FlowNode, inputs: Record<string, JsonValue>): FlowNode {
  const literal = (binding: InputBinding): InputBinding => ({ ...binding, value: { kind: 'literal', value: inputs[binding.name] ?? null } })
  switch (node.type) {
    case 'tool': return { ...node, data: { ...node.data, args: node.data.args.map(literal) } }
    case 'text': return node.data.op === 'concat' ? { ...node, data: { ...node.data, inputs: node.data.inputs.map(literal) } } : node
    case 'llm': return { ...node, data: { ...node.data, inputs: node.data.inputs.map(literal) } }
    case 'intent': return { ...node, data: { ...node.data, inputs: node.data.inputs.map(literal) } }
    case 'agent': return { ...node, data: { ...node.data, inputs: node.data.inputs.map(literal) } }
    case 'code': return { ...node, data: { ...node.data, inputs: node.data.inputs.map(literal) } }
    case 'http': return { ...node, data: { ...node.data, inputs: node.data.inputs.map(literal) } }
    case 'question': return { ...node, data: { ...node.data, inputs: node.data.inputs.map(literal) } }
    case 'message': return { ...node, data: { ...node.data, inputs: node.data.inputs.map(literal) } }
    default: return node
  }
}

/** Coerce debug inputs by the node's binding schemas. */
function coerceDebugInputs(node: FlowNode, raw: JsonValue): Record<string, JsonValue> {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out: Record<string, JsonValue> = {}
  for (const binding of iterBindings(node)) {
    const value = source[binding.name]
    if (value === undefined || value === null) {
      if (binding.required ?? true) throw new InputValidationError(`inputs.${binding.name}`, 'INPUT_INVALID', `required input "${binding.name}" is missing`)
      out[binding.name] = null
      continue
    }
    const coerced = coerce(value, binding.schema)
    if (!coerced.ok) throw new InputValidationError(`inputs.${binding.name}`, 'INPUT_INVALID', coerced.reason)
    out[binding.name] = coerced.value
  }
  return out
}

/** Record-process an event before persistence and push: redact and truncate recorded values. */
function recordEvent(event: RunEvent, maxChars: number): RunEvent {
  if (event.type === 'run.started') return { ...event, inputs: recordValue(event.inputs, maxChars) }
  if (event.type === 'node.started') return { ...event, inputs: recordValue(event.inputs, maxChars) }
  if (event.type === 'node.finished') {
    return {
      ...event,
      ...(event.outputs === undefined ? {} : { outputs: recordValue(event.outputs, maxChars) }),
      ...(event.rendered === undefined ? {} : { rendered: recordRendered(event.rendered, maxChars) }),
    }
  }
  if (event.type === 'run.finished' && event.outputs !== undefined) return { ...event, outputs: recordValue(event.outputs, maxChars) }
  return event
}

function recordRendered(rendered: { system?: string; prompt?: string }, maxChars: number): { system?: string; prompt?: string } {
  const cut = (text: string): string => text.length <= maxChars ? text : `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`
  return {
    ...(rendered.system === undefined ? {} : { system: cut(rendered.system) }),
    ...(rendered.prompt === undefined ? {} : { prompt: cut(rendered.prompt) }),
  }
}

function startFields(doc: FlowDocument): (VarField & { default?: JsonValue })[] {
  const start = doc.nodes.find(node => node.type === 'start')
  return start?.type === 'start' ? start.data.fields : []
}

/** Coerce values against start fields, applying defaults; optional fields without a value become null. */
function coerceFieldsOrThrow(fields: readonly (VarField & { default?: JsonValue })[], raw: JsonValue, code: 'INPUT_TYPE' | 'INPUT_INVALID'): Record<string, JsonValue> {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out: Record<string, JsonValue> = {}
  const fail = (field: string, message: string): never => {
    if (code === 'INPUT_INVALID') throw new InputValidationError(`inputs.${field}`, code, message)
    throw new NodeError(code, message)
  }
  for (const field of fields) {
    const value = source[field.name]
    if (value === undefined || value === null) {
      if (field.default !== undefined) out[field.name] = field.default
      else if (field.required === true) fail(field.name, `required input "${field.name}" is missing`)
      else out[field.name] = null
      continue
    }
    const coerced = coerce(value, field.schema)
    if (!coerced.ok) fail(field.name, `input "${field.name}": ${coerced.reason}`)
    else out[field.name] = coerced.value
  }
  return out
}

/** Validate and coerce the run's start inputs, applying defaults. */
function validateStartInputs(doc: FlowDocument, raw: JsonValue, maxValueBytes: number): Record<string, JsonValue> {
  const inputs = coerceFieldsOrThrow(startFields(doc), raw, 'INPUT_INVALID')
  const bytes = Buffer.byteLength(JSON.stringify(inputs))
  if (bytes > maxValueBytes) throw new InputValidationError('inputs', 'VALUE_TOO_LARGE', `run inputs are ${bytes} bytes, above the ${maxValueBytes}-byte limit`)
  return inputs
}

/** Convert an unknown error into a run error record. */
function toRunError(error: unknown): { code: string; message: string; nodeId?: string } {
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return { code: (error as { code: string }).code, message: error.message }
  }
  return { code: 'RUN_ERROR', message: error instanceof Error ? error.message : String(error) }
}
