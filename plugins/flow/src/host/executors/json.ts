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
      // Coerce non-string input to string first (e.g. a number becomes "5").
      const text = typeof raw === 'string' ? raw : raw === null ? '' : JSON.stringify(raw)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new NodeError('JSON_PARSE', 'input is not valid JSON', false)
      }
      const outputs = node.data.outputs ?? [{ name: 'value', schema: { type: 'any' } }]
      const result: Record<string, unknown> = {}
      for (const field of outputs) {
        if (field.name !== 'value' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
          throw new NodeError('OUTPUT_TYPE', `json.parse field "${field.name}" requires an object root`)
        }
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
