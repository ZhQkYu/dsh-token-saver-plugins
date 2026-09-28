/**
 * break / continue / assign executors. break and continue set the frame
 * control signal; assign writes to a loop variable immediately.
 *
 * @module @dsh-plugins/flow/host/executors/control
 */

import type { FlowNode } from '../../spec/types.ts'
import { resolveRef } from '../engine/frames.ts'
import { coerce } from '../../spec/coerce.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type BreakNode = Extract<FlowNode, { type: 'break' }>
type ContinueNode = Extract<FlowNode, { type: 'continue' }>
type AssignNode = Extract<FlowNode, { type: 'assign' }>

/** The break executor. */
export const breakExecutor: NodeExecutor<BreakNode> = {
  type: 'break',
  async execute(_node, _inputs, ctx): Promise<ExecResult> {
    ctx.frame.control = 'break'
    return { outputs: {} }
  },
}

/** The continue executor. */
export const continueExecutor: NodeExecutor<ContinueNode> = {
  type: 'continue',
  async execute(_node, _inputs, ctx): Promise<ExecResult> {
    ctx.frame.control = 'continue'
    return { outputs: {} }
  },
}

/** The assign executor. */
export const assignExecutor: NodeExecutor<AssignNode> = {
  type: 'assign',
  async execute(node, _inputs, ctx): Promise<ExecResult> {
    const container = ctx.frame
    if (container.inner === undefined) throw new NodeError('BAD_PARENT', 'assign node must be inside a loop container')
    for (const assignment of node.data.assignments) {
      const raw = resolveRef(ctx.frame, assignment.value)
      const coerced = coerce(raw ?? null, { type: 'any' })
      if (!coerced.ok) throw new NodeError('INPUT_TYPE', `assign "${assignment.variable}": ${coerced.reason}`)
      container.inner[assignment.variable] = coerced.value
    }
    return { outputs: {} }
  },
}
