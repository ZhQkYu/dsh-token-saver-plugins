/**
 * Record-time value handling: redact sensitive keys and truncate oversized
 * values before they are persisted or pushed to the UI. This affects only the
 * recorded event, never the value handed to a downstream node.
 *
 * @module @dsh-plugins/flow/host/engine/record
 */

import type { JsonValue } from '../../spec/types.ts'

/** Keys whose values are replaced with `[redacted]`. */
const REDACT_PATTERN = /authorization|cookie|set-cookie|api[-_]?key|token|secret|password|passwd|credential/i

/** Replace sensitive values in place in a deep copy of a value. */
export function redact(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => redact(item))
  const out: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (REDACT_PATTERN.test(key)) {
      out[key] = '[redacted]'
    } else {
      out[key] = redact(item)
    }
  }
  return out
}

/** Truncate a value to at most `maxChars`, adding a marker for the cut. */
export function truncate(value: JsonValue, maxChars: number): JsonValue {
  if (typeof value === 'string') {
    if (value.length <= maxChars) return value
    return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`
  }
  if (value === null || typeof value !== 'object') return value
  const serialized = JSON.stringify(value)
  if (serialized.length <= maxChars) return value
  return { $truncated: true, preview: serialized.slice(0, maxChars) }
}

/** Redact then truncate a value for recording. */
export function recordValue(value: JsonValue, maxChars: number): JsonValue {
  return truncate(redact(value), maxChars)
}
