/**
 * intent executor: classify a query into named intents via an LLM. Outputs
 * `{ intent, reason }` and fires the matching intent port or `other`.
 *
 * @module @dsh-plugins/flow/host/executors/intent
 */

import { BlockAssembler, type GenerateOptions, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { FlowNode } from '../../spec/types.ts'
import { renderTemplate } from '../../spec/template.ts'
import { NodeError } from '../engine/budget.ts'
import { toUsageLite, type ExecResult, type NodeExecutor } from './index.ts'

type IntentNode = Extract<FlowNode, { type: 'intent' }>

/** The intent executor. */
export const intentExecutor: NodeExecutor<IntentNode> = {
  type: 'intent',
  async execute(node, inputs, ctx): Promise<ExecResult> {
    const values = inputs
    const query = renderTemplate(node.data.query, values).text
    const selection = node.data.model ?? ctx.services.defaultModel()
    const intentsList = node.data.intents.map(intent => `- ${intent.id}: ${intent.label}${intent.description ? ` (${intent.description})` : ''}`).join('\n')
    const instruction = node.data.instruction ?? ''
    const system = `You are an intent classifier. Classify the query into exactly one of the following intents:\n${intentsList}\n${instruction}\nRespond with a JSON object: {"intent": "<intent id>", "reason": "<short reason>"}.`
    const options: GenerateOptions = {
      provider: selection.provider,
      model: selection.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: query }] }],
      signal: ctx.signal,
    }
    ctx.budget.consumeLlmCall()
    const assembler = new BlockAssembler()
    let usage: TokenUsage | undefined
    try {
      for await (const chunk of ctx.services.llm.stream(options)) {
        assembler.push(chunk)
        if (chunk.type === 'usage') usage = chunk.usage
      }
    } catch (error: unknown) {
      // Provider failures (rate limits, 5xx, dropped streams) are usually transient; onError.retries bounds them.
      throw new NodeError('LLM_STREAM', error instanceof Error ? error.message : String(error), true)
    }
    if (assembler.finish.kind !== 'stop') {
      throw new NodeError(`LLM_FINISH_${assembler.finish.kind.toUpperCase()}`, `model finished with ${assembler.finish.kind}`)
    }
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
    const parsed = tryParseJson(text)
    let intentId = ''
    let reason = ''
    let parseFailed = false
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      intentId = typeof record['intent'] === 'string' ? record['intent'] : ''
      reason = typeof record['reason'] === 'string' ? record['reason'] : ''
    } else {
      parseFailed = true
      reason = 'intent classification returned non-JSON output'
    }
    const matched = node.data.intents.find(entry => entry.id === intentId)
    const firedPort = matched === undefined ? 'other' : matched.id
    return {
      outputs: {
        intent: matched === undefined ? 'other' : matched.label,
        intentId: matched === undefined ? 'other' : matched.id,
        reason,
        ...(parseFailed ? { parseFailed } : {}),
      },
      firedPorts: [firedPort],
      ...(usage === undefined ? {} : { usage: toUsageLite(usage) }),
      rendered: { system, prompt: query },
    }
  },
}

function tryParseJson(text: string): unknown {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}
