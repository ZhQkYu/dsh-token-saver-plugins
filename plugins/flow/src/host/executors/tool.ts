/**
 * tool executor: call a DSH-registered tool directly, forwarding the caller's
 * agent and parent token so approvals and PTC presentation flow correctly.
 *
 * @module @dsh-plugins/flow/host/executors/tool
 */

import type { FlowNode } from '../../spec/types.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type ToolNode = Extract<FlowNode, { type: 'tool' }>

/** The tool executor. */
export const toolExecutor: NodeExecutor<ToolNode> = {
  type: 'tool',
  requires: ['agent'],
  async execute(node, inputs, ctx): Promise<ExecResult> {
    const args = inputs
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
