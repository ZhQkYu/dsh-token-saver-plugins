/**
 * aggregate executor: per group, take the first executed-and-non-null candidate.
 *
 * @module @dsh-plugins/flow/host/executors/aggregate
 */

import type { FlowNode } from '../../spec/types.ts'
import { resolveRef } from '../engine/frames.ts'
import { coerce } from '../../spec/coerce.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type AggregateNode = Extract<FlowNode, { type: 'aggregate' }>

/** The aggregate executor. */
export const aggregateExecutor: NodeExecutor<AggregateNode> = {
  type: 'aggregate',
  async execute(node, _inputs, ctx): Promise<ExecResult> {
    const outputs: Record<string, unknown> = {}
    for (const group of node.data.groups) {
      let value: unknown = null
      for (const candidate of group.candidates) {
        const resolved = resolveRef(ctx.frame, candidate)
        if (resolved === null || resolved === undefined) continue
        // Coerce the candidate to the group schema; an uncoercible candidate is
        // treated as empty and the next candidate is tried.
        const coerced = coerce(resolved, group.schema)
        if (coerced.ok) { value = coerced.value; break }
      }
      outputs[group.name] = value
    }
    return { outputs: outputs as Record<string, import('../../spec/types.ts').JsonValue> }
  },
}
