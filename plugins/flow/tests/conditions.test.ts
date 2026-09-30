import { describe, expect, it } from 'vitest'
import { evaluateOp, isUnary } from '../src/spec/conditions.ts'

describe('evaluateOp', () => {
  it('eq/ne', () => {
    expect(evaluateOp('eq', 1, 1).result).toBe(true)
    expect(evaluateOp('ne', 1, 2).result).toBe(true)
  })

  it('gt/ge/lt/le numeric', () => {
    expect(evaluateOp('gt', 2, 1).result).toBe(true)
    expect(evaluateOp('ge', 1, 1).result).toBe(true)
    expect(evaluateOp('lt', 1, 2).result).toBe(true)
    // Numeric strings compare as numbers; null never orders.
    expect(evaluateOp('gt', '10', 9).result).toBe(true)
    const nullCmp = evaluateOp('lt', null, 5)
    expect(nullCmp.result).toBe(false)
    expect(nullCmp.warning).toBeDefined()
    expect(evaluateOp('lt', 'a', 'b').result).toBe(true)
    expect(evaluateOp('le', 2, 1).result).toBe(false)
  })

  it('contains on string and array', () => {
    expect(evaluateOp('contains', 'hello', 'ell').result).toBe(true)
    expect(evaluateOp('contains', [1, 2, 3], 2).result).toBe(true)
    expect(evaluateOp('contains', [1, 2], 3).result).toBe(false)
  })

  it('contains_key', () => {
    expect(evaluateOp('contains_key', { a: 1 }, 'a').result).toBe(true)
    expect(evaluateOp('contains_key', { a: 1 }, 'b').result).toBe(false)
  })

  it('empty/not_empty', () => {
    expect(evaluateOp('empty', '', undefined).result).toBe(true)
    expect(evaluateOp('empty', [], undefined).result).toBe(true)
    expect(evaluateOp('not_empty', 'x', undefined).result).toBe(true)
  })

  it('is_true/is_false', () => {
    expect(evaluateOp('is_true', true, undefined).result).toBe(true)
    expect(evaluateOp('is_false', false, undefined).result).toBe(true)
  })

  it('len_gt/len_le', () => {
    expect(evaluateOp('len_gt', 'abcd', 3).result).toBe(true)
    expect(evaluateOp('len_le', [1, 2], 2).result).toBe(true)
  })

  it('matches with regex', () => {
    expect(evaluateOp('matches', 'abc123', '^[a-z]+\\d+$').result).toBe(true)
    expect(evaluateOp('matches', 'abc', '^\\d+$').result).toBe(false)
  })

  it('matches fails over the length cap with a warning', () => {
    const result = evaluateOp('matches', 'a'.repeat(100001), 'a', { maxRegexInputChars: 100000 })
    expect(result.result).toBe(false)
    expect(result.warning).toBeDefined()
  })

  it('marks unary operators', () => {
    expect(isUnary('empty')).toBe(true)
    expect(isUnary('eq')).toBe(false)
  })
})
