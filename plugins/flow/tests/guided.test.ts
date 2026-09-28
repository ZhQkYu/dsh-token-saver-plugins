import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FlowDocument, FlowNode, RunEvent } from '../src/spec/types.ts'
import { compileGuided, flowInterface, guidedPrompt } from '../src/spec/guided.ts'
import { validateFlow } from '../src/spec/validate.ts'
import { FlowStore } from '../src/host/store/flow-store.ts'
import { RunStore } from '../src/host/store/run-store.ts'
import { FlowEngine, RunStartError, type EngineConfig } from '../src/host/engine/engine.ts'
import { GuidedRunError } from '../src/host/engine/guided-runs.ts'
import { registerWorkflowTool } from '../src/host/workflow-tool.ts'

const baseConfig: EngineConfig = {
  maxConcurrentNodes: 8, maxNodeExecutionsPerRun: 100, maxLlmCallsPerRun: 10, maxAgentNodesPerRun: 10, maxRunDurationMs: 60_000,
  maxNodeTimeoutMs: 60_000, maxNestingDepth: 5, maxLoopIterations: 100, maxBatchItems: 100, maxBatchConcurrency: 10,
  maxRegexInputChars: 100_000, maxRetries: 5, code: { timeoutMs: 30_000, sandboxMode: 'read-only' },
  http: { timeoutMs: 30_000, maxResponseBytes: 2_000_000, maxRedirects: 5, allowPrivateNetwork: false, allowedHosts: [] },
  recordValueChars: 20_000, maxValueBytes: 4_000_000, maxRunEventsBytes: 8_000_000, keepRunsPerFlow: 50, archiveRunSessions: false,
  agent: { provider: 'spawn' }, tools: { prefix: 'flow_' },
}

const node = (value: Record<string, unknown>): FlowNode => ({ position: { x: 0, y: 0 }, title: String(value['id']), ...value }) as never
const edge = (id: string, source: string, target: string, sourceHandle = 'next'): FlowDocument['edges'][number] => ({ id, source, sourceHandle, target })
const ref = (nodeId: string, field: string, source: 'output' | 'inner' = 'output') => ({ kind: 'ref', node: nodeId, source, path: [field] })

/** Start → research (agent) → decide (condition) → [ok: write, else: ask] → loop{polish, stop} → end. */
function guidedDoc(id = 'g'): FlowDocument {
  return {
    schemaVersion: 1, id, name: 'Research', description: 'Find and write', kind: 'guided', revision: 1, updatedAt: 0,
    nodes: [
      node({ id: 'start', type: 'start', data: { fields: [{ name: 'topic', schema: { type: 'string' }, required: true }] } }),
      node({ id: 'research', type: 'agent', title: 'Research', position: { x: 300, y: 0 }, data: { inputs: [{ name: 'topic', schema: { type: 'string' }, value: ref('start', 'topic') }], prompt: 'Search the web for {{topic}}.' } }),
      node({ id: 'decide', type: 'condition', title: 'Enough?', position: { x: 600, y: 0 }, data: { branches: [{ id: 'ok', label: 'enough sources', logic: 'and', conditions: [] }] } }),
      node({ id: 'ask', type: 'question', title: 'Ask', position: { x: 900, y: 100 }, data: { inputs: [], question: 'Which sources should I use?', answer: { kind: 'text' } } }),
      node({ id: 'loop', type: 'loop', title: 'Polish', position: { x: 900, y: 0 }, size: { width: 400, height: 200 }, data: { mode: 'infinite', maxIterations: 3, variables: [], outputs: [], until: 'the draft reads well' } }),
      node({ id: 'polish', type: 'agent', title: 'Polish draft', parentId: 'loop', position: { x: 40, y: 70 }, data: { inputs: [], prompt: 'Improve the draft.' } }),
      node({ id: 'note', type: 'comment', data: { text: 'not a step' } }),
      node({ id: 'end', type: 'end', title: 'End', position: { x: 1400, y: 0 }, data: { mode: 'variables', inputs: [{ name: 'report', schema: { type: 'string' }, value: { kind: 'literal', value: null } }] } }),
    ],
    edges: [
      edge('e1', 'start', 'research'), edge('e2', 'research', 'decide'), edge('e3', 'decide', 'loop', 'ok'), edge('e4', 'decide', 'ask', 'else'),
      edge('e5', 'loop', 'polish', 'body'), edge('e6', 'loop', 'end'), edge('e7', 'ask', 'end'),
    ],
  }
}

