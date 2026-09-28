/**
 * agent executor: delegate a task to a child Agent with tools, optionally with
 * structured output. The subagent is always disposed.
 *
 * @module @dsh-plugins/flow/host/executors/agent
 */

import type { FlowNode } from '../../spec/types.ts'
import { renderTemplate } from '../../spec/template.ts'
import { NodeError } from '../engine/budget.ts'
import { delegate } from './delegate.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type AgentNode = Extract<FlowNode, { type: 'agent' }>

/** The agent executor. */
export const agentExecutor: NodeExecutor<AgentNode> = {
  type: 'agent',
  requires: ['subagents', 'agent'],
  async execute(node, inputs, ctx): Promise<ExecResult> {
    const subagents = ctx.services.subagents
    if (subagents === undefined) throw new NodeError('SERVICE_UNAVAILABLE', 'agent node requires the subagents service')
    const prompt = renderTemplate(node.data.prompt, inputs).text
    const binding = await ctx.agent()
    ctx.budget.consumeAgentNode()
    const outputs = await delegate(subagents, {
      provider: node.data.provider ?? ctx.services.defaultProvider ?? 'spawn',
      label: node.title,
      prompt,
      parent: binding.agent,
      signal: ctx.signal,
      ...(node.data.outputs === undefined ? {} : { fields: node.data.outputs }),
      ...(node.data.model === undefined ? {} : { model: node.data.model }),
      // An empty `tools: {}` must not disable every tool; only an explicit allow list filters.
      ...(node.data.tools?.allow === undefined ? {} : { toolAllow: node.data.tools.allow }),
      ...(node.data.persona === undefined ? {} : { persona: node.data.persona }),
    })
    return { outputs }
  },
}
