/**
 * Condition operator evaluation, aligned with Coze's selector operators plus
 * `matches` (regex). Pure and dependency-free.
 *
 * @module @dsh-plugins/flow/spec/conditions
 */

import type { ConditionOp, JsonValue } from './types.ts'

/** Options that affect condition evaluation. */
export interface ConditionOptions {
  /** Left-value length cap for `matches`, to bound ReDoS. Default 100000. */
  maxRegexInputChars?: number
}

/** The result of evaluating one condition. */
export interface ConditionEval {
  result: boolean
  warning?: string
}

/** Operators that take no right-hand value. */
const UNARY_OPS = new Set<ConditionOp>(['empty', 'not_empty', 'is_true', 'is_false'])

/** Evaluate one condition operator against left and (optional) right values. */
export function evaluateOp(op: ConditionOp, left: JsonValue, right: JsonValue | undefined, options: ConditionOptions = {}): ConditionEval {
  const maxRegexInputChars = options.maxRegexInputChars ?? 100_000
  switch (op) {
    case 'eq': return { result: valueEq(left, right) }
    case 'ne': return { result: !valueEq(left, right) }
    case 'gt': return ordered(left, right, c => c > 0)
    case 'ge': return ordered(left, right, c => c >= 0)
    case 'lt': return ordered(left, right, c => c < 0)
    case 'le': return ordered(left, right, c => c <= 0)
    case 'contains': return { result: contains(left, right) }
    case 'not_contains': return { result: !contains(left, right) }
    case 'contains_key': return { result: containsKey(left, right) }
    case 'not_contains_key': return { result: !containsKey(left, right) }
    case 'empty': return { result: isEmpty(left) }
    case 'not_empty': return { result: !isEmpty(left) }
    case 'is_true': return { result: left === true }
    case 'is_false': return { result: left === false }
    case 'len_gt': return { result: lengthOf(left) > numeric(right) }
    case 'len_ge': return { result: lengthOf(left) >= numeric(right) }
    case 'len_lt': return { result: lengthOf(left) < numeric(right) }
    case 'len_le': return { result: lengthOf(left) <= numeric(right) }
    case 'matches': return evaluateMatches(left, right, maxRegexInputChars)
  }
}

/** Whether an operator takes a right-hand value. */
export function isUnary(op: ConditionOp): boolean {
  return UNARY_OPS.has(op)
}

function valueEq(left: JsonValue, right: JsonValue | undefined): boolean {
  if (right === undefined) return left === null || left === undefined
  if (typeof left === 'number' && typeof right === 'number') return left === right
  if (typeof left === 'string' && typeof right === 'string') return left === right
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right
  if (left === null || left === undefined) return right === null || right === undefined
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Order two values. Two strings compare as text; when either side is a number, both must
 * convert to finite numbers, so `"10" > 9` is numeric. Null, missing, or mixed
 * non-numeric values are false with a warning instead of a text comparison.
 */
function ordered(left: JsonValue, right: JsonValue | undefined, test: (cmp: number) => boolean): ConditionEval {
  if (typeof left === 'string' && typeof right === 'string') return { result: test(left < right ? -1 : left > right ? 1 : 0) }
  const l = toNumber(left)
  const r = toNumber(right)
  if (l === undefined || r === undefined) return { result: false, warning: 'ordering comparison needs two numbers or two strings' }
  return { result: test(l - r) }
}

function toNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : undefined
  }
  return undefined
}

function contains(left: JsonValue, right: JsonValue | undefined): boolean {
  if (typeof left === 'string') return right !== undefined && left.includes(String(right))
  if (Array.isArray(left)) return left.some(item => valueEq(item, right))
  return false
}

function containsKey(left: JsonValue, right: JsonValue | undefined): boolean {
  if (left === null || typeof left !== 'object' || Array.isArray(left)) return false
  return right !== undefined && Object.prototype.hasOwnProperty.call(left, String(right))
}

function isEmpty(value: JsonValue): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.length === 0
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

function lengthOf(value: JsonValue): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.length
  if (typeof value === 'object' && value !== null) return Object.keys(value).length
  return 0
}

function numeric(value: JsonValue | undefined): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : 0
}

function evaluateMatches(left: JsonValue, right: JsonValue | undefined, maxChars: number): ConditionEval {
  if (right === undefined || typeof right !== 'string') return { result: false, warning: 'matches requires a string pattern' }
  if (typeof left !== 'string') return { result: false, warning: 'matches requires a string input' }
  if (left.length > maxChars) return { result: false, warning: `matches input exceeds ${maxChars} characters` }
  try {
    const regex = new RegExp(right, 'u')
    return { result: regex.test(left) }
  } catch {
    return { result: false, warning: 'matches pattern is not a valid regex' }
  }
}
