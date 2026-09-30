/**
 * Scheduler: event-driven execution of one scope frame with dead-path
 * elimination. When a node settles, its successors are re-evaluated
 * immediately, so independent branches never wait on a slow sibling. Leaf node
 * executions are bounded by a shared concurrency semaphore; a node whose
 * predecessors all settle with no activated incoming edge is skipped.
 *
 * @module @dsh-plugins/flow/host/engine/scheduler
 */

import type { FlowNode, FrameStep, JsonValue, RunEvent, TokenUsageLite, ValueSource } from '../../spec/types.ts'
import type { ScopePlan, ExecutionPlan } from './compile.ts'
import { createFrame, execKey, type Frame } from './frames.ts'
import { resolveRef } from './frames.ts'
import { NodeError, BudgetExceededError, type RunBudget } from './budget.ts'
import { iterBindings } from '../../spec/validate.ts'
import { coerce } from '../../spec/coerce.ts'
import { defaultValue } from '../../spec/var-schema.ts'
import { specOf } from '../../spec/nodes/index.ts'
import type { AgentBinding, ExecContext, ExecResult, FlowServices, FrameResult, Interaction, NodeExecutor } from '../executors/index.ts'
import type { FlowLimits } from '../limits.ts'

/** The reason a run or frame was aborted, carried on `AbortSignal.reason`. */
export class RunAbort {
  constructor(readonly kind: 'user' | 'timeout' | 'dispose' | 'budget' | 'sibling' | 'control') {}
}

/** A shared semaphore bounding concurrent leaf node executions across a run. */
export class Semaphore {
  private active = 0
  private readonly waiters: { grant: () => void }[] = []
  constructor(private readonly limit: number) {}

