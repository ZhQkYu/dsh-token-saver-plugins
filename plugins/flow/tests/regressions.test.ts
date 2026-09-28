import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FlowDocument, FlowNode, JsonValue, RunEvent } from '../src/spec/types.ts'
import { NODE_SPECS } from '../src/spec/nodes/index.ts'
import { NODE_TYPES } from '../src/spec/types.ts'
import { coerce } from '../src/spec/coerce.ts'
import { validateFlow } from '../src/spec/validate.ts'
import { compile } from '../src/host/engine/compile.ts'
import { runContainerFrame, runFlow, Semaphore, type RunContext } from '../src/host/engine/scheduler.ts'
import { NodeError, RunBudget } from '../src/host/engine/budget.ts'
import { EXECUTORS, buildExecutors } from '../src/host/executors/registry.ts'
import type { ExecContext, FlowServices, NodeExecutor } from '../src/host/executors/index.ts'
import { createGuardedFetch, isPublicIpAddress } from '../src/host/services/guarded-fetch.ts'

const limits = {
  maxLoopIterations: 100, maxBatchConcurrency: 10, maxBatchItems: 100, maxNodeTimeoutMs: 60_000, maxRetries: 5,
  maxNestingDepth: 5, maxRegexInputChars: 100_000, maxConcurrentNodes: 8, maxNodeExecutionsPerRun: 1000,
  maxLlmCallsPerRun: 100, maxAgentNodesPerRun: 100, maxRunDurationMs: 60_000,
  code: { timeoutMs: 30_000, sandboxMode: 'read-only' as const },
  http: { timeoutMs: 30_000, maxResponseBytes: 2_000_000, maxRedirects: 5, allowPrivateNetwork: false, allowedHosts: [] },
  recordValueChars: 20_000, maxValueBytes: 4_000_000, maxRunEventsBytes: 8_000_000, keepRunsPerFlow: 50, archiveRunSessions: false,
}

const n = (value: Record<string, unknown>): FlowNode => ({ position: { x: 0, y: 0 }, ...value }) as never
const doc = (nodes: FlowNode[], edges: FlowDocument['edges']): FlowDocument => ({ schemaVersion: 1, id: 'f', name: 'f', description: '', nodes, edges, revision: 1, updatedAt: 0 })
const e = (id: string, source: string, target: string, sourceHandle = 'next'): FlowDocument['edges'][number] => ({ id, source, sourceHandle, target })
const start = n({ id: 'start', type: 'start', title: 'S', data: { fields: [] } })
const end = n({ id: 'end', type: 'end', title: 'E', data: { mode: 'variables', inputs: [] } })
const text = (id: string, extra: Record<string, unknown> = {}): FlowNode => n({ id, type: 'text', title: id, data: { op: 'concat', inputs: [], template: id }, ...extra })

function context(d: FlowDocument, overrides: { executors?: Record<string, NodeExecutor>; maxConcurrent?: number } = {}): { ctx: RunContext; events: RunEvent[] } {
  const events: RunEvent[] = []
  const plan = compile(d, () => undefined, limits)
  const controller = new AbortController()
  const services: FlowServices = {
    llm: { stream: async function* () {} },
    tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
    defaultModel: () => ({ provider: 'p', model: 'm' }),
    sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: '/tmp' }) },
  }
  const ctx: RunContext = {
    runId: 'r', workspacePath: '/tmp',
    budget: new RunBudget({ maxNodeExecutions: 1000, maxLlmCalls: 10, maxAgentNodes: 10, maxRunDurationMs: 60_000 }),
    semaphore: new Semaphore(overrides.maxConcurrent ?? 8),
    services, interaction: { ask: async () => ({}) }, agent: async () => ({ kind: 'run-session', agent: {} as never }),
    emitter: { seq: 1, emit: event => { events.push(event) } },
    executors: { ...buildExecutors(), ...overrides.executors },
    plan, limits, signal: controller.signal,
    abortRun: reason => { controller.abort(reason) },
    runSubflow: async () => ({}),
    runContainer: (id, inner, index, parent, stack, signal) => runContainerFrame(parent.plan, id, inner, [...parent.path, { node: id, index }], parent, ctx, stack, signal),
    nextCallId: () => 'c',
  }
  return { ctx, events }
}

