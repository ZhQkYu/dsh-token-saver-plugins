/**
 * FlowEngine: the run orchestrator. Implements the {@link RunController} the
 * run routes delegate to. Compiles a flow, runs it through the scheduler with
 * the executor set, emits/persists events, and supports cancel/answer/debug.
 *
 * @module @dsh-plugins/flow/host/engine/engine
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'
import { randomUUID } from 'node:crypto'
import type { FlowDocument, JsonValue, RunStatus, RunSummary, TokenUsageLite } from '../../spec/types.ts'
import { ID_PATTERN } from '../../spec/types.ts'
import { compile, FlowValidationError } from './compile.ts'
import { runContainerFrame, runRootFrame, Semaphore, type RunContext, type RunEmitter } from './scheduler.ts'
import { createFrame, type Frame } from './frames.ts'
import { RunBudget } from './budget.ts'
import { EventHub } from './events.ts'
import { buildExecutors } from '../executors/registry.ts'
import type { FlowServices, Interaction } from '../executors/index.ts'
import type { FlowStore } from '../store/flow-store.ts'
import type { RunStore } from '../store/run-store.ts'
import { RunAgentManager } from '../services/run-agent.ts'
import { createGuardedFetch } from '../services/guarded-fetch.ts'

/** Engine configuration drawn from the plugin config. */
export interface EngineConfig {
  workspacePath: string
  runAgentPreset?: string
  runPermissionPreset?: string
  archiveRunSessions: boolean
  maxConcurrentNodes: number
  maxNodeExecutionsPerRun: number
  maxLlmCallsPerRun: number
  maxAgentNodesPerRun: number
  maxRunDurationMs: number
  maxNodeTimeoutMs: number
  maxNestingDepth: number
  maxRegexInputChars: number
  http: { timeoutMs: number; maxResponseBytes: number; allowPrivateNetwork: boolean; allowedHosts: string[] }
  code: { timeoutMs: number; sandboxMode: string }
  agent: { provider: string }
  maxValueBytes: number
}

/** A canvas interaction: emit `run.waiting` and resolve on `run.answer`. */
class CanvasInteraction implements Interaction {
  private readonly waiting = new Map<string, { resolve: (value: { text?: string; optionId?: string }) => void; reject: (reason: unknown) => void }>()

  constructor(private readonly emitter: RunEmitter) {}

  async ask(execKey: string, question: string, answerSpec: unknown, signal: AbortSignal): Promise<{ text?: string; optionId?: string }> {
    this.emitter.emit({ seq: this.emitter.seq++, time: Date.now(), type: 'run.waiting', execKey, question, answer: answerSpec as never })
    return await new Promise<{ text?: string; optionId?: string }>((resolve, reject) => {
      this.waiting.set(execKey, { resolve, reject })
      signal.addEventListener('abort', () => {
        const entry = this.waiting.get(execKey)
        if (entry !== undefined) {
          entry.reject(new Error('run cancelled while waiting for answer'))
          this.waiting.delete(execKey)
        }
      }, { once: true })
    })
  }

  answer(execKey: string, answer: { text?: string; optionId?: string }): boolean {
    const entry = this.waiting.get(execKey)
    if (entry === undefined) return false
    entry.resolve(answer)
    this.waiting.delete(execKey)
    this.emitter.emit({ seq: this.emitter.seq++, time: Date.now(), type: 'run.resumed', execKey })
    return true
  }
}

/** A session interaction that routes questions through `ctx.userQuestions`. */
class SessionInteraction implements Interaction {
  constructor(private readonly ctx: Context, private readonly agent: Agent) {}

  async ask(_execKey: string, question: string, answerSpec: unknown, signal: AbortSignal): Promise<{ text?: string; optionId?: string }> {
    const spec = answerSpec as { kind: 'text' } | { kind: 'options'; options: { id: string; label: string }[]; allowOther: boolean }
    const id = `flow-q-${Date.now().toString(36)}`
    const item = spec.kind === 'options'
      ? { id, question, options: spec.options.map(option => ({ label: option.label })) }
      : { id, question }
    const result = await this.ctx.userQuestions.ask({ questions: [item], agent: this.agent, signal })
    const answer = result.answers[0]
    if (answer === undefined) return {}
    const label = answer.selected[0]
    const optionId = spec.kind === 'options' ? (spec.options.find(option => option.label === label)?.id ?? (spec.allowOther ? 'other' : undefined)) : undefined
    return { text: answer.custom ?? label, ...(optionId === undefined ? {} : { optionId }) }
  }
}

/** A live run, tracking its abort controller and agent manager. */
interface LiveRun {
  controller: AbortController
  agentManager: RunAgentManager
  runId: string
}

