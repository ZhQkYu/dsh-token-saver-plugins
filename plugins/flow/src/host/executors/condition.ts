/**
 * condition executor: evaluate branches in order and fire the first true one,
 * or `else`.
 *
 * @module @dsh-plugins/flow/host/executors/condition
 */

import type { FlowNode, ValueSource } from '../../spec/types.ts'
import { evaluateOp } from '../../spec/conditions.ts'
import { resolveRef } from '../engine/frames.ts'
import type { ExecContext, ExecResult, NodeExecutor } from './index.ts'

type ConditionNode = Extract<FlowNode, { type: 'condition' }>

/** The condition executor. */
export const conditionExecutor: NodeExecutor<ConditionNode> = {
  type: 'condition',
  async execute(node, _inputs, ctx): Promise<ExecResult> {
    const maxRegexInputChars = ctx.services.maxRegexInputChars ?? 100_000
    for (const branch of node.data.branches) {
      const results = branch.conditions.map(condition => evaluateCondition(condition, ctx.frame, maxRegexInputChars))
      const passed = branch.logic === 'and' ? results.every(r => r) : results.some(r => r)
      if (passed) return { outputs: { branch: branch.id }, firedPorts: [branch.id] }
    }
    return { outputs: { branch: 'else' }, firedPorts: ['else'] }
  },
}

function evaluateCondition(condition: { left: ValueSource; op: import('../../spec/types.ts').ConditionOp; right?: ValueSource }, frame: ExecContext['frame'], maxRegexInputChars: number): boolean {
  const left = resolveRef(frame, condition.left)
  const right = condition.right === undefined ? undefined : resolveRef(frame, condition.right)
  return evaluateOp(condition.op, left, right, { maxRegexInputChars }).result
}