const finishedOf = (events: RunEvent[], nodeId: string): Extract<RunEvent, { type: 'node.finished' }>[] =>
  events.filter((event): event is Extract<RunEvent, { type: 'node.finished' }> => event.type === 'node.finished' && event.nodeId === nodeId)

describe('review regressions', () => {
  it('every executable node type except start has a production executor', () => {
    const missing = NODE_TYPES.filter(type => type !== 'start' && NODE_SPECS[type].executable && EXECUTORS[type] === undefined)
    expect(missing).toEqual([])
  })

  it('container execKeys carry the round index', async () => {
    const d = doc([
      start,
      n({ id: 'loop', type: 'loop', title: 'L', data: { mode: 'count', count: { kind: 'literal', value: 3 }, maxIterations: 5, variables: [], outputs: [] } }),
      n({ id: 'm', type: 'message', title: 'M', parentId: 'loop', data: { inputs: [], template: 'hi' } }),
      end,
    ], [e('e1', 'start', 'loop'), e('e2', 'loop', 'm', 'body'), e('e3', 'loop', 'end')])
    const { ctx, events } = context(d)
    expect((await runFlow(ctx.plan, {}, ctx, [], ['f'])).status).toBe('succeeded')
    expect(finishedOf(events, 'm').map(event => event.execKey)).toEqual(['loop#0/m', 'loop#1/m', 'loop#2/m'])
  })

  it('coerce never mutates its input', () => {
    const upstream = { x: '5', nested: { y: '1' } }
    coerce(upstream, { type: 'object', properties: [{ name: 'x', schema: { type: 'number' } }, { name: 'nested', schema: { type: 'object', properties: [{ name: 'y', schema: { type: 'integer' } }] } }] })
    expect(upstream).toEqual({ x: '5', nested: { y: '1' } })
  })

  it('reports number -> integer as a warning and an unreachable end as an error', () => {
    const nodes = [
      n({ id: 'start', type: 'start', title: 'S', data: { fields: [{ name: 'x', schema: { type: 'number' } }] } }),
      n({ id: 'end', type: 'end', title: 'E', data: { mode: 'variables', inputs: [{ name: 'y', schema: { type: 'integer' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['x'] } }] } }),
    ]
    const connected = validateFlow(doc(nodes, [e('e1', 'start', 'end')]), () => undefined)
    expect(connected.find(issue => issue.code === 'TYPE_MISMATCH')?.severity).toBe('warning')
    expect(connected.find(issue => issue.code === 'TYPE_MISMATCH')?.field).toBe('inputs.0.value')
    const disconnected = validateFlow(doc(nodes, []), () => undefined)
    expect(disconnected.find(issue => issue.code === 'END_UNREACHABLE')?.severity).toBe('error')
  })

  it('a node timeout aborts the executor signal before the retry starts', async () => {
    const signals: AbortSignal[] = []
    const slow: NodeExecutor = {
      type: 'text',
      execute: async (_node: FlowNode, _inputs: Record<string, JsonValue>, exec: ExecContext) => {
        signals.push(exec.signal)
        await new Promise(resolve => setTimeout(resolve, 200))
        return { outputs: { text: 'late' } }
      },
    } as never
    const d = doc([start, text('t', { onError: { onError: 'fail', timeoutMs: 20, retries: 1 } }), end], [e('e1', 'start', 't'), e('e2', 't', 'end')])
    const { ctx, events } = context(d, { executors: { text: slow } })
    const result = await runFlow(ctx.plan, {}, ctx, [], ['f'])
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('NODE_TIMEOUT')
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(finishedOf(events, 't')[0]?.attempt).toBe(1)
  })

  it('onError=fail cancels a running sibling', async () => {
    let siblingSignal: AbortSignal | undefined
    const executors: Record<string, NodeExecutor> = {
      text: {
        type: 'text',
        execute: async (node: FlowNode, _inputs: Record<string, JsonValue>, exec: ExecContext) => {
          if (node.id === 'bad') throw new NodeError('BOOM', 'boom')
          siblingSignal = exec.signal
          await new Promise((_, reject) => exec.signal.addEventListener('abort', () => reject(exec.signal.reason)))
          return { outputs: {} }
        },
      } as never,
    }
    const d = doc([start, text('bad'), text('slow'), end], [e('e1', 'start', 'bad'), e('e2', 'start', 'slow'), e('e3', 'bad', 'end'), e('e4', 'slow', 'end')])
    const { ctx, events } = context(d, { executors })
    const result = await runFlow(ctx.plan, {}, ctx, [], ['f'])
    expect(result.error?.code).toBe('BOOM')
    expect(siblingSignal?.aborted).toBe(true)
    expect(finishedOf(events, 'slow')[0]?.status).toBe('cancelled')
    expect(finishedOf(events, 'end')[0]?.status).toBe('cancelled')
  })

  it('maxConcurrentNodes=1 bounds leaf concurrency and does not deadlock a loop', async () => {
    let active = 0
    let peak = 0
    const counting: NodeExecutor = {
      type: 'text',
      execute: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        return { outputs: { text: 'x' } }
      },
    } as never
    const d = doc([
      start, text('a'), text('b'),
      n({ id: 'loop', type: 'loop', title: 'L', data: { mode: 'count', count: { kind: 'literal', value: 2 }, maxIterations: 5, variables: [], outputs: [] } }),
      text('inner', { parentId: 'loop' }),
      end,
    ], [e('e1', 'start', 'a'), e('e2', 'start', 'b'), e('e3', 'start', 'loop'), e('e4', 'loop', 'inner', 'body'), e('e5', 'a', 'end'), e('e6', 'b', 'end'), e('e7', 'loop', 'end')])
    const { ctx } = context(d, { executors: { text: counting }, maxConcurrent: 1 })
    expect((await runFlow(ctx.plan, {}, ctx, [], ['f'])).status).toBe('succeeded')
    expect(peak).toBe(1)
  })

  it('an independent branch does not wait for a slow sibling', async () => {
    const order: string[] = []
    const executors: Record<string, NodeExecutor> = {
      text: {
        type: 'text',
        execute: async (node: FlowNode) => {
          if (node.id === 'slow') await new Promise(resolve => setTimeout(resolve, 50))
          order.push(node.id)
          return { outputs: {} }
        },
      } as never,
    }
    const d = doc([start, text('fast'), text('next'), text('slow'), end], [e('e1', 'start', 'fast'), e('e2', 'fast', 'next'), e('e3', 'start', 'slow'), e('e4', 'next', 'end'), e('e5', 'slow', 'end')])
    const { ctx } = context(d, { executors })
    await runFlow(ctx.plan, {}, ctx, [], ['f'])
    expect(order.indexOf('next')).toBeLessThan(order.indexOf('slow'))
  })

  it('batch fails fast with the first item error code and aborts the rest', async () => {
    const aborted: boolean[] = []
    const executors: Record<string, NodeExecutor> = {
      text: {
        type: 'text',
        execute: async (_node: FlowNode, _inputs: Record<string, JsonValue>, exec: ExecContext) => {
          const index = exec.frame.inner?.['index']
          if (index === 0) throw new NodeError('ITEM_BAD', 'bad item')
          await new Promise(resolve => setTimeout(resolve, 30))
          aborted.push(exec.signal.aborted)
          return { outputs: {} }
        },
      } as never,
    }
    const d = doc([
      start,
      n({ id: 'batch', type: 'batch', title: 'B', data: { array: { kind: 'literal', value: [0, 1, 2] }, concurrency: 3, maxItems: 10, outputs: [] } }),
      text('item', { parentId: 'batch' }),
      end,
    ], [e('e1', 'start', 'batch'), e('e2', 'batch', 'item', 'body'), e('e3', 'batch', 'end')])
    const { ctx } = context(d, { executors })
    const result = await runFlow(ctx.plan, {}, ctx, [], ['f'])
    expect(result.error?.code).toBe('ITEM_BAD')
    expect(aborted.every(value => value)).toBe(true)
  })

  it('break lets running body nodes finish and skips the pending ones', async () => {
    const executors: Record<string, NodeExecutor> = {
      text: {
        type: 'text',
        execute: async (node: FlowNode) => {
          if (node.id === 'mid') await new Promise(resolve => setTimeout(resolve, 20))
          return { outputs: { text: node.id } }
        },
      } as never,
    }
    const d = doc([
      start,
      n({ id: 'loop', type: 'loop', title: 'L', data: { mode: 'count', count: { kind: 'literal', value: 3 }, maxIterations: 5, variables: [], outputs: [] } }),
      n({ id: 'stop', type: 'break', title: 'B', parentId: 'loop', data: {} }),
      text('mid', { parentId: 'loop' }),
      text('later', { parentId: 'loop' }),
      end,
    ], [e('e1', 'start', 'loop'), e('e2', 'loop', 'stop', 'body'), e('e3', 'loop', 'mid', 'body'), e('e4', 'mid', 'later'), e('e5', 'loop', 'end')])
    const { ctx, events } = context(d, { executors })
    expect((await runFlow(ctx.plan, {}, ctx, [], ['f'])).status).toBe('succeeded')
    expect(finishedOf(events, 'stop')).toHaveLength(1)
    expect(finishedOf(events, 'mid').map(event => event.status)).toEqual(['succeeded'])
    expect(finishedOf(events, 'later').map(event => event.status)).toEqual(['skipped'])
  })

  it('classifies non-unicast addresses as non-public', () => {
    for (const address of ['::', '::1', '::ffff:127.0.0.1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fe80::1', 'fc00::1', '100.64.0.1', '192.0.0.1', '198.18.0.1', '10.0.0.1', '[::1]']) {
      expect(isPublicIpAddress(address), address).toBe(false)
    }
    for (const address of ['8.8.8.8', '2001:4860:4860::8888']) expect(isPublicIpAddress(address), address).toBe(true)
  })

  it('connects through the pinned-address agent (Node autoSelectFamily lookup) and re-resolves every redirect hop', async () => {
    let authOnSecondHop: string | undefined
    const server = http.createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://other.test:${(server.address() as AddressInfo).port}/done` })
        res.end()
        return
      }
      authOnSecondHop = req.headers.authorization
      res.end('{"ok":true}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    const resolved: string[] = []
    const fetcher = createGuardedFetch(
      { timeoutMs: 5000, maxResponseBytes: 10_000, maxRedirects: 3, allowPrivateNetwork: false, allowedHosts: [] },
      { resolver: async (host) => { resolved.push(host); return [{ address: '127.0.0.1', family: 4 }] } },
    )
    try {
      const result = await fetcher(new Request(`http://pinned.test:${port}/start`, { headers: { authorization: 'Bearer secret' } }), { timeoutMs: 5000, maxResponseBytes: 10_000 })
      expect(result.status).toBe(200)
      expect(result.json).toEqual({ ok: true })
      expect(resolved).toEqual(['pinned.test', 'other.test'])
      expect(authOnSecondHop).toBeUndefined()
    } finally {
      server.close()
    }
  })

  it('blocks a private IP literal without resolving it', async () => {
    const fetcher = createGuardedFetch({ timeoutMs: 1000, maxResponseBytes: 1000, allowPrivateNetwork: false, allowedHosts: [] })
    await expect(fetcher(new Request('http://127.0.0.1:9/'), { timeoutMs: 1000, maxResponseBytes: 1000 })).rejects.toThrow(/no public addresses/)
  })

  it('bounds a slow-drip response by the total timeout', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200)
      const timer = setInterval(() => res.write('x'), 20)
      res.on('close', () => clearInterval(timer))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    const fetcher = createGuardedFetch({ timeoutMs: 150, maxResponseBytes: 1_000_000, allowPrivateNetwork: true, allowedHosts: [] })
    const startedAt = Date.now()
    try {
      await expect(fetcher(new Request(`http://127.0.0.1:${port}/`), { timeoutMs: 150, maxResponseBytes: 1_000_000 })).rejects.toBeDefined()
      expect(Date.now() - startedAt).toBeLessThan(2000)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})