/** The flow engine. */
export class FlowEngine {
  private readonly eventHub = new EventHub()
  private readonly live = new Map<string, LiveRun>()
  private readonly executors = buildExecutors()

  constructor(
    private readonly ctx: Context,
    private readonly flowStore: FlowStore,
    private readonly runStore: RunStore,
    private readonly config: EngineConfig,
  ) {}

  /** Start a run of a flow. */
  async start(request: { flowId: string; version: number | 'draft' | 'published'; inputs: JsonValue; workspaceId?: string; caller?: { agent: Agent; parent: unknown; rootCallId: unknown } }): Promise<{ runId: string }> {
    const doc = this.resolveFlow(request.flowId, request.version)
    if (doc === undefined) throw new Error('flow not found')
    const runId = `run-${randomUUID().slice(0, 12)}`
    const workspacePath = this.config.workspacePath
    const controller = new AbortController()
    const agentManager = new RunAgentManager(this.ctx, {
      agentPreset: this.config.runAgentPreset,
      permissionPreset: this.config.runPermissionPreset,
      archiveRunSessions: this.config.archiveRunSessions,
      workspacePath,
    }, runId)
    if (request.caller !== undefined) {
      agentManager.caller = request.caller
    }
    this.live.set(runId, { controller, agentManager, runId })

    const budget = new RunBudget({
      maxNodeExecutions: this.config.maxNodeExecutionsPerRun,
      maxLlmCalls: this.config.maxLlmCallsPerRun,
      maxAgentNodes: this.config.maxAgentNodesPerRun,
      maxRunDurationMs: this.config.maxRunDurationMs,
    })

    const summary: RunSummary = {
      runId,
      flowId: doc.id,
      flowName: doc.name,
      version: request.version === 'published' ? (this.flowStore.latestPublishedVersion(doc.id) ?? 'draft') : request.version,
      trigger: request.caller === undefined ? { kind: 'canvas' } : { kind: 'tool', sessionId: request.caller.agent.session.id, callId: String(request.caller.rootCallId ?? '') },
      status: 'running',
      inputs: request.inputs,
      startedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
      nodeExecutions: 0,
    }
    this.runStore.start(summary)

    const emitter: RunEmitter = {
      seq: 0,
      emit: (event) => {
        if (event.type !== 'node.delta') {
          this.runStore.appendEvent(summary, event)
        }
        this.eventHub.emit(runId, event)
      },
    }
    let interaction: Interaction
    if (request.caller === undefined) {
      const canvasInteraction = new CanvasInteraction(emitter)
      this.interactions.set(runId, canvasInteraction)
      interaction = canvasInteraction
    } else {
      interaction = new SessionInteraction(this.ctx, request.caller.agent)
    }

    void (async () => {
      try {
        const plan = compile(doc, this.flowStore.lookup, this.limits())
        const runCtx = this.buildRunContext(runId, workspacePath, budget, controller.signal, emitter, interaction, agentManager, doc)
        const result = await runRootFrame(plan, doc, normalizeInputs(request.inputs), runCtx)
        const finalSummary: RunSummary = {
          ...summary,
          status: result.status,
          outputs: result.outputs,
          error: result.error,
          finishedAt: Date.now(),
          usage: result.usage,
          nodeExecutions: budget.nodeExecutions,
        }
        this.runStore.update(finalSummary)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        const failedSummary: RunSummary = {
          ...summary,
          status: 'failed',
          error: { code: error instanceof FlowValidationError ? 'FLOW_INVALID' : 'RUN_ERROR', message, nodeId: undefined },
          finishedAt: Date.now(),
          usage: budgetUsage(budget),
          nodeExecutions: budget.nodeExecutions,
        }
        this.runStore.update(failedSummary)
      } finally {
        await agentManager.dispose()
        this.live.delete(runId)
      }
    })()

    return { runId }
  }

  /** Cancel a live run. */
  async cancel(runId: string): Promise<boolean> {
    if (!ID_PATTERN.test(runId)) return false
    const live = this.live.get(runId)
    if (live === undefined) return false
    live.controller.abort()
    return true
  }

  /** Answer a waiting question. */
  async answer(runId: string, execKey: string, answer: { text?: string; optionId?: string }): Promise<boolean> {
    if (!ID_PATTERN.test(runId)) return false
    const interaction = this.interactions.get(runId)
    if (interaction === undefined) return false
    return interaction.answer(execKey, answer)
  }

  /** The cooperative timeout budget used when a flow is exposed as a tool. */
  timeoutMs(): number {
    return this.config.maxRunDurationMs
  }

