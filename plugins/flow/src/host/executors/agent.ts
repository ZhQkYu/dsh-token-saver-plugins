/**
 * agent executor: delegate a task to a child Agent with tools, optionally with
 * structured output. The subagent is always disposed.
 *
 * @module @dsh-plugins/flow/host/executors/agent
 */

import type { FlowNode, JsonValue } from '../../spec/types.ts'
import { renderTemplate } from '../../spec/template.ts'
import { coerce } from '../../spec/coerce.ts'
import { toObjectJsonSchema } from '../../spec/var-schema.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type AgentNode = Extract<FlowNode, { type: 'agent' }>

/** The agent executor. */
export const agentExecutor: NodeExecutor<AgentNode> = {
  type: 'agent',
  requires: ['subagents', 'agent'],
  async execute(node, inputs, ctx): Promise<ExecResult> {
    const subagents = ctx.services.subagents
    if (subagents === undefined) throw new NodeError('SERVICE_UNAVAILABLE', 'agent node requires the subagents service')
    const values = inputs
    const prompt = renderTemplate(node.data.prompt, values).text
    const binding = await ctx.agent()
    ctx.budget.consumeAgentNode()
    const fields = node.data.outputs
    const run = await subagents.start(node.data.provider ?? ctx.services.defaultProvider ?? 'spawn', {
      label: node.title,
      prompt: [{ type: 'text', text: prompt }],
      parent: binding.agent,
      signal: ctx.signal,
      ...(node.data.model === undefined ? {} : { agentOptions: { provider: node.data.model.provider, model: node.data.model.model } }),
      ...(fields === undefined ? {} : { outputSchema: toObjectJsonSchema(fields) }),
      // Only pass a toolFilter when an explicit `allow` list is set; an empty
      // `tools: {}` must not disable every tool.
      ...(node.data.tools?.allow === undefined ? {} : { toolFilter: { allow: node.data.tools.allow } }),
      ...(node.data.persona === undefined ? {} : { persona: node.data.persona }),
    })
    try {
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new NodeError('AGENT_STOPPED', result.diagnostic ?? result.stopReason)
      }
      if (fields === undefined) {
        const text = result.output.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
        return { outputs: { text } }
      }
      const structured = result.structured
      if (structured === undefined || structured === null || typeof structured !== 'object') {
        throw new NodeError('AGENT_OUTPUT', 'agent did not return structured output')
      }
      const outputs: Record<string, JsonValue> = {}
      for (const field of fields) {
        const value = (structured as Record<string, unknown>)[field.name]
        const coerced = coerce(value ?? null, field.schema)
        if (!coerced.ok) throw new NodeError('AGENT_OUTPUT', `output field "${field.name}": ${coerced.reason}`)
        outputs[field.name] = coerced.value
      }
      return { outputs }
    } finally {
      await run.dispose()
    }
  },
}