  /**
   * Wait for a slot.
   * @param signal - aborts the wait; the waiter leaves the queue and the promise rejects with the signal reason.
   * @returns the release function for the acquired slot.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    if (this.active < this.limit) {
      this.active++
      return this.releaser()
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(entry)
        if (index !== -1) this.waiters.splice(index, 1)
        reject(signal?.reason ?? new Error('semaphore wait aborted'))
      }
      // A released slot is handed to the waiter directly (active is not decremented), so no newcomer can take it first.
      const entry = { grant: (): void => { signal?.removeEventListener('abort', onAbort); resolve() } }
      this.waiters.push(entry)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    return this.releaser()
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next !== undefined) next.grant()
      else this.active--
    }
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
  services: FlowServices
  interaction: Interaction
  agent(): Promise<AgentBinding>
  emitter: RunEmitter
  executors: Record<string, NodeExecutor>
  plan: ExecutionPlan
  limits: Readonly<FlowLimits>
  runSubflow(nodeId: string, flowId: string, version: number | 'published' | 'draft', inputs: Record<string, JsonValue>, basePath: FrameStep[], flowStack: string[], signal: AbortSignal): Promise<Record<string, JsonValue>>
  runContainer(containerId: string, inner: Record<string, JsonValue>, index: number, parentFrame: Frame, flowStack: string[], signal: AbortSignal): Promise<FrameResult>
  /** A monotonic run-scoped id for tool calls. */
  nextCallId(): string
  /** Abort the whole run; used for run-level fatal errors such as an exhausted budget. */
  abortRun(reason: RunAbort): void
  /** Abort signal for the whole run (user cancel, total timeout, budget, host dispose). */
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

/** Everything a `node.finished` event may carry beyond identity and status. */
interface FinishedExtra {
  outputs?: Record<string, JsonValue>
  firedPorts?: string[]
  error?: { code: string; message: string }
  usage?: TokenUsageLite
  durationMs?: number
  logs?: string[]
  warnings?: string[]
  rendered?: { system?: string; prompt?: string }
}

/**
 * Run a flow from its root scope. Pre-settles the `start` output, runs the
 * root frame, and reads the `end` output. Emits no `run.*` events: the engine
 * emits `run.started`/`run.finished` around the top-level call, and subflows
 * reuse this path without leaking a nested `run.*` event.
 * @param plan - the compiled flow.
 * @param inputs - start inputs, already validated by the caller.
 * @param ctx - the run context.
 * @param basePath - frame path prefix (empty for the top level, `[..., { node: subflowNodeId }]` for a subflow).
 * @param flowStack - flow ids on the current subflow call chain, including this flow.
 * @param signal - the owning signal: the run signal at the top level, the subflow node's signal otherwise.
 * @returns the flow outcome.
 */
export async function runFlow(plan: ExecutionPlan, inputs: Record<string, JsonValue>, ctx: RunContext, basePath: FrameStep[], flowStack: string[], signal: AbortSignal = ctx.signal): Promise<RunResult> {
  const rootScope = plan.scopes.get('root')
  if (rootScope === undefined) throw new Error('flow has no root scope')
  const frame = createFrame('root', basePath, plan, undefined, signal)
  const start = rootScope.nodes.find(node => node.type === 'start')
  const presettled = new Set<string>()
  if (start !== undefined) {
    const coerced = startInputs(inputs, start)
    frame.outputs.set(start.id, coerced)
    frame.firedPorts.set(start.id, ['next'])
    finish(ctx, frame, start, 'succeeded', 0, { outputs: coerced, firedPorts: ['next'] })
    presettled.add(start.id)
  }
  const outcome = await runScopeFrame(rootScope, frame, ctx, flowStack, presettled)
  const usage = ctx.budget.usage()
  if (!outcome.completed) {
    const abortClass = classifyRunAbort(ctx.signal)
    if (abortClass !== undefined) {
      return { status: abortClass.status, ...(abortClass.error === undefined ? {} : { error: abortClass.error }), usage }
    }
    const error = outcome.error ?? { code: 'END_NOT_REACHED', message: 'the end node was not reached' }
    return { status: 'failed', error, usage }
  }
  return { status: 'succeeded', outputs: outcome.outputs, usage }
}

/**
 * Classify a run abort into a final run status.
 * @param signal - the run signal.
 * @returns the final status and error, or undefined when the run was not aborted.
 */
export function classifyRunAbort(signal: AbortSignal): { status: 'cancelled' | 'failed'; error?: { code: string; message: string } } | undefined {
  if (!signal.aborted) return undefined
  const reason: unknown = signal.reason
  if (reason instanceof RunAbort) {
    if (reason.kind === 'user') return { status: 'cancelled', error: { code: 'CANCELLED', message: 'run was cancelled' } }
    if (reason.kind === 'dispose') return { status: 'cancelled', error: { code: 'HOST_DISPOSED', message: 'the host plugin was disposed' } }
    if (reason.kind === 'timeout') return { status: 'failed', error: { code: 'RUN_TIMEOUT', message: 'run exceeded its maximum duration' } }
    if (reason.kind === 'budget') return { status: 'failed', error: { code: 'BUDGET_EXCEEDED', message: 'run exceeded its budget' } }
  }
  return { status: 'cancelled', error: { code: 'CANCELLED', message: 'run was cancelled' } }
}

/**
 * Run one scope frame to completion (event-driven).
 * @param scope - the scope plan.
 * @param frame - the frame to run.
 * @param ctx - the run context.
 * @param flowStack - flow ids on the current subflow call chain.
 * @param presettled - node ids already settled before the frame starts (the root `start`).
 * @returns the frame outcome.
 */
export async function runScopeFrame(scope: ScopePlan, frame: Frame, ctx: RunContext, flowStack: string[], presettled: Set<string> = new Set()): Promise<FrameRunResult> {
  const settled = new Set<string>(presettled)
  const running = new Set<string>()
  let resolveDone!: () => void
  const allSettled = new Promise<void>((resolve) => { resolveDone = resolve })
  const byId = new Map(scope.nodes.map(node => [node.id, node]))
  const orderIndex = new Map<string, number>()
  scope.order.forEach((id, index) => orderIndex.set(id, index))
  const ordered = [...scope.nodes].sort((a, b) => (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))

  const checkDone = (): void => {
    if (settled.size >= scope.nodes.length && running.size === 0) resolveDone()
  }

  const settle = (node: FlowNode, status: 'skipped' | 'cancelled'): void => {
    frame.status.set(node.id, status)
    frame.firedPorts.set(node.id, [])
    finish(ctx, frame, node, status, 0, {})
    settled.add(node.id)
  }

  // Frame over (fatal error, abort, or break/continue): settle every node that has not started.
  const stopRemaining = (): void => {
    const status = frame.error === undefined && frame.control !== undefined ? 'skipped' : 'cancelled'
    for (const node of ordered) {
      if (!settled.has(node.id) && !running.has(node.id)) settle(node, status)
    }
  }

  const pump = (): void => {
    if (frame.error !== undefined || frame.control !== undefined || frame.signal.aborted) {
      stopRemaining()
      checkDone()
      return
    }
    let progressed = true
    while (progressed) {
      progressed = false
      for (const node of ordered) {
        if (settled.has(node.id) || running.has(node.id)) continue
        if (!isSettled(node.id, scope, settled)) continue
        if (scope.entry.includes(node.id) || hasActivatedInEdge(node.id, scope, frame)) {
          running.add(node.id)
          void executeNode(frame, node, ctx, flowStack)
            .catch((error: unknown) => {
              // An engine fault (not a node failure) must still settle the node and fail the frame.
              frame.status.set(node.id, 'failed')
              frame.error ??= { code: 'ENGINE_ERROR', message: error instanceof Error ? error.message : String(error), nodeId: node.id }
            })
            .finally(() => {
              running.delete(node.id)
              settled.add(node.id)
              pump()
            })
        } else {
          settle(node, 'skipped')
          progressed = true
        }
      }
    }
    checkDone()
  }

  pump()
  await allSettled

  if (frame.error !== undefined) return { completed: false, error: frame.error }
  if (frame.control !== undefined) return { completed: false, control: frame.control }
  const end = byId.get(scope.nodes.find(node => node.type === 'end')?.id ?? '')
  if (end !== undefined && frame.status.get(end.id) === 'succeeded') {
    return { completed: true, outputs: frame.outputs.get(end.id) }
  }
  return { completed: false }
}

/** Execute one node, applying retries, timeouts, and the error policy. Never rejects on a node failure. */
async function executeNode(frame: Frame, node: FlowNode, ctx: RunContext, flowStack: string[]): Promise<void> {
  const executor = ctx.executors[node.type]
  if (executor === undefined) {
    // A missing executor is a programming error: fail the run loudly, not as a silent "end not reached".
    const error = { code: 'NO_EXECUTOR', message: `no executor for node type "${node.type}"` }
    frame.status.set(node.id, 'failed')
    frame.firedPorts.set(node.id, [])
    frame.error = { ...error, nodeId: node.id }
    finish(ctx, frame, node, 'failed', 0, { error })
    return
  }

  const policy = node.onError
  const maxRetries = policy?.retries ?? 0
  const isLeaf = node.type !== 'loop' && node.type !== 'batch' && node.type !== 'subflow'
  let lastError: NodeError | undefined
  let lastAttempt = 0
  let attemptController: AbortController | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastAttempt = attempt
    // Abort the previous attempt so a stale call stops streaming deltas or consuming tokens.
    attemptController?.abort(new RunAbort('sibling'))
    attemptController = new AbortController()
    const timeoutMs = policy?.timeoutMs === undefined ? undefined : Math.min(policy.timeoutMs, ctx.limits.maxNodeTimeoutMs)
    const ownTimeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([frame.signal, attemptController.signal, ...(ownTimeout === undefined ? [] : [ownTimeout])])
    frame.status.set(node.id, 'running')

    let inputs: Record<string, JsonValue>
    try {
      ctx.budget.consumeNodeExecution()
      inputs = resolveInputsForNode(node, frame)
    } catch (caught: unknown) {
      if (caught instanceof BudgetExceededError) {
        failBudget(frame, node, ctx, caught, attempt)
        return
      }
      lastError = caught instanceof NodeError ? caught : new NodeError('INPUT_TYPE', errorMessage(caught))
      break
    }
    ctx.emitter.emit({ seq: ctx.emitter.seq++, time: Date.now(), type: 'node.started', execKey: execKey(frame, node.id), nodeId: node.id, path: frame.path, attempt, inputs })

    let release: (() => void) | undefined
    const startedAt = Date.now()
    try {
      // Container and subflow nodes must not hold a permit: with maxConcurrentNodes=1 a container waiting on its children would deadlock.
      if (isLeaf) release = await ctx.semaphore.acquire(signal)
      const execCtx = buildExecContext(ctx, frame, execKey(frame, node.id), signal, flowStack)
      const raced = await Promise.race([executor.execute(node, inputs, execCtx), abortPromise(signal)])
      const outputs = node.onError !== undefined && node.onError.onError !== 'fail' ? { ...raced.outputs, errorMessage: null } : raced.outputs
      assertValueSize(outputs, ctx.limits.maxValueBytes)
      if (raced.usage !== undefined) ctx.budget.addUsage(raced.usage)
      const firedPorts = raced.firedPorts ?? ['next']
      frame.outputs.set(node.id, outputs)
      frame.firedPorts.set(node.id, firedPorts)
      finish(ctx, frame, node, 'succeeded', attempt, extraOf(raced, outputs, firedPorts, Date.now() - startedAt))
      return
    } catch (caught: unknown) {
      if (caught instanceof BudgetExceededError) {
        failBudget(frame, node, ctx, caught, attempt)
        return
      }
      if (signal.aborted) {
        // Only this node's own timer is a retryable timeout; a parent container's timeout cancels it.
        if (ownTimeout?.aborted !== true || frame.signal.aborted) {
          frame.status.set(node.id, 'cancelled')
          frame.firedPorts.set(node.id, [])
          finish(ctx, frame, node, 'cancelled', attempt, {})
          return
        }
        lastError = new NodeError('NODE_TIMEOUT', `node exceeded its ${timeoutMs ?? 0}ms timeout`, true)
        continue
      }
      lastError = caught instanceof NodeError ? caught : new NodeError('NODE_ERROR', errorMessage(caught))
      if (!lastError.retryable) break
    } finally {
      release?.()
    }
  }

