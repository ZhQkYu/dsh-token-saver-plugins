import { describe, expect, it } from 'vitest'
import { parseTemplate, renderTemplate, templateVariables } from '../src/spec/template.ts'

describe('parseTemplate', () => {
  it('parses text and variables', () => {
    expect(parseTemplate('hello {{name}}')).toEqual([
      { kind: 'text', text: 'hello ' },
      { kind: 'var', path: ['name'] },
    ])
  })

  it('parses dotted paths', () => {
    expect(parseTemplate('{{a.b.c}}')).toEqual([{ kind: 'var', path: ['a', 'b', 'c'] }])
  })

  it('escapes \\{{ to literal', () => {
    expect(parseTemplate('\\{{name}}')).toEqual([{ kind: 'text', text: '{{name}}' }])
  })

  it('escapes \\{{ in the middle of text', () => {
    expect(parseTemplate('a\\{{x}} {{y}}')).toEqual([
      { kind: 'text', text: 'a{{x}} ' },
      { kind: 'var', path: ['y'] },
    ])
    expect([...templateVariables('a\\{{x}}')]).toEqual([])
  })

  it('treats an unclosed placeholder as literal text', () => {
    expect(parseTemplate('x {{y')).toEqual([{ kind: 'text', text: 'x {{y' }])
  })
})

describe('templateVariables', () => {
  it('collects root names', () => {
    expect([...templateVariables('{{a}} {{b.c}}')]).toEqual(['a', 'b'])
  })
})

describe('renderTemplate', () => {
  it('renders strings, numbers, booleans, and JSON', () => {
    const { text } = renderTemplate('{{s}}|{{n}}|{{b}}|{{o}}', { s: 'x', n: 3, b: true, o: { k: 1 } })
    expect(text).toBe('x|3|true|{"k":1}')
  })

  it('renders missing/null as empty and warns', () => {
    const { text, warnings } = renderTemplate('a{{missing}}b', {})
    expect(text).toBe('ab')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('resolves nested object fields', () => {
    const { text } = renderTemplate('{{user.name}}', { user: { name: 'ada' } })
    expect(text).toBe('ada')
  })

  it('warns on a missing nested field', () => {
    const { text, warnings } = renderTemplate('{{user.name}}', { user: {} })
    expect(text).toBe('')
    expect(warnings.length).toBeGreaterThan(0)
  })
})
