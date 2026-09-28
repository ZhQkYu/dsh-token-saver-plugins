/**
 * batch executor: run a container body in parallel over an array, bounded by
 * concurrency. Outputs are collected by index order. The first failing item
 * aborts the items still running and fails the batch with that item's error.
 *
 * @module @dsh-plugins/flow/host/executors/batch
 */

import type { FlowNode, JsonValue } from '../../spec/types.ts'
import { resolveRef, resolveRefFromOutputs } from '../engine/frames.ts'
import { NodeError } from '../engine/budget.ts'
import { RunAbort } from '../engine/scheduler.ts'
import type { ExecResult, FrameResult, NodeExecutor } from './index.ts'

type BatchNode = Extract<FlowNode, { type: 'batch' }>

/** The batch executor. */
export const batchExecutor: NodeExecutor<BatchNode> = {
  type: 'batch',
  async execute(node, _inputs, ctx): Promise<ExecResult> {
    const array = resolveRef(ctx.frame, node.data.array)
    if (!Array.isArray(array)) throw new NodeError('INPUT_TYPE', 'batch requires an array')
    const maxItems = Math.min(node.data.maxItems, ctx.limits.maxBatchItems)
    if (array.length > maxItems) throw new NodeError('LOOP_LIMIT', `array of ${array.length} items exceeds maxItems ${maxItems}`)

    const failFast = new AbortController()
    const signal = AbortSignal.any([ctx.signal, failFast.signal])
    const results: (FrameResult | undefined)[] = new Array(array.length).fill(undefined)
    let firstError: { code: string; message: string; index: number } | undefined
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < array.length && !signal.aborted) {
        const index = next++
        const result = await ctx.runScope(node, { item: array[index] ?? null, index }, index, signal)
        results[index] = result
        if (result.error !== undefined && firstError === undefined) {
          firstError = { ...result.error, index }
          failFast.abort(new RunAbort('sibling'))
        }
      }
    }
    const concurrency = Math.max(1, Math.min(node.data.concurrency, ctx.limits.maxBatchConcurrency, array.length))
    await Promise.all(Array.from({ length: concurrency }, () => worker()))

    if (firstError !== undefined) throw new NodeError(firstError.code, `item ${firstError.index}: ${firstError.message}`, false)
    ctx.signal.throwIfAborted()

    const collected: Record<string, JsonValue[]> = {}
    for (const output of node.data.outputs) collected[output.name] = []
    for (const [index, result] of results.entries()) {
      if (result === undefined) throw new NodeError('BATCH_ITEM_FAILED', `batch item ${index} did not run`)
      for (const output of node.data.outputs) {
        ;(collected[output.name] ??= []).push(resolveRefFromOutputs(result.nodeOutputs, output.value))
      }
    }
    return { outputs: collected }
  },
}