  applyFailure(frame, node, lastError ?? new NodeError('NODE_ERROR', 'node failed'), lastAttempt, ctx)
}

/** A budget ceiling is run-fatal: it bypasses retries and error policies and aborts the whole run. */
function failBudget(frame: Frame, node: FlowNode, ctx: RunContext, error: BudgetExceededError, attempt: number): void {
  frame.status.set(node.id, 'failed')
  frame.firedPorts.set(node.id, [])
  frame.error = { code: error.code, message: error.message, nodeId: node.id }
  finish(ctx, frame, node, 'failed', attempt, { error: { code: error.code, message: error.message } })
  ctx.abortRun(new RunAbort('budget'))
}

/** Apply a node failure according to its error policy. */
function applyFailure(frame: Frame, node: FlowNode, nodeError: NodeError, attempt: number, ctx: RunContext): void {
  const error = { code: nodeError.code, message: nodeError.message }
  const policy = node.onError
  if (policy?.onError === 'default') {
    const outputs = resolveDefaultOutputs(node, policy.defaultOutputs, nodeError.message)
    frame.outputs.set(node.id, outputs)
    frame.firedPorts.set(node.id, ['next'])
    finish(ctx, frame, node, 'succeeded', attempt, { outputs, firedPorts: ['next'], error, warnings: [nodeError.message] })
    return
  }
  if (policy?.onError === 'branch') {
    const outputs = { errorMessage: nodeError.message }
    frame.outputs.set(node.id, outputs)
    frame.firedPorts.set(node.id, ['error'])
    finish(ctx, frame, node, 'succeeded', attempt, { outputs, firedPorts: ['error'], error, warnings: [nodeError.message] })
    return
  }
  frame.outputs.set(node.id, {})
  frame.firedPorts.set(node.id, [])
  frame.error = { ...error, nodeId: node.id }
  finish(ctx, frame, node, 'failed', attempt, { error })
  frame.controller.abort(new RunAbort('sibling'))
}

