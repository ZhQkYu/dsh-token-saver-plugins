import { describe, expect, it } from 'vitest'
import type { FlowDocument, FlowNode, JsonValue } from '../src/spec/types.ts'
import { compile } from '../src/host/engine/compile.ts'
import { runFlow, runContainerFrame, Semaphore, type RunContext } from '../src/host/engine/scheduler.ts'
import { RunBudget } from '../src/host/engine/budget.ts'
import type { FlowServices, Interaction, NodeExecutor } from '../src/host/executors/index.ts'
import { buildExecutors } from '../src/host/executors/registry.ts'
import { loopExecutor } from '../src/host/executors/loop.ts'
import { batchExecutor } from '../src/host/executors/batch.ts'
import { textExecutor } from '../src/host/executors/text.ts'
import { assignExecutor, breakExecutor } from '../src/host/executors/control.ts'

function node<T extends FlowNode['type']>(partial: Partial<Extract<FlowNode, { type: T }>> & { id: string; type: T; title: string; data: Extract<FlowNode, { type: T }>['data'] }): Extract<FlowNode, { type: T }> {
  return { description: '', position: { x: 0, y: 0 }, ...partial } as Extract<FlowNode, { type: T }>
}

function makeDoc(nodes: FlowNode[], edges: FlowDocument['edges']): FlowDocument {
  return { schemaVersion: 1, id: 'flow-1', name: 'test', description: '', nodes, edges, revision: 1, updatedAt: 0 }
}