describe('validation coverage added in review', () => {
  const codes = (d: FlowDocument, lookup: Parameters<typeof validateFlow>[1] = () => undefined, extra: Parameters<typeof validateFlow>[2] = {}): string[] =>
    validateFlow(d, lookup, extra).map(issue => `${issue.code}:${issue.severity}`)

  it('flags a required literal binding with no value', () => {
    const d = doc([start, n({ id: 'm', type: 'message', title: 'M', data: { inputs: [{ name: 'x', schema: { type: 'string' }, value: { kind: 'literal', value: null } }], template: '{{x}}' } }), end], [e('e1', 'start', 'm'), e('e2', 'm', 'end')])
    expect(codes(d)).toContain('REQUIRED_INPUT:error')
  })

  it('detects subflow recursion and depth through lookup references', () => {
    const sub = (flowId: string): FlowNode => n({ id: 'sub', type: 'subflow', title: 'Sub', data: { flowId, version: 'draft', inputs: [] } })
    const d = doc([start, sub('a'), end], [e('e1', 'start', 'sub'), e('e2', 'sub', 'end')])
    const cyclic = (flowId: string) => ({ inputs: [], outputs: [], subflows: [{ flowId: flowId === 'a' ? 'f' : 'a', version: 'draft' as const }] })
    expect(codes(d, cyclic)).toContain('SUBFLOW_RECURSION:error')
    const chain = (flowId: string) => ({ inputs: [], outputs: [], subflows: flowId.length < 6 ? [{ flowId: `${flowId}a`, version: 'draft' as const }] : [] })
    expect(codes(d, chain, { maxNestingDepth: 2 })).toContain('SUBFLOW_DEPTH:error')
  })

  it('warns about unknown tools only when the catalog is known', () => {
    const d = doc([start, n({ id: 'tool', type: 'tool', title: 'T', data: { tool: 'nope', args: [] } }), end], [e('e1', 'start', 'tool'), e('e2', 'tool', 'end')])
    expect(codes(d)).not.toContain('TOOL_UNKNOWN:warning')
    expect(codes(d, () => undefined, { toolNames: new Set(['read']) })).toContain('TOOL_UNKNOWN:warning')
  })

  it('rejects reserved loop variable names, duplicate edges, root break, and a loop array read from its own body', () => {
    const d = doc([
      start,
      n({ id: 'loop', type: 'loop', title: 'L', data: { mode: 'array', array: { kind: 'ref', node: 'inner', source: 'output', path: ['text'] }, maxIterations: 5, variables: [{ name: 'item', schema: { type: 'any' }, initial: { kind: 'literal', value: 1 } }], outputs: [{ name: 'texts', value: { kind: 'ref', node: 'inner', source: 'output', path: ['text'] } }] } }),
      n({ id: 'inner', type: 'message', title: 'I', parentId: 'loop', data: { inputs: [], template: 'x' } }),
      n({ id: 'stop', type: 'break', title: 'B', data: {} }),
      end,
    ], [e('e1', 'start', 'loop'), e('e2', 'loop', 'inner', 'body'), e('e3', 'loop', 'end'), e('e4', 'loop', 'end')])
    const issues = validateFlow(d, () => undefined)
    expect(issues.some(issue => issue.code === 'BAD_NAME' && issue.field === 'variables.0.name')).toBe(true)
    expect(issues.some(issue => issue.code === 'DUPLICATE_ID' && issue.edgeId === 'e4' && issue.severity === 'warning')).toBe(true)
    expect(issues.some(issue => issue.code === 'BAD_PARENT' && issue.nodeId === 'stop')).toBe(true)
    expect(issues.some(issue => issue.code === 'NOT_ANCESTOR' && issue.field === 'array')).toBe(true)
    expect(issues.some(issue => issue.field === 'outputs.0.value')).toBe(false)
  })
})