/** Resolve and coerce a node's named inputs from the frame chain (single path). */
function resolveInputsForNode(node: FlowNode, frame: Frame): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const binding of iterBindings(node)) {
    const raw = resolveRef(frame, binding.value)
    if (raw === null) {
      if (binding.required ?? true) throw new NodeError('REQUIRED_INPUT', `required input "${binding.name}" is null or missing${upstreamNote(frame, binding.value)}`)
      out[binding.name] = null
      continue
    }
    const coerced = coerce(raw, binding.schema)
    if (!coerced.ok) throw new NodeError('INPUT_TYPE', `input "${binding.name}": ${coerced.reason}`)
    out[binding.name] = coerced.value
  }
  return out
}

/** Explain a null input whose upstream node did not succeed (e.g. an untaken condition branch). */
function upstreamNote(frame: Frame, ref: ValueSource): string {
  if (ref.kind !== 'ref' || ref.source === 'inner') return ''
  for (let current: Frame | undefined = frame; current !== undefined; current = current.parent) {
    const status = current.status.get(ref.node)
    if (status === undefined) continue
    if (status === 'succeeded') return ''
    return ` (upstream node "${ref.node}" is ${status}; join branches with an aggregate node or mark the input optional)`
  }
  return ''
}

/** Coerce the default outputs for an `onError=default` node against its spec. */
function resolveDefaultOutputs(node: FlowNode, defaultOutputs: Record<string, JsonValue> | undefined, message: string): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { ...(defaultOutputs ?? {}) }
  for (const field of specOf(node).outputs(node, () => undefined)) {
    const raw = out[field.name]
    if (raw === undefined) {
      out[field.name] = defaultValue(field.schema)
      continue
    }
    const coerced = coerce(raw, field.schema)
    out[field.name] = coerced.ok ? coerced.value : defaultValue(field.schema)
  }
  out['errorMessage'] = message
  return out
}

