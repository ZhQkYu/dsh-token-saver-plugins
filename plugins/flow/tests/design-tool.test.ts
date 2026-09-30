import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FlowNode } from '../src/spec/types.ts'
import { debugInputsOf, isDebuggable } from '../src/spec/debug.ts'
import { FlowStore } from '../src/host/store/flow-store.ts'
import { RunStore } from '../src/host/store/run-store.ts'
import { FlowEngine, type EngineConfig } from '../src/host/engine/engine.ts'
import { registerDesignTool } from '../src/host/design-tool.ts'

const config: EngineConfig = {
  maxConcurrentNodes: 8, maxNodeExecutionsPerRun: 100, maxLlmCallsPerRun: 10, maxAgentNodesPerRun: 10,
  maxRunDurationMs: 60_000, maxNodeTimeoutMs: 60_000, maxNestingDepth: 5, maxLoopIterations: 100,
  maxBatchItems: 100, maxBatchConcurrency: 10, maxRegexInputChars: 100_000, maxRetries: 5,
  code: { timeoutMs: 30_000, sandboxMode: 'read-only' },
  http: { timeoutMs: 30_000, maxResponseBytes: 2_000_000, maxRedirects: 5, allowPrivateNetwork: false, allowedHosts: [] },
  recordValueChars: 20_000, maxValueBytes: 4_000_000, maxRunEventsBytes: 8_000_000, keepRunsPerFlow: 50,
  archiveRunSessions: false, agent: { provider: 'spawn' }, tools: { prefix: 'flow_' },
}

let dir: string
let flowStore: FlowStore
let runStore: RunStore
let engine: FlowEngine
let call: (args: Record<string, unknown>) => Promise<string>

const concat = (bindings: unknown[], template: string): FlowNode => ({ id: 'greet', type: 'text', title: 'Greet', position: { x: 0, y: 0 }, data: { op: 'concat', inputs: bindings, template } }) as never
const ref = (node: string, ...pathSegments: string[]): unknown => ({ kind: 'ref', node, source: 'output', path: pathSegments })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-design-'))
  flowStore = new FlowStore({ storageDir: dir, maxFlowBytes: 1_000_000 })
  runStore = new RunStore({ storageDir: dir, maxRunEventsBytes: 1_000_000, keepRunsPerFlow: 50 })
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    get: () => undefined,
    tools: { schemas: () => [], get: () => undefined, register: (tool: { execute: (args: unknown, exec: unknown) => Promise<{ text: string }> }) => {
      call = async args => (await tool.execute(args, { agent: { session: { header: { cwd: dir } } }, signal: new AbortController().signal })).text
      return () => {}
    } },
    agents: { roots: () => [] },
    workspaceRegistry: { get: () => undefined },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: dir }) },
  } as never
  engine = new FlowEngine(ctx, flowStore, runStore, config)
  const toolCatalog = { refresh: async () => {}, schemas: () => [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }], outputSchema: () => undefined, names: () => new Set(['read']) }
  registerDesignTool(ctx, { flowStore, runStore, engine, toolCatalog: toolCatalog as never, toolPrefix: 'flow_', limits: () => ({}) })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('debug inputs', () => {
  it('lists literal defaults and the upstream reference each input replaces', () => {
    const node = concat([
      { name: 'who', schema: { type: 'string' }, value: ref('start', 'user', 'name') },
      { name: 'greeting', schema: { type: 'string' }, value: { kind: 'literal', value: 'hi' } },
    ], '{{greeting}} {{who}}')
    expect(debugInputsOf(node)).toEqual([
      { name: 'who', schema: { type: 'string' }, required: true, ref: 'start.user.name' },
      { name: 'greeting', schema: { type: 'string' }, required: true, literal: 'hi' },
    ])
    expect(isDebuggable(node)).toBe(true)
    expect(isDebuggable({ ...node, type: 'loop' } as never)).toBe(false)
  })
})

