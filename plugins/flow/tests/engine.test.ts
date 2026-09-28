import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FlowDocument, FlowNode, RunEvent } from '../src/spec/types.ts'
import { FlowStore } from '../src/host/store/flow-store.ts'
import { RunStore } from '../src/host/store/run-store.ts'
import { FlowEngine, InputValidationError, type EngineConfig } from '../src/host/engine/engine.ts'
import { FlowValidationError } from '../src/host/engine/compile.ts'

const baseConfig: EngineConfig = {
  maxConcurrentNodes: 8,
  maxNodeExecutionsPerRun: 100,
  maxLlmCallsPerRun: 10,
  maxAgentNodesPerRun: 10,
  maxRunDurationMs: 60_000,
  maxNodeTimeoutMs: 60_000,
  maxNestingDepth: 5,
  maxLoopIterations: 100,
  maxBatchItems: 100,
  maxBatchConcurrency: 10,
  maxRegexInputChars: 100_000,
  maxRetries: 5,
  code: { timeoutMs: 30_000, sandboxMode: 'read-only' },
  http: { timeoutMs: 30_000, maxResponseBytes: 2_000_000, maxRedirects: 5, allowPrivateNetwork: false, allowedHosts: [] },
  recordValueChars: 20_000,
  maxValueBytes: 4_000_000,
  maxRunEventsBytes: 8_000_000,
  keepRunsPerFlow: 50,
  archiveRunSessions: false,
  agent: { provider: 'spawn' },
  tools: { prefix: 'flow_' },
}

let dir: string
let flowStore: FlowStore
let runStore: RunStore
const events: RunEvent[] = []

function fakeCtx(workspacePath: string): never {
  return {
    logger: { warn: () => {}, debug: () => {} },
    get: () => undefined,
    tools: { schemas: () => [], execute: async () => ({ isError: false, value: null, content: [] }) },
    agents: { roots: () => [] },
    workspaceRegistry: { get: (id: string) => id === 'ws' ? { path: workspacePath } : undefined },
    llm: { stream: async function* () {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: workspacePath }) },
  } as never
}

function engine(config: Partial<EngineConfig> = {}): FlowEngine {
  return new FlowEngine(fakeCtx(dir), flowStore, runStore, { ...baseConfig, ...config })
}

const node = (value: Record<string, unknown>): FlowNode => ({ position: { x: 0, y: 0 }, ...value }) as never

function saveFlow(id: string, nodes: FlowNode[], edges: FlowDocument['edges']): void {
  const doc: FlowDocument = { schemaVersion: 1, id, name: id, description: '', nodes, edges, revision: 1, updatedAt: Date.now() }
  fs.writeFileSync(path.join(dir, 'flows', `${id}.json`), JSON.stringify(doc))
  fs.writeFileSync(path.join(dir, 'flows', `${id}.meta.json`), JSON.stringify({ createdAt: Date.now() }))
}

const start = (fields: unknown[] = []): FlowNode => node({ id: 'start', type: 'start', title: 'Start', data: { fields } })
const end = (inputs: unknown[] = []): FlowNode => node({ id: 'end', type: 'end', title: 'End', data: { mode: 'variables', inputs } })
const text = (id: string, template: string, inputs: unknown[] = []): FlowNode => node({ id, type: 'text', title: id, data: { op: 'concat', inputs, template } })
const edge = (id: string, source: string, target: string, sourceHandle = 'next'): FlowDocument['edges'][number] => ({ id, source, sourceHandle, target })

