import { describe, expect, it, vi } from 'vitest'
import type { FlowNode } from '../src/spec/types.ts'
import { createFrame } from '../src/host/engine/frames.ts'
import { RunBudget } from '../src/host/engine/budget.ts'
import type { ExecContext, FlowServices } from '../src/host/executors/index.ts'
import { llmExecutor } from '../src/host/executors/llm.ts'
import { toolExecutor } from '../src/host/executors/tool.ts'
import { codeExecutor } from '../src/host/executors/code.ts'
import { agentExecutor } from '../src/host/executors/agent.ts'
import { subflowExecutor } from '../src/host/executors/subflow.ts'

function makeCtx(services: FlowServices, overrides: Partial<ExecContext> = {}): ExecContext {
  const frame = createFrame('root', [], undefined)
  return {
    signal: new AbortController().signal,
    runId: 'run-1',
    execKey: 'node1',
    frame,
    workspacePath: '/tmp',
    budget: new RunBudget({ maxNodeExecutions: 100, maxLlmCalls: 100, maxAgentNodes: 100, maxRunDurationMs: 60000 }),
    emitDelta: () => {},
    emitMessage: () => {},
    agent: async () => ({ kind: 'run-session', agent: {} as never }),
    interaction: { ask: async () => ({}) },
    services,
    runScope: async () => ({ nodeOutputs: new Map(), failed: false }),
    runSubflow: async () => ({}),
    ...overrides,
  }
}

describe('llm executor', () => {
  it('returns text output and usage from a streamed model response', async () => {
    const stream = async function* (): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Hello' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    }
    const ctx = makeCtx({
      llm: { stream },
      tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
    })
    const node = {
      id: 'llm1', type: 'llm', title: 'LLM', description: '', position: { x: 0, y: 0 },
      data: { inputs: [], system: '', prompt: 'Say hi', output: { format: 'text' } },
    } as Extract<FlowNode, { type: 'llm' }>
    const result = await llmExecutor.execute(node, {}, ctx)
    expect(result.outputs).toEqual({ text: 'Hello', reasoning: null })
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('parses and coerces JSON mode output, retrying once on a bad parse', async () => {
    let calls = 0
    const stream = async function* (): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
      calls++
      const text = calls === 1 ? 'not json' : '```json\n{"name": "Alice"}\n```'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    const ctx = makeCtx({
      llm: { stream },
      tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
    })
    const node = {
      id: 'llm1', type: 'llm', title: 'LLM', description: '', position: { x: 0, y: 0 },
      data: { inputs: [], system: '', prompt: 'x', output: { format: 'json', fields: [{ name: 'name', schema: { type: 'string' } }] } },
    } as Extract<FlowNode, { type: 'llm' }>
    const result = await llmExecutor.execute(node, {}, ctx)
    expect(result.outputs).toEqual({ name: 'Alice' })
    expect(calls).toBe(2)
  })

  it('throws LLM_FINISH_MAX_TOKENS when the model hits max tokens', async () => {
    const stream = async function* (): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    }
    const ctx = makeCtx({
      llm: { stream },
      tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
    })
    const node = {
      id: 'llm1', type: 'llm', title: 'LLM', description: '', position: { x: 0, y: 0 },
      data: { inputs: [], system: '', prompt: 'x', output: { format: 'text' } },
    } as Extract<FlowNode, { type: 'llm' }>
    await expect(llmExecutor.execute(node, {}, ctx)).rejects.toMatchObject({ code: 'LLM_FINISH_MAX-TOKENS' })
  })
})

describe('tool executor', () => {
  it('calls a tool and forwards the caller binding', async () => {
    const execute = vi.fn(async (input: { parent?: unknown; rootCallId?: unknown; signal?: AbortSignal }) => ({
      isError: false,
      value: { ok: true },
      content: [{ type: 'text' as const, text: 'result text' }],
    }))
    const ctx = makeCtx({
      llm: { stream: async function* () {} },
      tools: { execute: execute as never },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
    }, {
      agent: async () => ({ kind: 'caller', agent: {} as never, parent: 'parent-token', rootCallId: 'root-call' }),
    })
    const node = {
      id: 'tool1', type: 'tool', title: 'Tool', description: '', position: { x: 0, y: 0 },
      data: { tool: 'my_tool', args: [] },
    } as Extract<FlowNode, { type: 'tool' }>
    const result = await toolExecutor.execute(node, {}, ctx)
    expect(result.outputs).toEqual({ text: 'result text', value: { ok: true } })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ parent: 'parent-token', rootCallId: 'root-call' }))
  })

  it('throws TOOL_ERROR when the tool reports an error', async () => {
    const ctx = makeCtx({
      llm: { stream: async function* () {} },
      tools: { execute: async () => ({ isError: true, value: null, content: [{ type: 'text', text: 'failed' }], error: { name: 'boom' } }) },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
    })
    const node = {
      id: 'tool1', type: 'tool', title: 'Tool', description: '', position: { x: 0, y: 0 },
      data: { tool: 'my_tool', args: [] },
    } as Extract<FlowNode, { type: 'tool' }>
    await expect(toolExecutor.execute(node, {}, ctx)).rejects.toMatchObject({ code: 'TOOL_ERROR' })
  })
})