const testLimits = {
  maxLoopIterations: 10,
  maxBatchConcurrency: 10,
  maxBatchItems: 10,
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

function buildContext(doc: FlowDocument, extraExecutors: Record<string, NodeExecutor>): { ctx: RunContext; events: import('../src/spec/types.ts').RunEvent[] } {
  const events: import('../src/spec/types.ts').RunEvent[] = []
  const emitter = { seq: 0, emit: (event: import('../src/spec/types.ts').RunEvent) => { events.push(event) } }
  const interaction: Interaction = { ask: async () => ({}) }
  const budget = new RunBudget({ maxNodeExecutions: 100, maxLlmCalls: 100, maxAgentNodes: 100, maxRunDurationMs: 60000 })
  const plan = compile(doc, () => undefined, testLimits)
  const services: FlowServices = {
    llm: { stream: async function* () {} },
    tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
    defaultModel: () => ({ provider: 'test', model: 'test' }),
    sandboxPolicy: { resolve: () => ({}) },
  }
  let ctxRef!: RunContext
  const runController = new AbortController()
  const ctx: RunContext = {
    runId: 'run-1',
    workspacePath: '/tmp',
    budget,
    semaphore: new Semaphore(8),
    services,
    interaction,
    agent: async () => ({ kind: 'run-session', agent: {} as never }),
    emitter,
    executors: { ...buildExecutors(), ...extraExecutors },
    plan,
    limits: testLimits,
    signal: runController.signal,
    abortRun: (reason) => { runController.abort(reason) },
    runSubflow: async () => ({}),
    runContainer: (containerId, inner, index, parentFrame, flowStack, signal) => runContainerFrame(parentFrame.plan, containerId, inner, [...parentFrame.path, { node: containerId, index }], parentFrame, ctxRef, flowStack, signal),
    nextCallId: () => 'call-1',
  }
  ctxRef = ctx
  return { ctx, events }
}

describe('loop executor', () => {
  it('iterates an array mode loop and collects outputs per round', async () => {
    const nodes: FlowNode[] = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'arr', schema: { type: 'array', items: { type: 'string' } } }] } }),
      node({ id: 'loop1', type: 'loop', title: 'Loop', data: { mode: 'array', array: { kind: 'ref', node: 'start', source: 'output', path: ['arr'] }, maxIterations: 5, variables: [], outputs: [{ name: 'collected', value: { kind: 'ref', node: 'text1', source: 'output', path: ['text'] } }] } }),
      node({ id: 'text1', type: 'text', title: 'Echo', parentId: 'loop1', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'loop1', source: 'inner', path: ['item'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'array', items: { type: 'string' } }, value: { kind: 'ref', node: 'loop1', source: 'output', path: ['collected'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'loop1' },
      { id: 'e2', source: 'loop1', sourceHandle: 'next', target: 'end' },
      { id: 'e3', source: 'loop1', sourceHandle: 'body', target: 'text1' },
    ]
    const { ctx } = buildContext(makeDoc(nodes, edges), { loop: loopExecutor, text: textExecutor })
    const result = await runFlow(ctx.plan, { arr: ['a', 'b', 'c'] }, ctx, [], ['flow-1'])
    expect(result.status).toBe('succeeded')
    expect(result.outputs).toEqual({ out: ['a', 'b', 'c'] })
  })

  it('respects count mode and the maxIterations ceiling', async () => {
    const nodes: FlowNode[] = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'n', schema: { type: 'integer' } }] } }),
      node({ id: 'loop1', type: 'loop', title: 'Loop', data: { mode: 'count', count: { kind: 'ref', node: 'start', source: 'output', path: ['n'] }, maxIterations: 3, variables: [], outputs: [{ name: 'collected', value: { kind: 'ref', node: 'text1', source: 'output', path: ['text'] } }] } }),
      node({ id: 'text1', type: 'text', title: 'Idx', parentId: 'loop1', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'integer' }, value: { kind: 'ref', node: 'loop1', source: 'inner', path: ['index'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'array', items: { type: 'string' } }, value: { kind: 'ref', node: 'loop1', source: 'output', path: ['collected'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'loop1' },
      { id: 'e2', source: 'loop1', sourceHandle: 'next', target: 'end' },
      { id: 'e3', source: 'loop1', sourceHandle: 'body', target: 'text1' },
    ]
    const { ctx } = buildContext(makeDoc(nodes, edges), { loop: loopExecutor, text: textExecutor })
    // n=5 but maxIterations=3 -> only 3 rounds.
    const result = await runFlow(ctx.plan, { n: 5 }, ctx, [], ['flow-1'])
    expect(result.status).toBe('succeeded')
    expect(result.outputs).toEqual({ out: ['0', '1', '2'] })
  })

  it('fails with LOOP_LIMIT when an array exceeds maxIterations', async () => {
    const nodes: FlowNode[] = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'arr', schema: { type: 'array', items: { type: 'string' } } }] } }),
      node({ id: 'loop1', type: 'loop', title: 'Loop', data: { mode: 'array', array: { kind: 'ref', node: 'start', source: 'output', path: ['arr'] }, maxIterations: 2, variables: [], outputs: [] } }),
      node({ id: 'text1', type: 'text', title: 'Echo', parentId: 'loop1', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'loop1', source: 'inner', path: ['item'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'loop1' },
      { id: 'e2', source: 'loop1', sourceHandle: 'next', target: 'end' },
      { id: 'e3', source: 'loop1', sourceHandle: 'body', target: 'text1' },
    ]
    const { ctx } = buildContext(makeDoc(nodes, edges), { loop: loopExecutor, text: textExecutor })
    const result = await runFlow(ctx.plan, { arr: ['a', 'b', 'c'] }, ctx, [], ['flow-1'])
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('LOOP_LIMIT')
  })

  it('break stops the loop early', async () => {
    const nodes: FlowNode[] = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'arr', schema: { type: 'array', items: { type: 'string' } } }] } }),
      node({ id: 'loop1', type: 'loop', title: 'Loop', data: { mode: 'array', array: { kind: 'ref', node: 'start', source: 'output', path: ['arr'] }, maxIterations: 5, variables: [], outputs: [{ name: 'collected', value: { kind: 'ref', node: 'text1', source: 'output', path: ['text'] } }] } }),
      node({ id: 'text1', type: 'text', title: 'Echo', parentId: 'loop1', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'loop1', source: 'inner', path: ['item'] } }], template: '{{t}}' } }),
      node({ id: 'brk', type: 'break', title: 'Break', parentId: 'loop1', data: {} }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'array', items: { type: 'string' } }, value: { kind: 'ref', node: 'loop1', source: 'output', path: ['collected'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'loop1' },
      { id: 'e2', source: 'loop1', sourceHandle: 'next', target: 'end' },
      { id: 'e3', source: 'loop1', sourceHandle: 'body', target: 'text1' },
      { id: 'e4', source: 'text1', sourceHandle: 'next', target: 'brk' },
    ]
    const { ctx } = buildContext(makeDoc(nodes, edges), { loop: loopExecutor, text: textExecutor, break: breakExecutor })
    const result = await runFlow(ctx.plan, { arr: ['a', 'b', 'c'] }, ctx, [], ['flow-1'])
    expect(result.status).toBe('succeeded')
    // First round completes, then break fires before round 2.
    expect(result.outputs).toEqual({ out: ['a'] })
  })

  it('assign writes loop variables that persist across rounds', async () => {
    const nodes: FlowNode[] = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'arr', schema: { type: 'array', items: { type: 'string' } } }] } }),
      node({ id: 'loop1', type: 'loop', title: 'Loop', data: { mode: 'array', array: { kind: 'ref', node: 'start', source: 'output', path: ['arr'] }, maxIterations: 3, variables: [{ name: 'acc', schema: { type: 'string' }, initial: { kind: 'literal', value: '' } }], outputs: [] } }),
      node({ id: 'asg', type: 'assign', title: 'Assign', parentId: 'loop1', data: { assignments: [{ variable: 'acc', value: { kind: 'ref', node: 'loop1', source: 'inner', path: ['item'] } }] } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'string' }, value: { kind: 'ref', node: 'loop1', source: 'output', path: ['acc'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'loop1' },
      { id: 'e2', source: 'loop1', sourceHandle: 'next', target: 'end' },
      { id: 'e3', source: 'loop1', sourceHandle: 'body', target: 'asg' },
    ]
    const { ctx } = buildContext(makeDoc(nodes, edges), { loop: loopExecutor, assign: assignExecutor })
    const result = await runFlow(ctx.plan, { arr: ['x', 'y', 'z'] }, ctx, [], ['flow-1'])
    expect(result.status).toBe('succeeded')
    expect(result.outputs).toEqual({ out: 'z' })
  })
})