  /** Wait for a run to finish (success, failure, or cancel), then return its final summary. */
  async awaitRun(runId: string): Promise<Record<string, unknown>> {
    if (!ID_PATTERN.test(runId)) throw new Error('invalid run id')
    const result = await new Promise<RunStatus | undefined>((resolve) => {
      const unsub = this.eventHub.subscribe(runId, (event) => {
        if (event.type === 'run.finished') {
          unsub()
          resolve(event.status)
        }
      })
      // If the run already finished before we subscribed, poll the store.
      void (async () => {
        const summary = this.runStore.get(runId)
        if (summary !== undefined && summary.status !== 'running' && summary.status !== 'waiting') {
          unsub()
          resolve(summary.status)
        }
      })()
    })
    const summary = this.runStore.get(runId)
    if (summary === undefined) return {}
    return { status: result, outputs: summary.outputs, error: summary.error, usage: summary.usage }
  }

  /** Stream events for a run as NDJSON. */
  eventsStream(runId: string, after: number, signal: AbortSignal): ReadableStream<Uint8Array> {
    const existing = this.runStore.readEvents(runId).filter(event => event.seq > after)
    const encoder = new TextEncoder()
    let unsubscribe: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const event of existing) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        }
        controller.enqueue(encoder.encode('{"type":"ping"}\n'))
        unsubscribe = this.eventHub.subscribe(runId, (event) => {
          if (controller.desiredSize === 0) return
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        })
      },
      cancel: () => {
        unsubscribe?.()
      },
    })
    signal.addEventListener('abort', () => { unsubscribe?.() }, { once: true })
    return stream
  }

  /** Run a single node with literal inputs (debug). */
  async debug(flow: FlowDocument, nodeId: string, inputs: JsonValue, _workspaceId?: string): Promise<{ runId: string }> {
    const node = flow.nodes.find(n => n.id === nodeId)
    if (node === undefined) throw new Error('node not found')
    const runId = `run-${randomUUID().slice(0, 12)}`
    const controller = new AbortController()
    const agentManager = new RunAgentManager(this.ctx, {
      agentPreset: this.config.runAgentPreset,
      permissionPreset: this.config.runPermissionPreset,
      archiveRunSessions: this.config.archiveRunSessions,
      workspacePath: this.config.workspacePath,
    }, runId)
    const budget = new RunBudget({
      maxNodeExecutions: 1,
      maxLlmCalls: 1,
      maxAgentNodes: 1,
      maxRunDurationMs: this.config.maxRunDurationMs,
    })
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
    }
    this.runStore.start(summary)
    const emitter: RunEmitter = { seq: 0, emit: (event) => { if (event.type !== 'node.delta') this.runStore.appendEvent(summary, event); this.eventHub.emit(runId, event) } }
    const interaction = new CanvasInteraction(emitter)
    const runCtx = this.buildRunContext(runId, this.config.workspacePath, budget, controller.signal, emitter, interaction, agentManager, flow)
    const frame = createFrame('root', [], undefined)
    const execKey = `${nodeId}`
    const executor = this.executors[node.type]
    if (executor === undefined) throw new Error(`no executor for ${node.type}`)
    frame.status.set(nodeId, 'running')
    emitter.emit({ seq: emitter.seq++, time: Date.now(), type: 'node.started', execKey, nodeId, path: [], attempt: 0, inputs: (inputs as Record<string, JsonValue>) })
    let outputs: Record<string, JsonValue> = {}
    let status: RunStatus = 'succeeded'
    let error: { code: string; message: string; nodeId?: string } | undefined
    try {
      const execCtx = this.buildExecContext(runCtx, frame, execKey)
      const result = await executor.execute(node, (inputs as Record<string, JsonValue>), execCtx)
      outputs = result.outputs
    } catch (caught: unknown) {
      status = 'failed'
      error = { code: 'NODE_ERROR', message: caught instanceof Error ? caught.message : String(caught), nodeId }
    }
    emitter.emit({ seq: emitter.seq++, time: Date.now(), type: 'node.finished', execKey, nodeId, path: [], attempt: 0, status: status === 'succeeded' ? 'succeeded' : 'failed', outputs })
    emitter.emit({ seq: emitter.seq++, time: Date.now(), type: 'run.finished', status: status === 'succeeded' ? 'succeeded' : 'failed', outputs, error, usage: budgetUsage(budget), durationMs: budget.durationMs() })
    this.runStore.update({ ...summary, status, outputs, error, finishedAt: Date.now(), usage: budgetUsage(budget), nodeExecutions: 1 })
    await agentManager.dispose()
    return { runId }
  }

  private readonly interactions = new Map<string, CanvasInteraction>()

  private buildRunContext(runId: string, workspacePath: string, budget: RunBudget, signal: AbortSignal, emitter: RunEmitter, interaction: Interaction, agentManager: RunAgentManager, doc: FlowDocument): RunContext {
    const services: FlowServices = this.buildServices(signal)
    const executors = this.executors
    const plan = compile(doc, this.flowStore.lookup, this.limits())
    const ctx: RunContext = {
      runId,
      workspacePath,
      budget,
      semaphore: new Semaphore(this.config.maxConcurrentNodes),
      services,
      interaction,
      agent: () => agentManager.binding(),
      emitter,
      executors,
      plan,
      signal,
      runSubflow: async (flowId, version, inputs) => {
        const subDoc = this.resolveFlow(flowId, version)
        if (subDoc === undefined) throw new Error(`subflow ${flowId} not found`)
        const subPlan = compile(subDoc, this.flowStore.lookup, this.limits())
        const result = await runRootFrame(subPlan, subDoc, inputs, ctx)
        if (result.status !== 'succeeded') throw new Error(result.error?.message ?? 'subflow failed')
        return result.outputs ?? {}
      },
      runContainer: (containerId, inner, path, parentFrame) => runContainerFrame(plan, containerId, inner, path, parentFrame, ctx),
    }
    void doc
    return ctx
  }

  private buildServices(signal: AbortSignal): FlowServices {
    const ctx = this.ctx
    return {
      llm: { stream: (options) => ctx.llm.stream({ ...options, signal: signal }) },
      tools: {
        execute: async (input) => {
          const result = await ctx.tools.execute({
            callId: input.callId as never,
            name: input.name,
            arguments: input.arguments as never,
            ...(input.agent === undefined ? {} : { agent: input.agent as never }),
            ...(input.parent === undefined ? {} : { parent: input.parent as never }),
            ...(input.rootCallId === undefined ? {} : { rootCallId: input.rootCallId as never }),
            signal,
          })
          return {
            isError: result.isError,
            value: result.isError ? null : result.value,
            content: result.content as { type: string; text?: string }[],
            ...(result.isError ? { error: { name: result.error?.message ?? 'tool error' } } : {}),
          }
        },
      },
      ptc: ctx.get('ptcRuntime'),
      subagents: ctx.get('subagents'),
      fetch: createGuardedFetch({ timeoutMs: this.config.http.timeoutMs, maxResponseBytes: this.config.http.maxResponseBytes, allowPrivateNetwork: this.config.http.allowPrivateNetwork, allowedHosts: this.config.http.allowedHosts }),
      defaultModel: () => {
        const selection = ctx.agentDefaultModel.currentSelection()
        return { provider: selection.provider, model: selection.model }
      },
      defaultProvider: this.config.agent.provider,
      maxRegexInputChars: this.config.maxRegexInputChars,
    }
  }

  private buildExecContext(ctx: RunContext, frame: Frame, key: string): import('../executors/index.ts').ExecContext {
    return {
      signal: ctx.signal,
      runId: ctx.runId,
      execKey: key,
      frame,
      workspacePath: ctx.workspacePath,
      budget: ctx.budget,
      emitDelta: (text) => ctx.emitter.emit({ seq: ctx.emitter.seq++, time: Date.now(), type: 'node.delta', execKey: key, text }),
      emitMessage: (text) => ctx.emitter.emit({ seq: ctx.emitter.seq++, time: Date.now(), type: 'run.message', execKey: key, text }),
      agent: () => ctx.agent(),
      interaction: ctx.interaction,
      services: ctx.services,
      runScope: (container, inner) => ctx.runContainer(container.id, inner, [...frame.path, { node: container.id }], frame),
      runSubflow: (flowId, version, inputs) => ctx.runSubflow(flowId, version, inputs),
    }
  }

  private resolveFlow(flowId: string, version: number | 'draft' | 'published'): FlowDocument | undefined {
    if (version === 'draft') return this.flowStore.get(flowId)
    if (version === 'published') {
      const v = this.flowStore.latestPublishedVersion(flowId)
      return v === undefined ? undefined : this.flowStore.version(flowId, v)
    }
    return this.flowStore.version(flowId, version)
  }

  private limits() {
    return {
      maxLoopIterations: this.config.maxNodeExecutionsPerRun,
      maxBatchConcurrency: this.config.maxConcurrentNodes,
      maxBatchItems: this.config.maxNodeExecutionsPerRun,
      maxNodeTimeoutMs: this.config.maxNodeTimeoutMs,
      maxRetries: 5,
      maxNestingDepth: this.config.maxNestingDepth,
      maxRegexInputChars: this.config.maxRegexInputChars,
    }
  }
}

function normalizeInputs(inputs: JsonValue): Record<string, JsonValue> {
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) return {}
  return inputs as Record<string, JsonValue>
}

function budgetUsage(budget: RunBudget): TokenUsageLite {
  void budget
  return { inputTokens: 0, outputTokens: 0 }
}
