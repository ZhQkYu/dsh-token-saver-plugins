import { describe, expect, it } from 'vitest'
import { coerce } from '../src/spec/coerce.ts'

describe('coerce', () => {
  it('keeps string as string', () => {
    expect(coerce('hi', { type: 'string' })).toEqual({ ok: true, value: 'hi' })
  })

  it('converts number/boolean to string', () => {
    expect(coerce(3, { type: 'string' })).toEqual({ ok: true, value: '3' })
    expect(coerce(true, { type: 'string' })).toEqual({ ok: true, value: 'true' })
  })

  it('converts a numeric string to number', () => {
    expect(coerce('4.5', { type: 'number' })).toEqual({ ok: true, value: 4.5 })
  })

  it('rejects a non-numeric string for number', () => {
    expect(coerce('abc', { type: 'number' }).ok).toBe(false)
  })

  it('rejects a decimal for integer', () => {
    expect(coerce(3.5, { type: 'integer' }).ok).toBe(false)
  })

  it('converts "true"/"false" to boolean', () => {
    expect(coerce('true', { type: 'boolean' })).toEqual({ ok: true, value: true })
    expect(coerce('false', { type: 'boolean' })).toEqual({ ok: true, value: false })
  })

  it('parses a JSON object string', () => {
    expect(coerce('{"a":1}', { type: 'object' })).toEqual({ ok: true, value: { a: 1 } })
  })

  it('rejects a missing required object field', () => {
    expect(coerce({ a: 1 }, { type: 'object', properties: [{ name: 'b', schema: { type: 'string' }, required: true }] }).ok).toBe(false)
  })

  it('coerces nested object fields', () => {
    const result = coerce({ a: '1' }, { type: 'object', properties: [{ name: 'a', schema: { type: 'integer' } }] })
    expect(result).toEqual({ ok: true, value: { a: 1 } })
  })

  it('parses a JSON array string', () => {
    expect(coerce('[1,2]', { type: 'array', items: { type: 'integer' } })).toEqual({ ok: true, value: [1, 2] })
  })

  it('rejects a non-integer array item', () => {
    expect(coerce([1.5], { type: 'array', items: { type: 'integer' } }).ok).toBe(false)
  })

  it('passes any through', () => {
    expect(coerce({ x: 1 }, { type: 'any' })).toEqual({ ok: true, value: { x: 1 } })
  })
})