describe('batch executor', () => {
  it('runs items in parallel and collects outputs by index', async () => {
    const nodes: FlowNode[] = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'arr', schema: { type: 'array', items: { type: 'string' } } }] } }),
      node({ id: 'batch1', type: 'batch', title: 'Batch', data: { array: { kind: 'ref', node: 'start', source: 'output', path: ['arr'] }, concurrency: 2, maxItems: 10, outputs: [{ name: 'collected', value: { kind: 'ref', node: 'text1', source: 'output', path: ['text'] } }] } }),
      node({ id: 'text1', type: 'text', title: 'Echo', parentId: 'batch1', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'batch1', source: 'inner', path: ['item'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'out', schema: { type: 'array', items: { type: 'string' } }, value: { kind: 'ref', node: 'batch1', source: 'output', path: ['collected'] } }] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'batch1' },
      { id: 'e2', source: 'batch1', sourceHandle: 'next', target: 'end' },
      { id: 'e3', source: 'batch1', sourceHandle: 'body', target: 'text1' },
    ]
    const { ctx } = buildContext(makeDoc(nodes, edges), { batch: batchExecutor, text: textExecutor })
    const result = await runFlow(ctx.plan, { arr: ['a', 'b', 'c', 'd'] }, ctx, [], ['flow-1'])
    expect(result.status).toBe('succeeded')
    expect(result.outputs).toEqual({ out: ['a', 'b', 'c', 'd'] })
  })

  it('fails when an item exceeds maxItems', async () => {
    const nodes: FlowNode[] = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'arr', schema: { type: 'array', items: { type: 'string' } } }] } }),
      node({ id: 'batch1', type: 'batch', title: 'Batch', data: { array: { kind: 'ref', node: 'start', source: 'output', path: ['arr'] }, concurrency: 2, maxItems: 2, outputs: [] } }),
      node({ id: 'text1', type: 'text', title: 'Echo', parentId: 'batch1', data: { op: 'concat', inputs: [{ name: 't', schema: { type: 'string' }, value: { kind: 'ref', node: 'batch1', source: 'inner', path: ['item'] } }], template: '{{t}}' } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'batch1' },
      { id: 'e2', source: 'batch1', sourceHandle: 'next', target: 'end' },
      { id: 'e3', source: 'batch1', sourceHandle: 'body', target: 'text1' },
    ]
    const { ctx } = buildContext(makeDoc(nodes, edges), { batch: batchExecutor, text: textExecutor })
    const result = await runFlow(ctx.plan, { arr: ['a', 'b', 'c'] }, ctx, [], ['flow-1'])
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('LOOP_LIMIT')
  })

  it('fails the batch when any item fails', async () => {
    const nodes: FlowNode[] = [
      node({ id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'arr', schema: { type: 'array', items: { type: 'string' } } }] } }),
      node({ id: 'batch1', type: 'batch', title: 'Batch', data: { array: { kind: 'ref', node: 'start', source: 'output', path: ['arr'] }, concurrency: 1, maxItems: 10, outputs: [] } }),
      node({ id: 'cond', type: 'condition', title: 'Cond', parentId: 'batch1', data: { branches: [{ id: 'yes', label: 'yes', logic: 'and', conditions: [{ left: { kind: 'ref', node: 'batch1', source: 'inner', path: ['item'] }, op: 'eq', right: { kind: 'literal', value: 'bad' } }] }] } }),
      node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [] } }),
    ]
    const edges = [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'batch1' },
      { id: 'e2', source: 'batch1', sourceHandle: 'next', target: 'end' },
      { id: 'e3', source: 'batch1', sourceHandle: 'body', target: 'cond' },
    ]
    // A failing body node fails the batch and aborts the remaining items.
    const failingCondition: NodeExecutor = {
      type: 'condition',
      execute: async () => { throw new Error('boom') },
    } as never
    const { ctx } = buildContext(makeDoc(nodes, edges), { batch: batchExecutor, condition: failingCondition })
    const result = await runFlow(ctx.plan, { arr: ['a', 'bad', 'c'] }, ctx, [], ['flow-1'])
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('NODE_ERROR')
  })
})
