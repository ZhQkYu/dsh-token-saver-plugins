import { describe, expect, it } from 'vitest'
import type { FlowDocument, FlowNode, JsonValue, RunEvent } from '../src/spec/types.ts'
import { compile } from '../src/host/engine/compile.ts'
import { runFlow, RunAbort, Semaphore, type RunContext } from '../src/host/engine/scheduler.ts'
import { RunBudget } from '../src/host/engine/budget.ts'
import { NodeError } from '../src/host/engine/budget.ts'
import type { ExecContext, FlowServices, Interaction, NodeExecutor } from '../src/host/executors/index.ts'
import { conditionExecutor } from '../src/host/executors/condition.ts'
import { buildExecutors } from '../src/host/executors/registry.ts'

/** A controllable promise, used to assert concurrent execution. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

const testLimits = {
  maxLoopIterations: 100,
  maxBatchConcurrency: 10,
  maxBatchItems: 100,
  maxNodeTimeoutMs: 60000,
  maxRetries: 5,
  maxNestingDepth: 5,
  maxRegexInputChars: 100000,
  maxConcurrentNodes: 8,
  maxNodeExecutionsPerRun: 100,
  maxLlmCallsPerRun: 100,
  maxAgentNodesPerRun: 100,
  maxRunDurationMs: 60000,
  code: { timeoutMs: 30000, sandboxMode: 'read-only' as const },
  http: { timeoutMs: 30000, maxResponseBytes: 2000000, maxRedirects: 5, allowPrivateNetwork: false, allowedHosts: [] },
  recordValueChars: 20000,
  maxValueBytes: 4000000,
  maxRunEventsBytes: 8000000,
  keepRunsPerFlow: 50,
  archiveRunSessions: true,
}

/** Build a minimal run context for scheduler tests. */
function buildContext(opts: {
  doc: FlowDocument
  executors?: Record<string, NodeExecutor>
  services?: Partial<FlowServices>
  maxConcurrent?: number
  budget?: Partial<{ maxNodeExecutions: number; maxLlmCalls: number; maxAgentNodes: number; maxRunDurationMs: number }>
  signal?: AbortSignal
}): { ctx: RunContext; events: RunEvent[] } {
  const events: RunEvent[] = []
  const emitter = { seq: 0, emit: (event: RunEvent) => { events.push(event) } }
  const interaction: Interaction = { ask: async () => ({}) }
  const budget = new RunBudget({
    maxNodeExecutions: opts.budget?.maxNodeExecutions ?? 100,
    maxLlmCalls: opts.budget?.maxLlmCalls ?? 100,
    maxAgentNodes: opts.budget?.maxAgentNodes ?? 100,
    maxRunDurationMs: opts.budget?.maxRunDurationMs ?? 60000,
  })
  const plan = compile(opts.doc, () => undefined, testLimits)
  const runController = new AbortController()
  const runSignal = opts.signal === undefined ? runController.signal : AbortSignal.any([opts.signal, runController.signal])
  const services: FlowServices = {
    llm: { stream: async function* () {} },
    tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
    defaultModel: () => ({ provider: 'test', model: 'test' }),
    sandboxPolicy: { resolve: () => ({}) },
    ...opts.services,
  }
  const ctx: RunContext = {
    runId: 'run-1',
    workspacePath: '/tmp',
    budget,
    semaphore: new Semaphore(opts.maxConcurrent ?? 8),
    services,
    interaction,
    agent: async () => ({ kind: 'run-session', agent: {} as never }),
    emitter,
    executors: { ...buildExecutors(), ...(opts.executors ?? {}) },
    plan,
    limits: testLimits,
    signal: runSignal,
    abortRun: (reason) => { runController.abort(reason) },
    runSubflow: async () => ({}),
    runContainer: async () => ({ nodeOutputs: new Map(), failed: false }),
    nextCallId: () => 'call-1',
  }
  return { ctx, events }
}

