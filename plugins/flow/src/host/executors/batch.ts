/**
 * batch executor: run a container body in parallel over an array, bounded by
 * concurrency. Outputs are collected by index order; any item failure fails
 * the batch.
 *
 * @module @dsh-plugins/flow/host/executors/batch
 */

import type { FlowNode, JsonValue } from '../../spec/types.ts'
import { resolveRef, resolveRefFromOutputs } from '../engine/frames.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type BatchNode = Extract<FlowNode, { type: 'batch' }>

/** The batch executor. */
export const batchExecutor: NodeExecutor<BatchNode> = {
  type: 'batch',
  async execute(node, _inputs, ctx): Promise<ExecResult> {
    const array = resolveRef(ctx.frame, node.data.array)
    if (!Array.isArray(array)) throw new NodeError('INPUT_TYPE', 'batch requires an array')
    const items = array.slice(0, node.data.maxItems)
    if (array.length > node.data.maxItems) throw new NodeError('LOOP_LIMIT', `array of ${array.length} exceeds maxItems ${node.data.maxItems}`)

    const results: (import('../executors/index.ts').FrameResult | { failed: true; nodeOutputs: Map<string, Record<string, JsonValue>>; control?: undefined } | undefined)[] = new Array(items.length).fill(undefined)
    let next = 0
    const workers: Promise<void>[] = []
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const index = next++
        const inner: Record<string, JsonValue> = { item: items[index] ?? null, index }
        try {
          results[index] = await ctx.runScope(node, inner)
        } catch (error: unknown) {
          results[index] = { failed: true, nodeOutputs: new Map() }
          void error
        }
      }
    }
    const concurrency = Math.max(1, Math.min(node.data.concurrency, items.length))
    for (let i = 0; i < concurrency; i++) workers.push(worker())
    await Promise.all(workers)

    const collected: Record<string, JsonValue[]> = {}
    for (const output of node.data.outputs) collected[output.name] = []
    for (let index = 0; index < items.length; index++) {
      const result = results[index]
      if (result === undefined || result.failed) {
        throw new NodeError('BATCH_ITEM_FAILED', `batch item ${index} failed`)
      }
      for (const output of node.data.outputs) {
        const value = resolveRefFromOutputs(result.nodeOutputs, output.value)
        ;(collected[output.name] ??= []).push(value)
      }
    }
    return { outputs: collected }
  },
}
