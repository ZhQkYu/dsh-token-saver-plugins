/**
 * tool executor: call a DSH-registered tool directly, forwarding the caller's
 * agent and parent token so approvals and PTC presentation flow correctly.
 *
 * @module @dsh-plugins/flow/host/executors/tool
 */

import type { FlowNode, JsonValue } from '../../spec/types.ts'
import { renderTemplate } from '../../spec/template.ts'
import { toolArgTemplates } from '../../spec/validate.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type ToolNode = Extract<FlowNode, { type: 'tool' }>

/** The tool executor. */
export const toolExecutor: NodeExecutor<ToolNode> = {
  type: 'tool',
  requires: ['agent'],
  async execute(node, inputs, ctx): Promise<ExecResult> {
    const args: Record<string, JsonValue> = {}
    const templated = new Map(toolArgTemplates(node.data.args).map(entry => [entry.name, entry.template]))
    for (const arg of node.data.args) {
      const template = templated.get(arg.name)
      args[arg.name] = template === undefined ? inputs[arg.name] ?? null : renderTemplate(template, inputs).text
    }
    const binding = await ctx.agent()
    const result = await ctx.services.tools.execute({
      callId: ctx.nextCallId(),
      name: node.data.tool,
      arguments: args,
      agent: binding.agent,
      ...(binding.kind === 'caller' ? { parent: binding.parent, rootCallId: binding.rootCallId } : {}),
      signal: ctx.signal,
    })
    const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    if (result.isError) {
      throw new NodeError('TOOL_ERROR', text || result.error?.message || 'tool failed')
    }
    return { outputs: { text, value: result.value } }
  },
}
