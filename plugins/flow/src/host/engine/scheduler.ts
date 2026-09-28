/**
 * Scheduler: runs one scope frame with dead-path elimination. Ready nodes run
 * in parallel (bounded by a shared concurrency semaphore); a node whose
 * predecessors all settle with no activated incoming edge is skipped.
 *
 * @module @dsh-plugins/flow/host/engine/scheduler
 */

import type { FlowDocument, FlowNode, FrameStep, JsonValue, RunEvent, TokenUsageLite } from '../../spec/types.ts'
import type { ScopePlan } from './compile.ts'
import { createFrame, execKey, type Frame } from './frames.ts'
import { resolveRef } from './frames.ts'
import { NodeError, type RunBudget } from './budget.ts'
import { iterBindings } from '../../spec/validate.ts'
import { coerce } from '../../spec/coerce.ts'
import type { AgentBinding, ExecContext, ExecResult, FrameResult, Interaction, NodeExecutor } from '../executors/index.ts'

/** A shared semaphore bounding concurrent node executions across a run. */
export class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++
      return this.release.bind(this)
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
    this.active++
    return this.release.bind(this)
  }

  private release(): void {
    this.active--
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }
}

/** How the scheduler reports progress. */
export interface RunEmitter {
  emit(event: RunEvent): void
  seq: number
}

/** The run-level context handed to the scheduler. */
export interface RunContext {
  runId: string
  workspacePath: string
  budget: RunBudget
  semaphore: Semaphore
  services: import('../executors/index.ts').FlowServices
  interaction: Interaction
  agent(): Promise<AgentBinding>
  emitter: RunEmitter
  executors: Record<string, NodeExecutor>
  plan: import('./compile.ts').ExecutionPlan
  runSubflow(flowId: string, version: number | 'published' | 'draft', inputs: Record<string, JsonValue>): Promise<Record<string, JsonValue>>
  runContainer(containerId: string, inner: Record<string, JsonValue>, path: FrameStep[], parentFrame: Frame): Promise<FrameResult>
  /** Abort signal for the whole run. */
  signal: AbortSignal
}

/** The result of running a frame. */
export interface FrameRunResult {
  outputs?: Record<string, JsonValue>
  completed: boolean
  /** Set when a break/continue node fired inside a container body. */
  control?: 'break' | 'continue'
  /** The fatal error that failed the frame, when a node failed with onError=fail. */
  error?: { code: string; message: string; nodeId?: string }
}

/** The result of running a whole flow. */
export interface RunResult {
  status: 'succeeded' | 'failed' | 'cancelled'
  outputs?: Record<string, JsonValue>
  error?: { code: string; message: string; nodeId?: string }
  usage: TokenUsageLite
}

/** Run a whole flow from its root frame. */
export async function runRootFrame(plan: import('./compile.ts').ExecutionPlan, doc: FlowDocument, inputs: Record<string, JsonValue>, ctx: RunContext): Promise<RunResult> {
  const rootScope = plan.scopes.get('root')
  if (rootScope === undefined) throw new Error('flow has no root scope')
  const frame = createFrame('root', [], undefined)
  ctx.emitter.emit({ seq: ctx.emitter.seq++, time: Date.now(), type: 'run.started', runId: ctx.runId, flowId: doc.id, version: 'draft', inputs })
  const start = rootScope.nodes.find(node => node.type === 'start')
  const presettled = new Set<string>()
  if (start !== undefined) {
    const coerced = coerceStartInputs(inputs, start)
    frame.outputs.set(start.id, coerced)
    frame.status.set(start.id, 'succeeded')
    frame.firedPorts.set(start.id, ['next'])
    emitNodeFinished(ctx, frame, start, coerced, ['next'], 0, undefined, undefined, undefined)
    presettled.add(start.id)
  }
  const outcome = await runScopeFrame(rootScope, frame, ctx, presettled)
  const usage = usageOf(ctx.budget)
  if (!outcome.completed) {
    const error = outcome.error ?? { code: 'END_NOT_REACHED', message: 'the end node was not reached' }
    ctx.emitter.emit({ seq: ctx.emitter.seq++, time: Date.now(), type: 'run.finished', status: 'failed', error, usage, durationMs: ctx.budget.durationMs() })
    return { status: 'failed', error, usage }
  }
  ctx.emitter.emit({ seq: ctx.emitter.seq++, time: Date.now(), type: 'run.finished', status: 'succeeded', outputs: outcome.outputs, usage, durationMs: ctx.budget.durationMs() })
  return { status: 'succeeded', outputs: outcome.outputs, usage }
}