describe('guided flow spec', () => {
  it('compiles a numbered step list with loop bodies, branch gates, and variable sources', () => {
    const steps = compileGuided(guidedDoc())
    expect(steps.map(step => `${step.number} ${step.nodeId}`)).toEqual(['1 research', '2 decide', '3 loop', '3.1 polish', '4 ask', '5 end'])
    const research = steps.find(step => step.nodeId === 'research')
    expect(research?.uses).toEqual(['topic = the workflow input "topic"'])
    expect(steps.find(step => step.nodeId === 'loop')?.instruction).toContain('stop early once the draft reads well')
    expect(steps.find(step => step.nodeId === 'ask')?.hint).toMatch(/^Only if step 2 chose "else"/)
    expect(steps.find(step => step.nodeId === 'decide')?.hint).toContain('"enough sources"')
  })

  it('renders conversation and agent prompts', () => {
    const conversation = guidedPrompt(guidedDoc(), 'conversation', { topic: 'tea' }, {}, 'run-1')
    expect(conversation).toContain('- topic: "tea"')
    expect(conversation).toContain('runId "run-1"')
    expect(conversation).toContain('outputs containing report')
    const agent = guidedPrompt(guidedDoc(), 'agent', { topic: 'tea' })
    expect(agent).toContain('do not call flow_workflow')
    expect(agent).toContain('[research] Research')
  })

  it('exposes result fields, or text when the guided end declares none', () => {
    expect(flowInterface(guidedDoc()).outputs.map(field => field.name)).toEqual(['report'])
    const bare = guidedDoc()
    bare.nodes = bare.nodes.map(candidate => candidate.type === 'end' ? { ...candidate, data: { mode: 'variables', inputs: [] } } as FlowNode : candidate)
    expect(flowInterface(bare).outputs).toEqual([{ name: 'text', schema: { type: 'string' } }])
  })

  it('validates guided flows by guided rules', () => {
    const doc = guidedDoc()
    expect(validateFlow(doc, () => undefined).filter(issue => issue.severity === 'error')).toEqual([])
    const withCode = { ...doc, nodes: [...doc.nodes, node({ id: 'code', type: 'code', data: { language: 'typescript', inputs: [], code: 'x', outputs: [] } })] }
    expect(validateFlow(withCode, () => undefined).some(issue => issue.code === 'GUIDED_UNSUPPORTED' && issue.nodeId === 'code')).toBe(true)
    const strict: FlowDocument = { ...doc, kind: 'flow' }
    expect(validateFlow(strict, () => undefined).some(issue => issue.field === 'branches.0.conditions')).toBe(true)
  })
})

let dir: string
let flowStore: FlowStore
let runStore: RunStore
let subagentPrompts: string[]

function fakeCtx(): never {
  return {
    logger: { warn: () => {}, debug: () => {} },
    get: (name: string) => name === 'subagents'
      ? {
          start: async (_provider: string, request: { prompt: { text: string }[]; outputSchema?: unknown }) => {
            subagentPrompts.push(request.prompt[0]?.text ?? '')
            return {
              result: Promise.resolve(request.outputSchema === undefined
                ? { output: [{ type: 'text', text: 'the result' }], stopReason: 'completed' }
                : { output: [], structured: { report: 'structured result' }, stopReason: 'completed' }),
              dispose: async () => {},
            }
          },
        }
      : undefined,
    tools: { schemas: () => [], execute: async () => ({ isError: false, value: null, content: [] }), register: () => () => {} },
    agents: { roots: () => [] },
    workspaceRegistry: { get: (id: string) => id === 'ws' ? { path: dir } : undefined },
    llm: { stream: async function* () {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: dir }) },
  } as never
}

