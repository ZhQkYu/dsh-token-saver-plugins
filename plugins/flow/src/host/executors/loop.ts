/**
 * loop executor: iterate a container body sequentially. The container's inner
 * variables (item/index/loop vars) are one shared object, so `assign` writes
 * persist across rounds and `break`/`continue` control the loop.
 *
 * @module @dsh-plugins/flow/host/executors/loop
 */

import type { FlowNode, JsonValue } from '../../spec/types.ts'
import { resolveRef, resolveRefFromOutputs } from '../engine/frames.ts'
import { coerce } from '../../spec/coerce.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type LoopNode = Extract<FlowNode, { type: 'loop' }>

/** The loop executor. */
export const loopExecutor: NodeExecutor<LoopNode> = {
  type: 'loop',
  async execute(node, _inputs, ctx): Promise<ExecResult> {
    const sharedInner: Record<string, JsonValue> = {}
    for (const variable of node.data.variables) {
      const initial = resolveRef(ctx.frame, variable.initial)
      const coerced = coerce(initial ?? null, variable.schema)
      if (!coerced.ok) throw new NodeError('INPUT_TYPE', `loop variable "${variable.name}": ${coerced.reason}`)
      sharedInner[variable.name] = coerced.value
    }

    // Clamp to the deployment limit too, so a hand-built plan cannot bypass validation.
    const maxIterations = Math.min(node.data.maxIterations, ctx.limits.maxLoopIterations)
    const array = node.data.mode === 'array' ? resolveRef(ctx.frame, node.data.array ?? { kind: 'literal', value: [] }) : undefined
    let count: number
    if (node.data.mode === 'array') {
      if (!Array.isArray(array)) throw new NodeError('INPUT_TYPE', 'loop array mode requires an array')
      if (array.length > maxIterations) throw new NodeError('LOOP_LIMIT', `array of ${array.length} items exceeds maxIterations ${maxIterations}`)
      count = array.length
    } else if (node.data.mode === 'count') {
      const rawCount = coerce(resolveRef(ctx.frame, node.data.count ?? { kind: 'literal', value: 0 }), { type: 'integer' })
      if (!rawCount.ok) throw new NodeError('INPUT_TYPE', `loop count: ${rawCount.reason}`)
      count = Math.min(Math.max(0, rawCount.value as number), maxIterations)
    } else {
      count = maxIterations
    }

    const collected: Record<string, JsonValue[]> = {}
    for (const output of node.data.outputs) collected[output.name] = []

    let iterations = 0
    let broke = false
    while (iterations < count) {
      ctx.signal.throwIfAborted()
      sharedInner.item = Array.isArray(array) ? array[iterations] ?? null : null
      sharedInner.index = iterations
      const result = await ctx.runScope(node, sharedInner, iterations)
      if (result.error !== undefined) {
        throw new NodeError(result.error.code, result.error.message, false)
      }
      for (const output of node.data.outputs) {
        const value = resolveRefFromOutputs(result.nodeOutputs, output.value)
        ;(collected[output.name] ??= []).push(value)
      }
      if (result.control === 'break') { broke = true; break }
      if (result.control === 'continue') { iterations++; continue }
      iterations++
    }
    // `infinite` mode that never breaks is bounded by maxIterations; reaching
    // it without a break is a loop-limit violation.
    if (!broke && node.data.mode === 'infinite' && iterations >= maxIterations) {
      throw new NodeError('LOOP_LIMIT', `infinite loop exceeded ${maxIterations} iterations without a break`)
    }

    const outputs: Record<string, JsonValue> = { ...collected }
    for (const variable of node.data.variables) {
      outputs[variable.name] = sharedInner[variable.name] ?? null
    }
    return { outputs }
  },
}