/** Resolve and coerce the start inputs; a value that fails its declared type is an error, never a silent null. */
function startInputs(inputs: Record<string, JsonValue>, start: FlowNode): Record<string, JsonValue> {
  if (start.type !== 'start') return inputs
  const out: Record<string, JsonValue> = {}
  for (const field of start.data.fields) {
    const raw = inputs[field.name]
    if (raw === undefined || raw === null) {
      out[field.name] = field.default ?? null
      continue
    }
    const coerced = coerce(raw, field.schema)
    if (!coerced.ok) throw new NodeError('INPUT_TYPE', `start input "${field.name}": ${coerced.reason}`)
    out[field.name] = coerced.value
  }
  return out
}

/** Fail a node whose outputs exceed the configured per-value byte limit. */
function assertValueSize(outputs: Record<string, JsonValue>, maxBytes: number): void {
  const bytes = Buffer.byteLength(JSON.stringify(outputs))
  if (bytes > maxBytes) throw new NodeError('VALUE_TOO_LARGE', `node outputs are ${bytes} bytes, above the ${maxBytes}-byte limit`)
}

/** A promise that rejects when a signal aborts; the listener is removed by the abort itself or dropped with the signal. */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => { reject(signal.reason ?? new Error('aborted')) }, { once: true })
  })
}


function extraOf(result: ExecResult, outputs: Record<string, JsonValue>, firedPorts: string[], durationMs: number): FinishedExtra {
  return {
    outputs,
    firedPorts,
    durationMs,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.logs === undefined ? {} : { logs: result.logs }),
    ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
    ...(result.rendered === undefined ? {} : { rendered: result.rendered }),
  }
}