/** A node factory helper for plain executable nodes. */
function node<T extends FlowNode['type']>(partial: Partial<Extract<FlowNode, { type: T }>> & { id: string; type: T; title: string; data: Extract<FlowNode, { type: T }>['data'] }): Extract<FlowNode, { type: T }> {
  return { description: '', position: { x: 0, y: 0 }, ...partial } as Extract<FlowNode, { type: T }>
}

function makeDoc(nodes: FlowNode[], edges: FlowDocument['edges']): FlowDocument {
  return { schemaVersion: 1, id: 'flow-1', name: 'test', description: '', nodes, edges, revision: 1, updatedAt: 0 }
}

function simpleExecutor(transform: (inputs: Record<string, JsonValue>) => Record<string, JsonValue>, delay?: Promise<void>): NodeExecutor {
  return {
    type: 'text',
    execute: async (_node, inputs, _ctx) => {
      if (delay !== undefined) await delay
      return { outputs: transform(inputs) }
    },
  } as never
}

describe('scheduler', () => {
  it('runs a linear flow start → text → end and collects output', async () => {
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({ id: 'text1', type: 'text', title: 'Text', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 'text1', source: 'output', path: ['text'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'text1' },
      { id: 'e2', source: 'text1', sourceHandle: 'next', target: 'end' },
    ]
    const { ctx } = buildContext({ doc: makeDoc(nodes, edges), executors: { text: simpleExecutor(i => ({ text: String(i.t ?? '') })) } })
    const result = await runFlow(ctx.plan, { x: 'hello' }, ctx, [], ['flow-1'])
    expect(result.status).toBe('succeeded')
    expect(result.outputs).toEqual({ out: 'hello' })
  })

  it('executes ready nodes in parallel, bounded by the semaphore', async () => {
    const gate = deferred()
    const started: string[] = []
    const blockingExecutor: NodeExecutor = {
      type: 'text',
      execute: async (node) => {
        started.push(node.id)
        await gate.promise
        return { outputs: { text: node.id } }
      },
    } as never
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({ id: 'a', type: 'text', title: 'A', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'b', type: 'text', title: 'B', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 'a', source: 'output', path: ['text'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'a' },
      { id: 'e2', source: 'start', sourceHandle: 'next', target: 'b' },
      { id: 'e3', source: 'a', sourceHandle: 'next', target: 'end' },
    ]
    const { ctx } = buildContext({ doc: makeDoc(nodes, edges), executors: { text: blockingExecutor } })
    const run = runFlow(ctx.plan, { x: 'v' }, ctx, [], ['flow-1'])
    await new Promise(r => setTimeout(r, 10))
    // Both a and b should have started concurrently.
    expect(started.sort()).toEqual(['a', 'b'])
    gate.resolve()
    const result = await run
    expect(result.status).toBe('succeeded')
  })

  it('bounded by the semaphore when maxConcurrentNodes is 1', async () => {
    const gate = deferred()
    let concurrent = 0
    let peak = 0
    const blockingExecutor: NodeExecutor = {
      type: 'text',
      execute: async () => {
        concurrent++
        peak = Math.max(peak, concurrent)
        await gate.promise
        concurrent--
        return { outputs: { text: 'ok' } }
      },
    } as never
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({ id: 'a', type: 'text', title: 'A', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'b', type: 'text', title: 'B', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 'a', source: 'output', path: ['text'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'a' },
      { id: 'e2', source: 'start', sourceHandle: 'next', target: 'b' },
      { id: 'e3', source: 'a', sourceHandle: 'next', target: 'end' },
    ]
    const { ctx } = buildContext({ doc: makeDoc(nodes, edges), executors: { text: blockingExecutor }, maxConcurrent: 1 })
    const run = runFlow(ctx.plan, { x: 'v' }, ctx, [], ['flow-1'])
    await new Promise(r => setTimeout(r, 10))
    gate.resolve()
    await run
    expect(peak).toBe(1)
  })

  it('skips the unselected branch and propagates the skip', async () => {
    const executed: string[] = []
    const recordExecutor: NodeExecutor = {
      type: 'text',
      execute: async (node) => {
        executed.push(node.id)
        return { outputs: { text: node.id } }
      },
    } as never
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({
        id: 'cond', type: 'condition', title: 'Cond', data: {
          branches: [{ id: 'ok', label: 'OK', logic: 'and', conditions: [{ left: { kind: 'ref', node: 'start', source: 'output', path: ['x'] }, op: 'eq', right: { kind: 'literal', value: 'yes' } }] }],
        },
      }),
      node({ id: 'yes', type: 'text', title: 'Yes', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'no', type: 'text', title: 'No', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 'yes', source: 'output', path: ['text'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'cond' },
      { id: 'e2', source: 'cond', sourceHandle: 'ok', target: 'yes' },
      { id: 'e3', source: 'cond', sourceHandle: 'else', target: 'no' },
      { id: 'e4', source: 'yes', sourceHandle: 'next', target: 'end' },
    ]
    const { ctx, events } = buildContext({ doc: makeDoc(nodes, edges), executors: { text: recordExecutor, condition: conditionExecutor } })
    const result = await runFlow(ctx.plan, { x: 'yes' }, ctx, [], ['flow-1'])
    expect(result.status).toBe('succeeded')
    expect(executed).toContain('yes')
    expect(executed).not.toContain('no')
    const skipped = events.filter(e => e.type === 'node.finished' && e.status === 'skipped')
    expect(skipped.some(e => e.nodeId === 'no')).toBe(true)
  })

  it('applies onError=default by returning default outputs and firing next', async () => {
    const failing: NodeExecutor = {
      type: 'text',
      execute: async () => { throw new NodeError('NODE_ERROR', 'boom') },
    } as never
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({ id: 't', type: 'text', title: 'Text', onError: { onError: 'default', defaultOutputs: { text: 'fallback' } }, data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 't', source: 'output', path: ['text'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 't' },
      { id: 'e2', source: 't', sourceHandle: 'next', target: 'end' },
    ]
    const { ctx } = buildContext({ doc: makeDoc(nodes, edges), executors: { text: failing } })
    const result = await runFlow(ctx.plan, { x: 'v' }, ctx, [], ['flow-1'])
    expect(result.status).toBe('succeeded')
    expect(result.outputs).toEqual({ out: 'fallback' })
  })

  it('applies onError=branch by firing the error port', async () => {
    const failing: NodeExecutor = {
      type: 'text',
      execute: async () => { throw new NodeError('NODE_ERROR', 'boom') },
    } as never
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({ id: 't', type: 'text', title: 'Text', onError: { onError: 'branch' }, data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 't', source: 'output', path: ['errorMessage'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 't' },
      { id: 'e2', source: 't', sourceHandle: 'error', target: 'end' },
    ]
    const { ctx } = buildContext({ doc: makeDoc(nodes, edges), executors: { text: failing } })
    const result = await runFlow(ctx.plan, { x: 'v' }, ctx, [], ['flow-1'])
    expect(result.status).toBe('succeeded')
    expect(result.outputs).toEqual({ out: 'boom' })
  })

  it('fails the frame on onError=fail', async () => {
    const failing: NodeExecutor = {
      type: 'text',
      execute: async () => { throw new NodeError('NODE_ERROR', 'boom') },
    } as never
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({ id: 't', type: 'text', title: 'Text', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 't', source: 'output', path: ['text'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 't' },
      { id: 'e2', source: 't', sourceHandle: 'next', target: 'end' },
    ]
    const { ctx } = buildContext({ doc: makeDoc(nodes, edges), executors: { text: failing } })
    const result = await runFlow(ctx.plan, { x: 'v' }, ctx, [], ['flow-1'])
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('NODE_ERROR')
  })

  it('retries retryable errors up to the configured count', async () => {
    let attempts = 0
    const flaky: NodeExecutor = {
      type: 'text',
      execute: async () => {
        attempts++
        if (attempts < 3) throw new NodeError('NODE_ERROR', 'transient', true)
        return { outputs: { text: 'ok' } }
      },
    } as never
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({ id: 't', type: 'text', title: 'Text', onError: { onError: 'fail', retries: 2 }, data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 't', source: 'output', path: ['text'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 't' },
      { id: 'e2', source: 't', sourceHandle: 'next', target: 'end' },
    ]
    const { ctx } = buildContext({ doc: makeDoc(nodes, edges), executors: { text: flaky } })
    const result = await runFlow(ctx.plan, { x: 'v' }, ctx, [], ['flow-1'])
    expect(result.status).toBe('succeeded')
    expect(attempts).toBe(3)
  })

  it('does not retry non-retryable errors', async () => {
    let attempts = 0
    const failing: NodeExecutor = {
      type: 'text',
      execute: async () => {
        attempts++
        throw new NodeError('NODE_ERROR', 'fatal', false)
      },
    } as never
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({ id: 't', type: 'text', title: 'Text', onError: { onError: 'fail', retries: 5 }, data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 't', source: 'output', path: ['text'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 't' },
      { id: 'e2', source: 't', sourceHandle: 'next', target: 'end' },
    ]
    const { ctx } = buildContext({ doc: makeDoc(nodes, edges), executors: { text: failing } })
    const result = await runFlow(ctx.plan, { x: 'v' }, ctx, [], ['flow-1'])
    expect(result.status).toBe('failed')
    expect(attempts).toBe(1)
  })

  it('reports END_NOT_REACHED when the end node is skipped', async () => {
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({
        id: 'cond', type: 'condition', title: 'Cond', data: {
          branches: [{ id: 'ok', label: 'OK', logic: 'and', conditions: [{ left: { kind: 'ref', node: 'start', source: 'output', path: ['x'] }, op: 'eq', right: { kind: 'literal', value: 'yes' } }] }],
        },
      }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [] } }),
    ]
    // end only reachable from the unselected branch.
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'cond' },
      { id: 'e2', source: 'cond', sourceHandle: 'else', target: 'end' },
    ]
    const { ctx } = buildContext({ doc: makeDoc(nodes, edges), executors: { condition: conditionExecutor } })
    const result = await runFlow(ctx.plan, { x: 'yes' }, ctx, [], ['flow-1'])
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('END_NOT_REACHED')
  })

  it('cancels the run when the abort signal fires', async () => {
    const gate = deferred()
    const slow: NodeExecutor = {
      type: 'text',
      execute: async (_node, _inputs, ctx: ExecContext) => {
        await gate.promise
        ctx.signal.throwIfAborted()
        return { outputs: { text: 'ok' } }
      },
    } as never
    const controller = new AbortController()
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({ id: 't', type: 'text', title: 'Text', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 't', source: 'output', path: ['text'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 't' },
      { id: 'e2', source: 't', sourceHandle: 'next', target: 'end' },
    ]
    const { ctx } = buildContext({ doc: makeDoc(nodes, edges), executors: { text: slow }, signal: controller.signal })
    const run = runFlow(ctx.plan, { x: 'v' }, ctx, [], ['flow-1'])
    await new Promise(r => setTimeout(r, 10))
    controller.abort(new RunAbort('user'))
    gate.resolve()
    const result = await run
    expect(result.status).toBe('cancelled')
  })

  it('emits monotonically increasing seq values', async () => {
    const nodes = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'x', schema: { type: 'string' } }] } }),
      node({ id: 't', type: 'text', title: 'Text', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 't', source: 'output', path: ['text'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 't' },
      { id: 'e2', source: 't', sourceHandle: 'next', target: 'end' },
    ]
    const { ctx, events } = buildContext({ doc: makeDoc(nodes, edges), executors: { text: simpleExecutor(i => ({ text: String(i.t ?? '') })) } })
    await runFlow(ctx.plan, { x: 'v' }, ctx, [], ['flow-1'])
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq)
    }
  })
})
