/**
 * llm executor: a model call with text or JSON output. Uses `BlockAssembler`
 * to gather the stream, emits text deltas live, and checks `assembler.finish`.
 * JSON mode appends a system instruction and retries once on a bad parse.
 *
 * @module @dsh-plugins/flow/host/executors/llm
 */

import { BlockAssembler, ReasoningEffortId, type GenerateOptions, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { FlowNode, JsonValue } from '../../spec/types.ts'
import { renderTemplate } from '../../spec/template.ts'
import { coerce } from '../../spec/coerce.ts'
import { describeVarSchema } from '../../spec/var-schema.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'
import { toUsageLite } from './index.ts'

type LlmNode = Extract<FlowNode, { type: 'llm' }>

/** The llm executor. */
export const llmExecutor: NodeExecutor<LlmNode> = {
  type: 'llm',
  async execute(node, inputs, ctx): Promise<ExecResult> {
    const values = inputs
    const system = renderTemplate(node.data.system, values).text
    const originalPrompt = renderTemplate(node.data.prompt, values).text
    let prompt = originalPrompt
    const selection = node.data.model ?? ctx.services.defaultModel()
    const jsonFields = node.data.output.format === 'json' ? node.data.output.fields : undefined

    let attempts = 0
    let lastError: unknown
    let totalUsage = toUsageLite(undefined)
    while (attempts < 2) {
      ctx.budget.consumeLlmCall()
      const systemText = jsonFields === undefined ? system : `${system}\n\n${jsonInstruction(jsonFields)}`
      const options: GenerateOptions = {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
        system: systemText,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        ...(node.data.temperature === undefined ? {} : { temperature: node.data.temperature }),
        ...(node.data.maxTokens === undefined ? {} : { maxTokens: node.data.maxTokens }),
        signal: ctx.signal,
      }
      const assembler = new BlockAssembler()
      let usage: TokenUsage | undefined
      try {
        for await (const chunk of ctx.services.llm.stream(options)) {
          assembler.push(chunk)
          if (chunk.type === 'text-delta') ctx.emitDelta(chunk.text)
          else if (chunk.type === 'usage') usage = chunk.usage
        }
      } catch (error: unknown) {
        // Provider failures (rate limits, 5xx, dropped streams) are usually transient; onError.retries bounds them.
        throw new NodeError('LLM_STREAM', error instanceof Error ? error.message : String(error), true)
      }
      if (assembler.finish.kind !== 'stop') {
        throw new NodeError(`LLM_FINISH_${assembler.finish.kind.toUpperCase()}`, `model finished with ${assembler.finish.kind}`)
      }
      const blocks = assembler.blocks()
      const text = blocks.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
      const reasoning = blocks.filter(block => block.type === 'reasoning').map(block => (block as { text: string }).text).join('') || null
      const usageLite = toUsageLite(usage)
      totalUsage = addUsage(totalUsage, usageLite)
      const jsonFieldsOut = jsonFields
      if (jsonFieldsOut === undefined) {
        return { outputs: { text, reasoning }, usage: totalUsage, rendered: { system: systemText, prompt } }
      }
      const parsed = tryParseJson(text)
      if (parsed !== undefined) {
        const coerced = coerceFieldsToOutput(parsed, jsonFieldsOut)
        if (coerced !== undefined) {
          return { outputs: coerced, usage: totalUsage, rendered: { system: systemText, prompt } }
        }
        lastError = new Error('parsed JSON does not match the output fields')
      } else {
        lastError = new Error('output is not valid JSON')
      }
      attempts++
      if (attempts < 2) {
        // One identity-free user turn carries the original request, the rejected reply, and the reason.
        const reason = lastError instanceof Error ? lastError.message : 'invalid output'
        prompt = `${originalPrompt}\n\n---\nYour previous reply could not be used (${reason}). Previous reply:\n${text.slice(0, REPAIR_ECHO_CHARS)}\n---\nRespond again with only a valid JSON object with exactly the declared fields.`
      }
    }
    throw new NodeError('LLM_BAD_JSON', lastError instanceof Error ? lastError.message : 'unable to produce JSON', true)
  },
}

/** How much of a rejected reply the repair turn echoes back to the model. */
const REPAIR_ECHO_CHARS = 4000

function addUsage(a: import('../../spec/types.ts').TokenUsageLite, b: import('../../spec/types.ts').TokenUsageLite): import('../../spec/types.ts').TokenUsageLite {
  const cacheRead = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
  const reasoning = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheRead === 0 ? {} : { cacheReadTokens: cacheRead }),
    ...(reasoning === 0 ? {} : { reasoningTokens: reasoning }),
  }
}

function jsonInstruction(fields: { name: string; schema: import('../../spec/types.ts').VarSchema }[]): string {
  return `Respond with only a JSON object. Its fields must be exactly: ${fields.map(f => `"${f.name}" (${describeVarSchema(f.schema)})`).join(', ')}.`
}

function tryParseJson(text: string): unknown {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    return undefined
  }
}

function coerceFieldsToOutput(value: unknown, fields: { name: string; schema: import('../../spec/types.ts').VarSchema }[]): Record<string, JsonValue> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const out: Record<string, JsonValue> = {}
  for (const field of fields) {
    const coerced = coerce(record[field.name] ?? null, field.schema)
    if (!coerced.ok) return undefined
    out[field.name] = coerced.value
  }
  return out
}
