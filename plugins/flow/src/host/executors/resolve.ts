/**
 * Shared executor helpers: resolve a node's named inputs from the frame chain
 * and coerce them to the declared schema. Inputs that fail coercion raise a
 * non-retryable `NodeError`.
 *
 * @module @dsh-plugins/flow/host/executors/resolve
 */

import type { FlowNode, InputBinding, JsonValue, VarSchema } from '../../spec/types.ts'
import { coerce } from '../../spec/coerce.ts'
import { iterBindings } from '../../spec/validate.ts'
import { resolveRef, type Frame } from '../engine/frames.ts'
import { NodeError } from '../engine/budget.ts'

/** Resolve and coerce a node's named inputs from the frame chain. */
export function resolveInputs(node: FlowNode, frame: Frame): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const binding of iterBindings(node)) {
    const raw = resolveRef(frame, binding.value)
    if (raw === null && (binding.required ?? true)) {
      throw new NodeError('INPUT_TYPE', `required input "${binding.name}" is null or missing`)
    }
    const coerced = coerce(raw ?? null, binding.schema)
    if (!coerced.ok) throw new NodeError('INPUT_TYPE', `input "${binding.name}": ${coerced.reason}`)
    out[binding.name] = coerced.value
  }
  return out
}

/** Coerce a single value against a schema, raising a typed NodeError on failure. */
export function coerceOrThrow(value: unknown, schema: VarSchema, code: string, label: string): JsonValue {
  const coerced = coerce(value, schema)
  if (!coerced.ok) throw new NodeError(code, `${label}: ${coerced.reason}`)
  return coerced.value
}

/** Resolve a single value source to a JsonValue. */
export function resolveSource(frame: Frame, source: InputBinding['value']): JsonValue {
  return resolveRef(frame, source)
}