describe('code executor', () => {
  it('runs code through ptcRuntime and coerces outputs', async () => {
    const run = vi.fn(async () => ({ value: { result: 'ok' }, logs: ['log1'] }))
    const ctx = makeCtx({
      llm: { stream: async function* () {} },
      tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
      ptc: { language: 'typescript', resolve: (spec: unknown) => spec, run: run as never },
    })
    const node = {
      id: 'code1', type: 'code', title: 'Code', description: '', position: { x: 0, y: 0 },
      data: { language: 'typescript', inputs: [], code: 'return { result: 1 }', outputs: [{ name: 'result', schema: { type: 'string' } }] },
    } as Extract<FlowNode, { type: 'code' }>
    const result = await codeExecutor.execute(node, {}, ctx)
    expect(result.outputs).toEqual({ result: 'ok' })
    expect(result.logs).toEqual(['log1'])
  })

  it('maps a worker-exit error kind to a retryable CODE_WORKER_EXIT', async () => {
    const ctx = makeCtx({
      llm: { stream: async function* () {} },
      tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
      ptc: { language: 'typescript', resolve: (spec: unknown) => spec, run: async () => ({ logs: [], error: { kind: 'worker-exit', message: 'crashed' } }) },
    })
    const node = {
      id: 'code1', type: 'code', title: 'Code', description: '', position: { x: 0, y: 0 },
      data: { language: 'typescript', inputs: [], code: 'x', outputs: [] },
    } as Extract<FlowNode, { type: 'code' }>
    await expect(codeExecutor.execute(node, {}, ctx)).rejects.toMatchObject({ code: 'CODE_WORKER_EXIT', retryable: true })
  })

  it('throws SERVICE_UNAVAILABLE when ptcRuntime is missing', async () => {
    const ctx = makeCtx({
      llm: { stream: async function* () {} },
      tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
    })
    const node = {
      id: 'code1', type: 'code', title: 'Code', description: '', position: { x: 0, y: 0 },
      data: { language: 'typescript', inputs: [], code: 'x', outputs: [] },
    } as Extract<FlowNode, { type: 'code' }>
    await expect(codeExecutor.execute(node, {}, ctx)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
})

describe('agent executor', () => {
  it('returns text output and always disposes the subagent', async () => {
    let disposed = false
    const ctx = makeCtx({
      llm: { stream: async function* () {} },
      tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
      defaultProvider: 'spawn',
      subagents: {
        start: async () => ({
          result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed', structured: undefined }),
          dispose: async () => { disposed = true },
        }),
      },
    })
    const node = {
      id: 'agent1', type: 'agent', title: 'Agent', description: '', position: { x: 0, y: 0 },
      data: { inputs: [], prompt: 'do it' },
    } as Extract<FlowNode, { type: 'agent' }>
    const result = await agentExecutor.execute(node, {}, ctx)
    expect(result.outputs).toEqual({ text: 'done' })
    expect(disposed).toBe(true)
  })

  it('coerces structured output when outputs are declared', async () => {
    let disposed = false
    const ctx = makeCtx({
      llm: { stream: async function* () {} },
      tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
      defaultProvider: 'spawn',
      subagents: {
        start: async () => ({
          result: Promise.resolve({ output: [], stopReason: 'completed', structured: { summary: 'ok' } }),
          dispose: async () => { disposed = true },
        }),
      },
    })
    const node = {
      id: 'agent1', type: 'agent', title: 'Agent', description: '', position: { x: 0, y: 0 },
      data: { inputs: [], prompt: 'do it', outputs: [{ name: 'summary', schema: { type: 'string' } }] },
    } as Extract<FlowNode, { type: 'agent' }>
    const result = await agentExecutor.execute(node, {}, ctx)
    expect(result.outputs).toEqual({ summary: 'ok' })
    expect(disposed).toBe(true)
  })

  it('throws AGENT_STOPPED when the subagent did not complete', async () => {
    const ctx = makeCtx({
      llm: { stream: async function* () {} },
      tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
      defaultProvider: 'spawn',
      subagents: {
        start: async () => ({
          result: Promise.resolve({ output: [], stopReason: 'max-tokens', structured: undefined }),
          dispose: async () => {},
        }),
      },
    })
    const node = {
      id: 'agent1', type: 'agent', title: 'Agent', description: '', position: { x: 0, y: 0 },
      data: { inputs: [], prompt: 'do it' },
    } as Extract<FlowNode, { type: 'agent' }>
    await expect(agentExecutor.execute(node, {}, ctx)).rejects.toMatchObject({ code: 'AGENT_STOPPED' })
  })
})

describe('subflow executor', () => {
  it('delegates to runSubflow and returns its outputs', async () => {
    const runSubflow = vi.fn(async (_flowId: string, _version: string, _inputs: Record<string, unknown>) => ({ result: 'nested' }))
    const ctx = makeCtx({
      llm: { stream: async function* () {} },
      tools: { execute: async () => ({ isError: false, value: null, content: [] }) },
      defaultModel: () => ({ provider: 'p', model: 'm' }),
    }, { runSubflow: runSubflow as never })
    const node = {
      id: 'sub1', type: 'subflow', title: 'Sub', description: '', position: { x: 0, y: 0 },
      data: { flowId: 'flow-2', version: 'published', inputs: [{ name: 'topic', schema: { type: 'string' }, value: { kind: 'literal', value: 'hello' } }] },
    } as Extract<FlowNode, { type: 'subflow' }>
    const result = await subflowExecutor.execute(node, {}, ctx)
    expect(runSubflow).toHaveBeenCalledWith('flow-2', 'published', { topic: 'hello' })
    expect(result.outputs).toEqual({ result: 'nested' })
  })
})
