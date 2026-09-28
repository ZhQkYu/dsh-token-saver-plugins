/**
 * intent executor: classify a query into named intents via an LLM. Outputs
 * `{ intent, reason }` and fires the matching intent port or `other`.
 *
 * @module @dsh-plugins/flow/host/executors/intent
 */

import { BlockAssembler, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { FlowNode } from '../../spec/types.ts'
import { renderTemplate } from '../../spec/template.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'
import { resolveInputs } from './resolve.ts'

type IntentNode = Extract<FlowNode, { type: 'intent' }>

/** The intent executor. */
export const intentExecutor: NodeExecutor<IntentNode> = {
  type: 'intent',
  async execute(node, _inputs, ctx): Promise<ExecResult> {
    const values = resolveInputs(node, ctx.frame)
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
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of ctx.services.llm.stream(options)) {
        assembler.push(chunk)
      }
    } catch (error: unknown) {
      throw new NodeError('LLM_STREAM', error instanceof Error ? error.message : String(error))
    }
    if (assembler.finish.kind !== 'stop') {
      throw new NodeError(`LLM_FINISH_${assembler.finish.kind.toUpperCase()}`, `model finished with ${assembler.finish.kind}`)
    }
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
    ctx.budget.consumeLlmCall()
    const parsed = tryParseJson(text)
    let intent = ''
    let reason = ''
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      intent = typeof record['intent'] === 'string' ? record['intent'] : ''
      reason = typeof record['reason'] === 'string' ? record['reason'] : ''
    }
    const matched = node.data.intents.some(entry => entry.id === intent)
    const firedPort = matched ? intent : 'other'
    return { outputs: { intent: matched ? intent : 'other', reason }, firedPorts: [firedPort] }
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
