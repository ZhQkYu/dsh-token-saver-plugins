import { describe, expect, it } from 'vitest'
import { formatPath, parsePath, renderTemplate } from '../src/spec/template.ts'
import { fieldsFromValue, schemaFromValue } from '../src/spec/var-schema.ts'
import { resolveRefFromOutputs } from '../src/host/engine/frames.ts'
import { toolSpec } from '../src/spec/nodes/tool.ts'
import { iterBindings, iterTemplates } from '../src/spec/validate.ts'
import type { FlowNode } from '../src/spec/types.ts'

describe('member paths', () => {
  it('parses and formats array indices', () => {
    expect(parsePath('a.items[0].name')).toEqual(['a', 'items', '0', 'name'])
    expect(parsePath('a.items.0.name')).toEqual(['a', 'items', '0', 'name'])
    expect(formatPath(['a', 'items', '0', 'name'])).toBe('a.items[0].name')
  })

  it('renders templates through arrays', () => {
    const out = renderTemplate('{{r.items[1].n}}/{{r.items.0.n}}', { r: { items: [{ n: 'x' }, { n: 'y' }] } })
    expect(out.text).toBe('y/x')
    expect(out.warnings).toEqual([])
  })

  it('resolves refs through arrays', () => {
    const outputs = new Map([['n1', { value: { list: [{ id: 7 }] } }]])
    expect(resolveRefFromOutputs(outputs, { kind: 'ref', node: 'n1', source: 'output', path: ['value', 'list', '0', 'id'] })).toBe(7)
    expect(resolveRefFromOutputs(outputs, { kind: 'ref', node: 'n1', source: 'output', path: ['value', 'list', '5', 'id'] })).toBe(null)
  })

  it('infers schemas from sample values', () => {
    expect(schemaFromValue({ a: [{ b: 1.5 }], c: 'x' })).toEqual({
      type: 'object',
      properties: [
        { name: 'a', schema: { type: 'array', items: { type: 'object', properties: [{ name: 'b', schema: { type: 'number' } }] } } },
        { name: 'c', schema: { type: 'string' } },
      ],
    })
    expect(fieldsFromValue([1])).toEqual([])
  })
})

describe('tool node typing', () => {
  const node: Extract<FlowNode, { type: 'tool' }> = {
    id: 't', type: 'tool', title: 'T', position: { x: 0, y: 0 },
    data: {
      tool: 'web_ai_ask',
      args: [{ name: 'prompt', schema: { type: 'string' }, value: { kind: 'literal', value: 'Summarize {{doc.title}}' } }],
      inputs: [{ name: 'doc', schema: { type: 'any' }, value: { kind: 'ref', node: 'x', source: 'output', path: ['value'] } }],
      outputs: [{ name: 'answer', schema: { type: 'string' } }],
    },
  }

  it('declared outputs shape value', () => {
    expect(toolSpec.outputs(node, () => undefined)[1]).toEqual({ name: 'value', schema: { type: 'object', properties: [{ name: 'answer', schema: { type: 'string' } }] } })
  })

  it('exposes templated args and template inputs', () => {
    expect(iterBindings(node).map(b => b.name)).toEqual(['prompt', 'doc'])
    expect(iterTemplates(node)).toEqual([{ template: 'Summarize {{doc.title}}', field: 'args.0.value', name: 'prompt' }])
  })
})
