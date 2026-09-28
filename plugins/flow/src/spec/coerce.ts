/**
 * Value validation and loose conversion against a {@link VarSchema}. Bound
 * values are coerced before entering a node and node outputs are coerced
 * before leaving, so downstream consumers always see the declared type.
 *
 * @module @dsh-plugins/flow/spec/coerce
 */

import type { JsonValue, VarField, VarSchema } from './types.ts'

/** The result of a coercion: the converted value, or a failure reason. */
export type CoerceResult = { ok: true; value: JsonValue } | { ok: false; reason: string }

/** Coerce a value to match a schema, applying the loose conversions in the plan. */
export function coerce(value: unknown, schema: VarSchema): CoerceResult {
  switch (schema.type) {
    case 'any': return { ok: true, value: toJson(value) }
    case 'string': return coerceString(value)
    case 'number': return coerceNumber(value, false)
    case 'integer': return coerceNumber(value, true)
    case 'boolean': return coerceBoolean(value)
    case 'object': return coerceObject(value, schema)
    case 'array': return coerceArray(value, schema)
  }
}

function toJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function coerceString(value: unknown): CoerceResult {
  if (typeof value === 'string') return { ok: true, value }
  if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) }
  if (value !== null && typeof value === 'object') return { ok: true, value: JSON.stringify(value) }
  return { ok: false, reason: `expected string, got ${describe(value)}` }
}

function coerceNumber(value: unknown, integer: boolean): CoerceResult {
  let num: number
  if (typeof value === 'number') {
    num = value
  } else if (typeof value === 'string' && value.trim() !== '') {
    num = Number(value)
    if (Number.isNaN(num)) return { ok: false, reason: `expected number, got string "${value}"` }
  } else {
    return { ok: false, reason: `expected ${integer ? 'integer' : 'number'}, got ${describe(value)}` }
  }
  if (!Number.isFinite(num)) return { ok: false, reason: 'number is not finite' }
  if (integer && !Number.isInteger(num)) return { ok: false, reason: `expected integer, got ${num}` }
  return { ok: true, value: integer ? Math.trunc(num) : num }
}

function coerceBoolean(value: unknown): CoerceResult {
  if (typeof value === 'boolean') return { ok: true, value }
  if (value === 'true') return { ok: true, value: true }
  if (value === 'false') return { ok: true, value: false }
  return { ok: false, reason: `expected boolean, got ${describe(value)}` }
}

function coerceObject(value: unknown, schema: VarSchema): CoerceResult {
  let obj: Record<string, JsonValue>
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    // Shallow-copy so coercion never mutates the caller's object (R4): a
    // downstream node's type conversion must not change what an upstream node
    // stored in the frame.
    obj = { ...(value as Record<string, JsonValue>) }
  } else if (typeof value === 'string') {
    const parsed = safeParseJson(value)
    if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'expected object or JSON object string' }
    }
    obj = parsed as Record<string, JsonValue>
  } else {
    return { ok: false, reason: `expected object, got ${describe(value)}` }
  }
  const fields = schema.properties ?? []
  for (const field of fields) {
    const fieldValue = obj[field.name]
    if (fieldValue === undefined || fieldValue === null) {
      if (field.required) return { ok: false, reason: `missing required field "${field.name}"` }
      continue
    }
    const nested = coerce(fieldValue, field.schema)
    if (!nested.ok) return { ok: false, reason: `field "${field.name}": ${nested.reason}` }
    obj[field.name] = nested.value
  }
  return { ok: true, value: obj }
}

function coerceArray(value: unknown, schema: VarSchema): CoerceResult {
  let arr: JsonValue[]
  if (Array.isArray(value)) {
    arr = value as JsonValue[]
  } else if (typeof value === 'string') {
    const parsed = safeParseJson(value)
    if (!Array.isArray(parsed)) return { ok: false, reason: 'expected array or JSON array string' }
    arr = parsed
  } else {
    return { ok: false, reason: `expected array, got ${describe(value)}` }
  }
  if (schema.items === undefined) return { ok: true, value: arr }
  const out: JsonValue[] = []
  for (let i = 0; i < arr.length; i++) {
    const nested = coerce(arr[i], schema.items)
    if (!nested.ok) return { ok: false, reason: `item ${i}: ${nested.reason}` }
    out.push(nested.value)
  }
  return { ok: true, value: out }
}

/** Coerce an object against a set of fields, used for start inputs and end outputs. */
export function coerceFields(value: unknown, fields: readonly VarField[]): CoerceResult {
  const obj = coerceObject(value, { type: 'object', properties: [...fields] })
  if (!obj.ok) return obj
  return { ok: true, value: obj.value }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
