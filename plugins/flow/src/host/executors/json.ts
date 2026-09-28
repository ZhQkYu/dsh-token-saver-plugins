/**
 * json executor: parse (JSON string to value) or stringify (value to text).
 *
 * @module @dsh-plugins/flow/host/executors/json
 */

import type { FlowNode } from '../../spec/types.ts'
import { coerce } from '../../spec/coerce.ts'
import { resolveRef } from '../engine/frames.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type JsonNode = Extract<FlowNode, { type: 'json' }>

/** The json executor. */
export const jsonExecutor: NodeExecutor<JsonNode> = {
  type: 'json',
  async execute(node, _inputs, ctx): Promise<ExecResult> {
    const raw = resolveRef(ctx.frame, node.data.input)
    if (node.data.op === 'parse') {
      if (typeof raw !== 'string') throw new NodeError('INPUT_TYPE', 'json.parse requires a string input')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new NodeError('OUTPUT_TYPE', 'input is not valid JSON', true)
      }
      const outputs = node.data.outputs ?? [{ name: 'value', schema: { type: 'any' } }]
      const result: Record<string, unknown> = {}
      for (const field of outputs) {
        const value = field.name === 'value' ? parsed : (parsed as Record<string, unknown>)[field.name]
        const coerced = coerce(value ?? null, field.schema)
        if (!coerced.ok) throw new NodeError('OUTPUT_TYPE', `json.parse field "${field.name}": ${coerced.reason}`)
        result[field.name] = coerced.value
      }
      return { outputs: result as Record<string, import('../../spec/types.ts').JsonValue> }
    }
    const text = node.data.pretty ? JSON.stringify(raw, null, 2) : JSON.stringify(raw)
    return { outputs: { text } }
  },
}