/** Run one scope frame to completion. */
export async function runScopeFrame(scope: ScopePlan, frame: Frame, ctx: RunContext, presettled: Set<string> = new Set()): Promise<FrameRunResult> {
  const settled = new Set<string>(presettled)
  const executed = new Set<string>()

  while (true) {
    const ready: string[] = []
    for (const node of scope.nodes) {
      if (executed.has(node.id) || settled.has(node.id)) continue
      if (isSettled(node.id, scope, settled)) ready.push(node.id)
    }
    if (ready.length === 0) break

    const toExecute: string[] = []
    const toSkip: string[] = []
    for (const nodeId of ready) {
      if (scope.entry.includes(nodeId) || hasActivatedInEdge(nodeId, scope, frame)) toExecute.push(nodeId)
      else toSkip.push(nodeId)
    }

    for (const nodeId of toSkip) {
      const node = scope.nodes.find(n => n.id === nodeId)
      if (node === undefined) continue
      frame.status.set(nodeId, 'skipped')
      frame.firedPorts.set(nodeId, [])
      emitNodeFinished(ctx, frame, node, undefined, [], 0)
      settled.add(nodeId)
      executed.add(nodeId)
    }

    if (toExecute.length > 0) {
      await Promise.all(toExecute.map(nodeId => executeNode(scope, frame, nodeId, ctx)))
      for (const nodeId of toExecute) {
        settled.add(nodeId)
        executed.add(nodeId)
      }
    }

    // A fatal node error failed this frame: cancel the rest and propagate it.
    if (frame.error !== undefined) {
      for (const node of scope.nodes) {
        if (executed.has(node.id)) continue
        frame.status.set(node.id, 'cancelled')
        frame.firedPorts.set(node.id, [])
        emitNodeFinished(ctx, frame, node, undefined, [], 0)
        settled.add(node.id)
        executed.add(node.id)
      }
      break
    }

    // A break/continue fired inside this frame: stop and skip the rest.
    if (frame.control !== undefined) {
      for (const node of scope.nodes) {
        if (executed.has(node.id)) continue
        frame.status.set(node.id, 'skipped')
        frame.firedPorts.set(node.id, [])
        emitNodeFinished(ctx, frame, node, undefined, [], 0)
        settled.add(node.id)
        executed.add(node.id)
      }
      break
    }
  }

  const end = scope.nodes.find(node => node.type === 'end')
  if (end !== undefined && frame.status.get(end.id) === 'succeeded') {
    return { completed: true, outputs: frame.outputs.get(end.id) }
  }
  return {
    completed: false,
    ...(frame.control === undefined ? {} : { control: frame.control }),
    ...(frame.error === undefined ? {} : { error: frame.error }),
  }
}

async function executeNode(scope: ScopePlan, frame: Frame, nodeId: string, ctx: RunContext): Promise<void> {
  const node = scope.nodes.find(n => n.id === nodeId)
  if (node === undefined) return
  const key = execKey(frame, nodeId)
  const executor = ctx.executors[node.type]
  if (executor === undefined) {
    frame.status.set(nodeId, 'failed')
    frame.firedPorts.set(nodeId, [])
    emitNodeFinished(ctx, frame, node, undefined, [], 0, { code: 'NO_EXECUTOR', message: `no executor for ${node.type}` })
    return
  }
  const inputs = resolveInputsForNode(node, frame)
  const startedAt = Date.now()
  const policy = node.onError
  const maxRetries = policy?.retries ?? 0
  let lastError: { code: string; message: string } | undefined
  let result: ExecResult | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    ctx.budget.consumeNodeExecution()
    frame.status.set(nodeId, 'running')
    ctx.emitter.emit({ seq: ctx.emitter.seq++, time: Date.now(), type: 'node.started', execKey: key, nodeId, path: frame.path, attempt, inputs })
    try {
      const timeoutMs = policy?.timeoutMs
      const execCtx = buildExecContext(ctx, frame, key)
      const runPromise = executor.execute(node, inputs, execCtx)
      const resultPromise = withTimeout(runPromise, timeoutMs, ctx.signal)
      result = await resultPromise
      lastError = undefined
      break
    } catch (caught: unknown) {
      const nodeError = caught instanceof NodeError ? caught : new NodeError('NODE_ERROR', caught instanceof Error ? caught.message : String(caught))
      lastError = { code: nodeError.code, message: nodeError.message }
      if (!nodeError.retryable) break
    }
  }

  const durationMs = Date.now() - startedAt
  if (result !== undefined && lastError === undefined) {
    frame.outputs.set(nodeId, result.outputs)
    frame.firedPorts.set(nodeId, result.firedPorts ?? ['next'])
    frame.status.set(nodeId, 'succeeded')
    emitNodeFinished(ctx, frame, node, result.outputs, result.firedPorts ?? ['next'], maxRetries, undefined, result.usage, durationMs, result.logs, result.warnings)
    return
  }

  const error = lastError ?? { code: 'NODE_ERROR', message: 'node failed' }
  // Apply the error policy.
  if (policy?.onError === 'default') {
    const outputs = resolveDefaultOutputs(node, policy.defaultOutputs)
    frame.outputs.set(nodeId, outputs)
    frame.firedPorts.set(nodeId, ['next'])
    frame.status.set(nodeId, 'succeeded')
    emitNodeFinished(ctx, frame, node, outputs, ['next'], maxRetries, error, undefined, durationMs, undefined, [error.message])
    return
  }
  if (policy?.onError === 'branch') {
    frame.outputs.set(nodeId, { errorMessage: error.message })
    frame.firedPorts.set(nodeId, ['error'])
    frame.status.set(nodeId, 'succeeded')
    emitNodeFinished(ctx, frame, node, { errorMessage: error.message }, ['error'], maxRetries, error, undefined, durationMs, undefined, [error.message])
    return
  }
  // fail: the node fails, failing the frame.
  frame.outputs.set(nodeId, {})
  frame.firedPorts.set(nodeId, [])
  frame.status.set(nodeId, 'failed')
  frame.error = { code: error.code, message: error.message, nodeId }
  emitNodeFinished(ctx, frame, node, {}, [], maxRetries, error, undefined, durationMs, undefined, undefined)
}