async function collect(e: FlowEngine, runId: string): Promise<RunEvent[]> {
  const out: RunEvent[] = []
  const reader = e.eventsStream(runId, 0, new AbortController().signal).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    for (const line of buffer.split('\n').slice(0, -1)) {
      const parsed = JSON.parse(line) as RunEvent | { type: 'ping' }
      if (parsed.type !== 'ping') out.push(parsed as RunEvent)
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
  }
  return out
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-engine-'))
  flowStore = new FlowStore({ storageDir: dir, maxFlowBytes: 1_000_000 })
  runStore = new RunStore({ storageDir: dir, maxRunEventsBytes: 1_000_000, keepRunsPerFlow: 50 })
  events.length = 0
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('FlowEngine', () => {
  it('runs start -> text -> end with the production executors and emits one run.finished with the next seq', async () => {
    saveFlow('f1', [
      start([{ name: 'who', schema: { type: 'string' }, required: true }]),
      text('t', 'hi {{who}}', [{ name: 'who', schema: { type: 'string' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['who'] } }]),
      end([{ name: 'greeting', schema: { type: 'string' }, value: { kind: 'ref', node: 't', source: 'output', path: ['text'] } }]),
    ], [edge('e1', 'start', 't'), edge('e2', 't', 'end')])
    const e = engine()
    const { runId } = await e.start({ flowId: 'f1', version: 'draft', inputs: { who: 'ada' }, workspaceId: 'ws' })
    const summary = await e.awaitRun(runId)
    expect(summary?.status).toBe('succeeded')
    expect(summary?.outputs).toEqual({ greeting: 'hi ada' })
    const stored = await collect(e, runId)
    const finished = stored.filter(event => event.type === 'run.finished')
    expect(finished).toHaveLength(1)
    for (let i = 1; i < stored.length; i++) expect(stored[i]!.seq).toBeGreaterThan(stored[i - 1]!.seq)
  })

  it('rejects an invalid flow before creating a run', async () => {
    saveFlow('bad', [start()], [])
    const e = engine()
    await expect(e.start({ flowId: 'bad', version: 'draft', inputs: {}, workspaceId: 'ws' })).rejects.toBeInstanceOf(FlowValidationError)
    expect(runStore.list('bad')).toHaveLength(0)
  })

  it('accepts a missing optional start field and rejects a missing required one', async () => {
    saveFlow('opt', [
      start([{ name: 'a', schema: { type: 'string' } }, { name: 'b', schema: { type: 'string' }, required: true }]),
      end(),
    ], [edge('e1', 'start', 'end')])
    const e = engine()
    const { runId } = await e.start({ flowId: 'opt', version: 'draft', inputs: { b: 'x' }, workspaceId: 'ws' })
    expect((await e.awaitRun(runId))?.status).toBe('succeeded')
    await expect(e.start({ flowId: 'opt', version: 'draft', inputs: {}, workspaceId: 'ws' })).rejects.toBeInstanceOf(InputValidationError)
  })

  it('fails the run with BUDGET_EXCEEDED instead of hanging when node executions run out', async () => {
    saveFlow('budget', [start(), text('a', 'a'), text('b', 'b'), end()], [edge('e1', 'start', 'a'), edge('e2', 'a', 'b'), edge('e3', 'b', 'end')])
    const e = engine({ maxNodeExecutionsPerRun: 1 })
    const { runId } = await e.start({ flowId: 'budget', version: 'draft', inputs: {}, workspaceId: 'ws' })
    const summary = await e.awaitRun(runId)
    expect(summary?.status).toBe('failed')
    expect(summary?.error?.code).toBe('BUDGET_EXCEEDED')
  })

  it('fails the run with RUN_TIMEOUT when it outlives maxRunDurationMs', async () => {
    saveFlow('slow', [
      start(),
      node({ id: 'q', type: 'question', title: 'Q', data: { inputs: [], question: 'wait', answer: { kind: 'text' } } }),
      end(),
    ], [edge('e1', 'start', 'q'), edge('e2', 'q', 'end')])
    const e = engine({ maxRunDurationMs: 50 })
    const { runId } = await e.start({ flowId: 'slow', version: 'draft', inputs: {}, workspaceId: 'ws' })
    const summary = await e.awaitRun(runId)
    expect(summary?.status).toBe('failed')
    expect(summary?.error?.code).toBe('RUN_TIMEOUT')
  })

  it('reports a user cancel as cancelled and answers a waiting question', async () => {
    saveFlow('ask', [
      start(),
      node({ id: 'q', type: 'question', title: 'Q', data: { inputs: [], question: 'name?', answer: { kind: 'text' } } }),
      end([{ name: 'answer', schema: { type: 'string' }, value: { kind: 'ref', node: 'q', source: 'output', path: ['answer'] } }]),
    ], [edge('e1', 'start', 'q'), edge('e2', 'q', 'end')])
    const e = engine()
    const cancelled = await e.start({ flowId: 'ask', version: 'draft', inputs: {}, workspaceId: 'ws' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(runStore.get(cancelled.runId)?.status).toBe('waiting')
    await e.cancel(cancelled.runId)
    expect((await e.awaitRun(cancelled.runId))?.status).toBe('cancelled')

    const answered = await e.start({ flowId: 'ask', version: 'draft', inputs: {}, workspaceId: 'ws' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(await e.answer(answered.runId, 'q', { optionId: 'nope' })).toBe('invalid')
    expect(await e.answer(answered.runId, 'q', { text: 'ada' })).toBe('ok')
    const summary = await e.awaitRun(answered.runId)
    expect(summary?.status).toBe('succeeded')
    expect(summary?.outputs).toEqual({ answer: 'ada' })
  })

  it('runs a subflow (with a loop inside) without leaking nested run.* events', async () => {
    saveFlow('child', [
      start([{ name: 'n', schema: { type: 'integer' }, required: true }]),
      node({ id: 'loop', type: 'loop', title: 'L', data: { mode: 'count', count: { kind: 'ref', node: 'start', source: 'output', path: ['n'] }, maxIterations: 10, variables: [], outputs: [{ name: 'texts', value: { kind: 'ref', node: 'inner', source: 'output', path: ['text'] } }] } }),
      node({ id: 'inner', type: 'text', title: 'I', parentId: 'loop', data: { op: 'concat', inputs: [{ name: 'i', schema: { type: 'integer' }, value: { kind: 'ref', node: 'loop', source: 'inner', path: ['index'] } }], template: 'x{{i}}' } }),
      end([{ name: 'texts', schema: { type: 'array' }, value: { kind: 'ref', node: 'loop', source: 'output', path: ['texts'] } }]),
    ], [edge('e1', 'start', 'loop'), edge('e2', 'loop', 'inner', 'body'), edge('e3', 'loop', 'end')])
    saveFlow('parent', [
      start(),
      node({ id: 'sub', type: 'subflow', title: 'Sub', data: { flowId: 'child', version: 'draft', inputs: [{ name: 'n', schema: { type: 'integer' }, value: { kind: 'literal', value: 2 } }] } }),
      end([{ name: 'texts', schema: { type: 'array' }, value: { kind: 'ref', node: 'sub', source: 'output', path: ['texts'] } }]),
    ], [edge('e1', 'start', 'sub'), edge('e2', 'sub', 'end')])
    const e = engine()
    const { runId } = await e.start({ flowId: 'parent', version: 'draft', inputs: {}, workspaceId: 'ws' })
    const summary = await e.awaitRun(runId)
    expect(summary?.status).toBe('succeeded')
    expect(summary?.outputs).toEqual({ texts: ['x0', 'x1'] })
    const stored = await collect(e, runId)
    expect(stored.filter(event => event.type === 'run.started')).toHaveLength(1)
    expect(stored.filter(event => event.type === 'run.finished')).toHaveLength(1)
    const keys = stored.filter(event => event.type === 'node.finished').map(event => event.type === 'node.finished' ? event.execKey : '')
    expect(keys).toContain('sub/loop#0/inner')
    expect(keys).toContain('sub/loop#1/inner')
    expect(keys).toContain('sub/end')
  })

  it('reports a missing optional service as SERVICE_UNAVAILABLE before the run starts', async () => {
    saveFlow('code', [
      start(),
      node({ id: 'c', type: 'code', title: 'C', data: { language: 'typescript', inputs: [], code: 'async function main() { return {} }', outputs: [] } }),
      end(),
    ], [edge('e1', 'start', 'c'), edge('e2', 'c', 'end')])
    const error = await engine().start({ flowId: 'code', version: 'draft', inputs: {}, workspaceId: 'ws' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FlowValidationError)
    expect((error as FlowValidationError).issues.map(issue => issue.code)).toEqual(['SERVICE_UNAVAILABLE'])
    expect(runStore.list('code')).toHaveLength(0)
  })

  it('rejects a recursive subflow at validation', async () => {
    saveFlow('rec', [
      start(),
      node({ id: 'sub', type: 'subflow', title: 'Sub', data: { flowId: 'rec', version: 'draft', inputs: [] } }),
      end(),
    ], [edge('e1', 'start', 'sub'), edge('e2', 'sub', 'end')])
    const e = engine()
    const error = await e.start({ flowId: 'rec', version: 'draft', inputs: {}, workspaceId: 'ws' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FlowValidationError)
    expect((error as FlowValidationError).issues.map(issue => issue.code)).toContain('SUBFLOW_RECURSION')
  })

  it('streams a live run without dropping events when the reader is slow', async () => {
    saveFlow('many', [
      start(),
      ...Array.from({ length: 20 }, (_, i) => text(`t${i}`, `v${i}`)),
      end(),
    ], [
      edge('e0', 'start', 't0'),
      ...Array.from({ length: 19 }, (_, i) => edge(`e${i + 1}`, `t${i}`, `t${i + 1}`)),
      edge('eend', 't19', 'end'),
    ])
    const e = engine()
    const { runId } = await e.start({ flowId: 'many', version: 'draft', inputs: {}, workspaceId: 'ws' })
    const stream = e.eventsStream(runId, 0, new AbortController().signal)
    await e.awaitRun(runId)
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let body = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      body += decoder.decode(value, { stream: true })
    }
    const finishedNodes = body.split('\n').filter(line => line.includes('"node.finished"'))
    expect(finishedNodes).toHaveLength(22)
    expect(body).toContain('"run.finished"')
  })
})
