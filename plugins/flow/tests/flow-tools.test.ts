import { describe, expect, it } from 'vitest'
import type { FlowDocument } from '../src/spec/types.ts'
import { FlowTools, FLOW_TOOL_PREFIX } from '../src/host/flow-tools.ts'
import type { FlowEngine } from '../src/host/engine/engine.ts'
import type { FlowStore } from '../src/host/store/flow-store.ts'

function makeFlow(): FlowDocument {
  return {
    schemaVersion: 1,
    id: 'flow-1',
    name: 'My Flow',
    description: '',
    nodes: [
      { id: 'start', type: 'start', title: 'Start', description: '', position: { x: 0, y: 0 }, data: { fields: [{ name: 'topic', schema: { type: 'string' }, required: true }] } },
      { id: 'end', type: 'end', title: 'End', description: '', position: { x: 0, y: 0 }, data: { mode: 'variables', inputs: [{ name: 'answer', schema: { type: 'string' }, value: { kind: 'literal', value: 'done' } }] } },
    ],
    edges: [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'end' }],
    revision: 3,
    updatedAt: 0,
  }
}

class FakeTools {
  readonly registered = new Map<string, { name: string; parameters: Record<string, unknown>; output: { schema: Record<string, unknown> }; description: string; timeoutMs?: number; isConcurrencySafe?: () => boolean }>()
  private readonly reserved = new Set<string>()
  register(tool: { name: string; parameters: Record<string, unknown>; output: { schema: Record<string, unknown> }; description: string; timeoutMs?: number; isConcurrencySafe?: () => boolean }): () => void {
    this.registered.set(tool.name, tool)
    return () => { this.registered.delete(tool.name) }
  }
  get(name: string): unknown {
    if (this.registered.has(name)) return this.registered.get(name)
    if (this.reserved.has(name)) return { reserved: true }
    return undefined
  }
  reserve(name: string): void { this.reserved.add(name) }
}

class FakeEngine {
  timeoutMs(): number { return 60000 }
  async start(): Promise<{ runId: string }> { return { runId: 'run-1' } }
  async awaitRun(): Promise<Record<string, unknown>> { return { status: 'succeeded', outputs: { answer: 'done' } } }
}

class FakeFlowStore {
  constructor(private readonly flow: FlowDocument, private readonly meta: { publishedVersion: number; tool?: { enabled: boolean; name: string; description?: string } }) {}
  list() { return [{ id: this.flow.id, name: this.flow.name }] }
  getMeta(_id: string) { return this.meta }
  version(_id: string, _v: number) { return this.flow }
  latestPublishedVersion(_id: string) { return this.meta.publishedVersion }
}

function makeTools(meta: { publishedVersion: number; tool?: { enabled: boolean; name: string; description?: string } }): { tools: FlowTools; fakeTools: FakeTools } {
  const store = new FakeFlowStore(makeFlow(), meta)
  const engine = new FakeEngine() as unknown as FlowEngine
  const fakeTools = new FakeTools()
  const ctx = { tools: fakeTools, logger: { warn: () => {}, debug: () => {} } } as never
  return { tools: new FlowTools(ctx, store as unknown as FlowStore, engine), fakeTools }
}

describe('flow-tools', () => {
  it('registers a flow_<name> tool for a published enabled flow', () => {
    const { tools, fakeTools } = makeTools({ publishedVersion: 1, tool: { enabled: true, name: 'summarize', description: 'Summarize a topic' } })
    tools.sync()
    const tool = fakeTools.registered.get(`${FLOW_TOOL_PREFIX}summarize`)
    expect(tool).toBeDefined()
    expect(tool?.description).toBe('Summarize a topic')
    expect(tool?.timeoutMs).toBe(60000)
    expect(tool?.isConcurrencySafe?.()).toBe(false)
  })

  it('derives parameters from the start fields and output from the end inputs', () => {
    const { tools, fakeTools } = makeTools({ publishedVersion: 1, tool: { enabled: true, name: 'summarize' } })
    tools.sync()
    const tool = fakeTools.registered.get(`${FLOW_TOOL_PREFIX}summarize`)
    const params = tool?.parameters as unknown as { type: string; properties: Record<string, unknown>; required?: string[] }
    expect(params.type).toBe('object')
    expect(params.properties?.['topic']).toEqual({ type: 'string' })
    expect(params.required).toContain('topic')
    const output = tool?.output as unknown as { schema: { type: string; properties: Record<string, unknown>; additionalProperties: boolean } }
    expect(output.schema.type).toBe('object')
    expect(output.schema.properties?.['answer']).toEqual({ type: 'string' })
  })

  it('skips a flow that is not enabled as a tool', () => {
    const { tools, fakeTools } = makeTools({ publishedVersion: 1, tool: { enabled: false, name: 'off' } })
    tools.sync()
    expect(fakeTools.registered.size).toBe(0)
  })

  it('does not overwrite an existing tool with the same name', () => {
    const { tools, fakeTools } = makeTools({ publishedVersion: 1, tool: { enabled: true, name: 'clash' } })
    fakeTools.reserve(`${FLOW_TOOL_PREFIX}clash`)
    tools.sync()
    expect(fakeTools.registered.size).toBe(0)
  })

  it('unregisters a tool when a flow is deleted', () => {
    const { tools, fakeTools } = makeTools({ publishedVersion: 1, tool: { enabled: true, name: 'summarize' } })
    tools.sync()
    expect(fakeTools.registered.has(`${FLOW_TOOL_PREFIX}summarize`)).toBe(true)
    tools.unregister('flow-1')
    expect(fakeTools.registered.has(`${FLOW_TOOL_PREFIX}summarize`)).toBe(false)
  })

  it('releaseAll clears every registered tool', () => {
    const { tools, fakeTools } = makeTools({ publishedVersion: 1, tool: { enabled: true, name: 'summarize' } })
    tools.sync()
    tools.releaseAll()
    expect(fakeTools.registered.size).toBe(0)
  })
})