describe('flow_design', () => {
  it('creates, saves a position-less flow with auto layout, and reports validation issues', async () => {
    const created = await call({ action: 'create', name: 'Greeter' })
    const flowId = /Created flow (\S+)/.exec(created)?.[1] as string
    const flow = {
      name: 'Greeter',
      nodes: [
        { id: 'start', type: 'start', title: 'Start', data: { fields: [{ name: 'who', schema: { type: 'string' }, required: true }] } },
        { id: 'greet', type: 'text', title: 'Greet', data: { op: 'concat', inputs: [{ name: 'who', schema: { type: 'string' }, value: ref('start', 'who') }], template: 'hi {{who}} {{missing}}' } },
        { id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'text', schema: { type: 'string' }, value: ref('greet', 'text') }] } },
      ],
      edges: [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'greet' }, { id: 'e2', source: 'greet', sourceHandle: 'next', target: 'end' }],
    }
    const saved = await call({ action: 'save', flowId, flow })
    expect(saved).toContain('TEMPLATE_UNKNOWN_VAR node=greet')
    const stored = flowStore.get(flowId)
    expect(stored?.nodes.map(node => node.position.x)).toEqual([0, 300, 600])

    await call({ action: 'save', flowId, flow: { ...flow, nodes: flow.nodes.map(node => node.id === 'greet' ? { ...node, data: { ...node.data, template: 'hi {{who}}' } } : node) } })
    const trace = await call({ action: 'test', flowId, inputs: { who: 'ada' } })
    expect(trace).toMatch(/: succeeded/)
    expect(trace).toContain('Outputs: {"text":"hi ada"}')
  })

  it('rejects a malformed document with the field path', async () => {
    const created = await call({ action: 'create', name: 'Bad' })
    const flowId = /Created flow (\S+)/.exec(created)?.[1] as string
    await expect(call({ action: 'save', flowId, flow: { nodes: [{ id: 'x', type: 'text', title: 'X', data: { op: 'concat' } }] } })).rejects.toThrow(/nodes\.0/)
  })

  it('debugs one node with sample inputs replacing upstream references and keeping literals', async () => {
    const created = await call({ action: 'create', name: 'Debug' })
    const flowId = /Created flow (\S+)/.exec(created)?.[1] as string
    const doc = flowStore.get(flowId)!
    const node = concat([
      { name: 'who', schema: { type: 'string' }, value: ref(`${flowId}-start`, 'who') },
      { name: 'greeting', schema: { type: 'string' }, value: { kind: 'literal', value: 'hello' } },
    ], '{{greeting}} {{who}}')
    await flowStore.save({ ...doc, nodes: [...doc.nodes, node] }, doc.revision)
    const trace = await call({ action: 'debug_node', flowId, nodeId: 'greet', inputs: { who: 'bob' } })
    expect(trace).toContain('out: {"text":"hello bob"}')
    await expect(call({ action: 'debug_node', flowId, nodeId: 'greet', inputs: {} })).rejects.toThrow(/who: string \(required\) \(from/)
  })

  it('returns when a test run pauses at a question, then answers it and deletes the draft', async () => {
    const created = await call({ action: 'create', name: 'Ask' })
    const flowId = /Created flow (\S+)/.exec(created)?.[1] as string
    const flow = {
      name: 'Ask',
      nodes: [
        { id: 'start', type: 'start', title: 'Start', data: { fields: [] } },
        { id: 'q', type: 'question', title: 'Q', data: { inputs: [], question: 'name?', answer: { kind: 'text' } } },
        { id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs: [{ name: 'answer', schema: { type: 'string' }, value: ref('q', 'answer') }] } },
      ],
      edges: [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'q' }, { id: 'e2', source: 'q', sourceHandle: 'next', target: 'end' }],
    }
    await call({ action: 'save', flowId, flow })
    const paused = await call({ action: 'test', flowId, inputs: {} })
    expect(paused).toContain('paused at a question (execKey q): "name?"')
    const runId = /Run (\S+):/.exec(paused)?.[1] as string
    const done = await call({ action: 'answer', runId, execKey: 'q', answer: { text: 'ada' } })
    expect(done).toMatch(/: succeeded/)
    expect(done).toContain('Outputs: {"answer":"ada"}')
    expect(await call({ action: 'delete', flowId })).toContain('Deleted')
    expect(flowStore.get(flowId)).toBeUndefined()
  })

  it('lists catalog tools with their argument types', async () => {
    expect(await call({ action: 'catalog' })).toContain('- read(file_path: string)')
    expect(await call({ action: 'reference', nodeType: 'condition' })).toContain('ports: else')
  })
})