function resolveDefaultOutputs(node: FlowNode, defaultOutputs: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
  if (defaultOutputs !== undefined) return defaultOutputs
  const out: Record<string, JsonValue> = {}
  void node
  return out
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, signal: AbortSignal): Promise<T> {
  if (timeoutMs === undefined) {
    return await promise
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NodeError('NODE_TIMEOUT', `node exceeded ${timeoutMs}ms`, true)), timeoutMs)
  })
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new NodeError('RUN_CANCELLED', 'run cancelled')), { once: true })
  })
  try {
    return await Promise.race([promise, timeout, aborted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function emitNodeFinished(ctx: RunContext, frame: Frame, node: FlowNode, outputs: Record<string, JsonValue> | undefined, firedPorts: string[], attempt: number, error?: { code: string; message: string }, usage?: TokenUsageLite, durationMs?: number, logs?: string[], warnings?: string[]): void {
  const key = execKey(frame, node.id)
  ctx.emitter.emit({
    seq: ctx.emitter.seq++,
    time: Date.now(),
    type: 'node.finished',
    execKey: key,
    nodeId: node.id,
    path: frame.path,
    attempt,
    status: (frame.status.get(node.id) ?? 'failed') as 'succeeded' | 'failed' | 'skipped' | 'cancelled',
    ...(outputs === undefined ? {} : { outputs }),
    ...(firedPorts.length > 0 ? { firedPorts } : {}),
    ...(error === undefined ? {} : { error }),
    ...(usage === undefined ? {} : { usage }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(logs === undefined ? {} : { logs }),
    ...(warnings === undefined ? {} : { warnings }),
  })
}

function buildExecContext(ctx: RunContext, frame: Frame, key: string): ExecContext {
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

/** Run a container body scope once, returning the body frame's node outputs. */
export async function runContainerFrame(plan: import('./compile.ts').ExecutionPlan, containerId: string, inner: Record<string, JsonValue>, path: FrameStep[], parentFrame: Frame, ctx: RunContext): Promise<import('../executors/index.ts').FrameResult> {
  const bodyScope = plan.scopes.get(containerId)
  if (bodyScope === undefined) return { nodeOutputs: new Map(), failed: false }
  const frame = createFrame(containerId, path, parentFrame, inner)
  const result = await runScopeFrame(bodyScope, frame, ctx)
  return {
    nodeOutputs: frame.outputs,
    ...(frame.control === undefined ? {} : { control: frame.control }),
    ...(frame.error === undefined ? {} : { error: frame.error }),
    failed: result.completed ? false : [...frame.status.values()].some(status => status === 'failed'),
  }
}

function resolveInputsForNode(node: FlowNode, frame: Frame): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const binding of iterBindings(node)) {
    const raw = resolveRef(frame, binding.value)
    const coerced = coerce(raw ?? null, binding.schema)
    out[binding.name] = coerced.ok ? coerced.value : null
  }
  return out
}

function isSettled(nodeId: string, scope: ScopePlan, settled: Set<string>): boolean {
  if (scope.entry.includes(nodeId)) return true
  const inEdges = scope.inEdges.get(nodeId) ?? []
  if (inEdges.length === 0) return true
  for (const edge of inEdges) {
    if (!settled.has(edge.source)) return false
  }
  return true
}

function hasActivatedInEdge(nodeId: string, scope: ScopePlan, frame: Frame): boolean {
  const inEdges = scope.inEdges.get(nodeId) ?? []
  for (const edge of inEdges) {
    if (frame.status.get(edge.source) !== 'succeeded') continue
    const ports = frame.firedPorts.get(edge.source) ?? []
    if (ports.includes(edge.sourceHandle)) return true
  }
  return false
}

function coerceStartInputs(inputs: Record<string, JsonValue>, start: FlowNode): Record<string, JsonValue> {
  if (start.type !== 'start') return inputs
  const out: Record<string, JsonValue> = {}
  for (const field of start.data.fields) {
    const raw = inputs[field.name]
    if (raw === undefined || raw === null) {
      const def = (field as { default?: JsonValue }).default
      if (def !== undefined) { out[field.name] = def; continue }
      const coerced = coerce(null, field.schema)
      out[field.name] = coerced.ok ? coerced.value : null
      continue
    }
    const coerced = coerce(raw, field.schema)
    out[field.name] = coerced.ok ? coerced.value : null
  }
  return out
}

function usageOf(budget: RunBudget): TokenUsageLite {
  void budget
  return { inputTokens: 0, outputTokens: 0 }
}
