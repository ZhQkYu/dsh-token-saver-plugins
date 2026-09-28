/**
 * loop executor: iterate a container body sequentially. The container's inner
 * variables (item/index/loop vars) are one shared object, so `assign` writes
 * persist across rounds and `break`/`continue` control the loop.
 *
 * @module @dsh-plugins/flow/host/executors/loop
 */

import type { FlowNode, JsonValue } from '../../spec/types.ts'
import { resolveRef, resolveRefFromOutputs } from '../engine/frames.ts'
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
      sharedInner[variable.name] = initial === null ? null : initial
    }

    const maxIterations = node.data.maxIterations
    let count: number
    if (node.data.mode === 'array') {
      const array = resolveRef(ctx.frame, node.data.array ?? { kind: 'literal', value: [] })
      if (!Array.isArray(array)) throw new NodeError('INPUT_TYPE', 'loop array mode requires an array')
      if (array.length > maxIterations) throw new NodeError('LOOP_LIMIT', `array of ${array.length} exceeds maxIterations ${maxIterations}`)
      count = array.length
    } else if (node.data.mode === 'count') {
      const rawCount = resolveRef(ctx.frame, node.data.count ?? { kind: 'literal', value: 0 })
      const num = typeof rawCount === 'number' ? rawCount : Number(rawCount)
      count = Math.min(Number.isFinite(num) ? Math.floor(num) : 0, maxIterations)
    } else {
      count = maxIterations
    }

    const collected: Record<string, JsonValue[]> = {}
    for (const output of node.data.outputs) collected[output.name] = []

    let iterations = 0
    while (iterations < count) {
      if (ctx.signal.aborted) throw new NodeError('RUN_CANCELLED', 'run cancelled')
      const array = node.data.mode === 'array' ? resolveRef(ctx.frame, node.data.array ?? { kind: 'literal', value: [] }) : []
      sharedInner.item = Array.isArray(array) ? array[iterations] ?? null : null
      sharedInner.index = iterations
      const result = await ctx.runScope(node, sharedInner)
      if (result.failed && result.error !== undefined) {
        throw new NodeError(result.error.code, result.error.message, false)
      }
      for (const output of node.data.outputs) {
        const value = resolveRefFromOutputs(result.nodeOutputs, output.value)
        ;(collected[output.name] ??= []).push(value)
      }
      if (result.control === 'break') break
      iterations++
    }

    const outputs: Record<string, JsonValue> = { ...collected }
    for (const variable of node.data.variables) {
      outputs[variable.name] = sharedInner[variable.name] ?? null
    }
    return { outputs }
  },
}
