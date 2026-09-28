/**
 * subflow executor: run another flow (published or draft) as a sub-step and
 * return its end outputs.
 *
 * @module @dsh-plugins/flow/host/executors/subflow
 */

import type { FlowNode } from '../../spec/types.ts'
import type { ExecResult, NodeExecutor } from './index.ts'
import { resolveInputs } from './resolve.ts'

type SubflowNode = Extract<FlowNode, { type: 'subflow' }>

/** The subflow executor. */
export const subflowExecutor: NodeExecutor<SubflowNode> = {
  type: 'subflow',
  async execute(node, _inputs, ctx): Promise<ExecResult> {
    const inputs = resolveInputs(node, ctx.frame)
    const outputs = await ctx.runSubflow(node.data.flowId, node.data.version, inputs)
    return { outputs }
  },
}