function finish(ctx: RunContext, frame: Frame, node: FlowNode, status: 'succeeded' | 'failed' | 'skipped' | 'cancelled', attempt: number, extra: FinishedExtra): void {
  frame.status.set(node.id, status)
  ctx.emitter.emit({
    seq: ctx.emitter.seq++,
    time: Date.now(),
    type: 'node.finished',
    execKey: execKey(frame, node.id),
    nodeId: node.id,
    path: frame.path,
    attempt,
    status,
    ...(extra.outputs === undefined ? {} : { outputs: extra.outputs }),
    ...(extra.firedPorts === undefined || extra.firedPorts.length === 0 ? {} : { firedPorts: extra.firedPorts }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
    ...(extra.usage === undefined ? {} : { usage: extra.usage }),
    ...(extra.durationMs === undefined ? {} : { durationMs: extra.durationMs }),
    ...(extra.logs === undefined ? {} : { logs: extra.logs }),
    ...(extra.warnings === undefined ? {} : { warnings: extra.warnings }),
    ...(extra.rendered === undefined ? {} : { rendered: extra.rendered }),
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildExecContext(ctx: RunContext, frame: Frame, key: string, nodeSignal: AbortSignal, flowStack: string[]): ExecContext {
  return {
    signal: nodeSignal,
    runId: ctx.runId,
    execKey: key,
    frame,
    workspacePath: ctx.workspacePath,
    budget: ctx.budget,
    limits: ctx.limits,
    emitDelta: (text) => ctx.emitter.emit({ seq: ctx.emitter.seq++, time: Date.now(), type: 'node.delta', execKey: key, text }),
    emitMessage: (text) => ctx.emitter.emit({ seq: ctx.emitter.seq++, time: Date.now(), type: 'run.message', execKey: key, text }),
    agent: () => ctx.agent(),
    interaction: ctx.interaction,
    services: ctx.services,
    flowStack,
    runScope: (container, inner, index, signal) => ctx.runContainer(container.id, inner, index, frame, flowStack, signal ?? nodeSignal),
    runSubflow: (nodeId, flowId, version, inputs) => ctx.runSubflow(nodeId, flowId, version, inputs, frame.path, flowStack, nodeSignal),
    nextCallId: () => ctx.nextCallId(),
  }
}

/**
 * Run a container body scope once.
 * @param plan - the plan that owns the container (the subflow's plan inside a subflow).
 * @param containerId - the loop/batch node id.
 * @param inner - the container's inner variables for this round/item.
 * @param path - the body frame path, ending in `{ node: containerId, index }`.
 * @param parentFrame - the frame the container node runs in, for outward reference resolution.
 * @param ctx - the run context.
 * @param flowStack - flow ids on the current subflow call chain.
 * @param signal - the container node's signal (or a batch-local signal), aborting the body.
 * @returns the body frame's node outputs, control signal, and error.
 */
export async function runContainerFrame(plan: ExecutionPlan, containerId: string, inner: Record<string, JsonValue>, path: FrameStep[], parentFrame: Frame, ctx: RunContext, flowStack: string[], signal?: AbortSignal): Promise<FrameResult> {
  const bodyScope = plan.scopes.get(containerId)
  if (bodyScope === undefined) throw new NodeError('NO_SCOPE', `container "${containerId}" has no body scope in its plan`)
  const frame = createFrame(containerId, path, plan, parentFrame, signal, inner)
  const result = await runScopeFrame(bodyScope, frame, ctx, flowStack)
  return {
    nodeOutputs: frame.outputs,
    ...(frame.control === undefined ? {} : { control: frame.control }),
    ...(frame.error === undefined ? {} : { error: frame.error }),
    failed: frame.error !== undefined || (!result.completed && [...frame.status.values()].some(status => status === 'failed')),
  }
}

function isSettled(nodeId: string, scope: ScopePlan, settled: Set<string>): boolean {
  if (scope.entry.includes(nodeId)) return true
  for (const edge of scope.inEdges.get(nodeId) ?? []) {
    if (!settled.has(edge.source)) return false
  }
  return true
}

function hasActivatedInEdge(nodeId: string, scope: ScopePlan, frame: Frame): boolean {
  for (const edge of scope.inEdges.get(nodeId) ?? []) {
    if (frame.status.get(edge.source) !== 'succeeded') continue
    if ((frame.firedPorts.get(edge.source) ?? []).includes(edge.sourceHandle)) return true
  }
  return false
}