function save(doc: FlowDocument): void {
  fs.writeFileSync(path.join(dir, 'flows', `${doc.id}.json`), JSON.stringify(doc))
  fs.writeFileSync(path.join(dir, 'flows', `${doc.id}.meta.json`), JSON.stringify({ createdAt: 0 }))
}

async function readUntilFinished(stream: ReadableStream<Uint8Array>): Promise<RunEvent[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const out: RunEvent[] = []
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    buffer += decoder.decode(value, { stream: true })
    for (const line of buffer.split('\n').slice(0, -1)) {
      const parsed = JSON.parse(line) as RunEvent | { type: 'ping' }
      if (parsed.type !== 'ping') out.push(parsed as RunEvent)
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-guided-'))
  flowStore = new FlowStore({ storageDir: dir, maxFlowBytes: 1_000_000 })
  runStore = new RunStore({ storageDir: dir, maxRunEventsBytes: 1_000_000, keepRunsPerFlow: 50 })
  subagentPrompts = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('guided runs', () => {
  it('turns step reports into run events and finishes on the end step', async () => {
    save(guidedDoc())
    const engine = new FlowEngine(fakeCtx(), flowStore, runStore, baseConfig)
    const { runId, prompt } = engine.startGuided({ flowId: 'g', version: 'published', inputs: { topic: 'tea' }, sessionId: 'session-1' })
    expect(prompt).toContain('1. [research] Research')
    const stream = readUntilFinished(engine.eventsStream(runId, 0, new AbortController().signal))

    engine.reportGuided(runId, 'research', 'running')
    engine.reportGuided(runId, 'research', 'done', 'found five sources')
    engine.reportGuided(runId, 'decide', 'done', 'enough', 'enough sources')
    engine.reportGuided(runId, 'ask', 'skipped')
    const progress = engine.reportGuided(runId, 'end', 'done', 'final text', undefined, { report: 'the report' })
    expect(progress.status).toBe('succeeded')

    const events = await stream
    expect(events.map(event => event.type).filter(type => type === 'run.finished')).toHaveLength(1)
    const decide = events.find((event): event is Extract<RunEvent, { type: 'node.finished' }> => event.type === 'node.finished' && event.nodeId === 'decide')
    expect(decide?.firedPorts).toEqual(['ok'])
    expect(decide?.outputs).toEqual({ summary: 'enough', branch: 'enough sources' })
    const summary = runStore.get(runId)
    expect(summary?.status).toBe('succeeded')
    expect(summary?.outputs).toEqual({ report: 'the report' })
    expect(summary?.trigger).toEqual({ kind: 'guided', sessionId: 'session-1' })
    expect(engine.guidedProgress(runId)?.steps['research']).toEqual({ status: 'succeeded', summary: 'found five sources' })
    expect(() => engine.reportGuided(runId, 'research', 'done')).toThrow(GuidedRunError)
  })

  it('rejects unknown steps, non-guided flows, and cancels on request', async () => {
    save(guidedDoc())
    save({ ...guidedDoc('plain'), kind: 'flow', nodes: [node({ id: 'start', type: 'start', data: { fields: [] } }), node({ id: 'end', type: 'end', data: { mode: 'variables', inputs: [] } })], edges: [edge('e', 'start', 'end')] })
    const engine = new FlowEngine(fakeCtx(), flowStore, runStore, baseConfig)
    expect(() => engine.startGuided({ flowId: 'plain', version: 'draft', inputs: {} })).toThrow(RunStartError)
    const { runId } = engine.startGuided({ flowId: 'g', version: 'draft', inputs: { topic: 'x' } })
    expect(() => engine.reportGuided(runId, 'note', 'done')).toThrow(/unknown step/)
    expect(await engine.cancel(runId)).toBe(true)
    expect(runStore.get(runId)?.status).toBe('cancelled')
  })

  it('runs a guided subflow inside an engine flow as one delegated agent', async () => {
    save(guidedDoc())
    save({
      schemaVersion: 1, id: 'parent', name: 'Parent', description: '', revision: 1, updatedAt: 0,
      nodes: [
        node({ id: 'start', type: 'start', data: { fields: [] } }),
        node({ id: 'sub', type: 'subflow', data: { flowId: 'g', version: 'draft', inputs: [{ name: 'topic', schema: { type: 'string' }, value: { kind: 'literal', value: 'tea' } }] } }),
        node({ id: 'end', type: 'end', data: { mode: 'variables', inputs: [{ name: 'report', schema: { type: 'string' }, value: ref('sub', 'report') }] } }),
      ],
      edges: [edge('e1', 'start', 'sub'), edge('e2', 'sub', 'end')],
    })
    const engine = new FlowEngine(fakeCtx(), flowStore, runStore, baseConfig)
    const agent = { session: { id: 'caller', header: {} } }
    const { runId } = await engine.start({ flowId: 'parent', version: 'draft', inputs: {}, workspacePath: dir, caller: { agent: agent as never, parent: {} as never, rootCallId: 'root' as never, callId: 'c1' } })
    const summary = await engine.awaitRun(runId)
    expect(summary?.status).toBe('succeeded')
    expect(summary?.outputs).toEqual({ report: 'structured result' })
    expect(subagentPrompts[0]).toContain('- topic: "tea"')
    expect(subagentPrompts[0]).toContain('do not call flow_workflow')
  })
})

describe('flow_workflow tool', () => {
  it('lists flows, runs engine flows, and follows guided ones', async () => {
    save(guidedDoc())
    save({
      schemaVersion: 1, id: 'hello', name: 'Hello', description: '', revision: 1, updatedAt: 0,
      nodes: [
        node({ id: 'start', type: 'start', data: { fields: [{ name: 'who', schema: { type: 'string' }, required: true }] } }),
        node({ id: 't', type: 'text', data: { op: 'concat', inputs: [{ name: 'who', schema: { type: 'string' }, value: ref('start', 'who') }], template: 'hi {{who}}' } }),
        node({ id: 'end', type: 'end', data: { mode: 'variables', inputs: [{ name: 'greeting', schema: { type: 'string' }, value: ref('t', 'text') }] } }),
      ],
      edges: [edge('e1', 'start', 't'), edge('e2', 't', 'end')],
    })
    let definition: { execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>; output: { render(args: unknown, value: unknown): { text: string }[] } } | undefined
    const ctx = { ...(fakeCtx() as object), tools: { register: (def: never) => { definition = def; return () => {} } } }
    const engine = new FlowEngine(fakeCtx(), flowStore, runStore, baseConfig)
    registerWorkflowTool(ctx as never, flowStore, engine)
    if (definition === undefined) throw new Error('tool not registered')
    const exec = { signal: new AbortController().signal, agent: { session: { id: 's1', header: { cwd: dir } } }, token: {}, rootCallId: 'root', callId: 'c' }
    const call = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => await definition!.execute(args, exec) as Record<string, unknown>

    const listed = await call({ action: 'list' })
    expect((listed['flows'] as { id: string; kind: string }[]).map(flow => `${flow.id}:${flow.kind}`).sort()).toEqual(['g:guided', 'hello:flow'])
    expect(definition.output.render({}, listed)[0]?.text).toContain('who: string (required)')

    const ran = await call({ action: 'run', flowId: 'hello', inputs: { who: 'ada' } })
    expect(ran['outputs']).toEqual({ greeting: 'hi ada' })

    const started = await call({ action: 'start', flowId: 'g', inputs: { topic: 'tea' } })
    const runId = started['runId'] as string
    expect(String(started['steps'])).toContain('[research]')
    const reported = await call({ action: 'report', runId, nodeId: 'research', status: 'done', summary: 'ok' })
    expect((reported['progress'] as { done: number }).done).toBe(1)
    const status = await call({ action: 'status', runId })
    expect(definition.output.render({}, status)[0]?.text).toContain('research: done — ok')
    await expect(call({ action: 'run', flowId: 'g', inputs: {} })).rejects.toThrow(/guided workflow/)
  })
})
