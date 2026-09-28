import { describe, expect, it } from 'vitest'
import type { FlowDocument, FlowLookup } from '../src/spec/types.ts'
import { validateFlow } from '../src/spec/validate.ts'

const lookup: FlowLookup = () => undefined

function doc(nodes: FlowDocument['nodes'], edges: FlowDocument['edges']): FlowDocument {
  return { schemaVersion: 1, id: 'flow-1', name: 'f', description: '', nodes, edges, revision: 1, updatedAt: 0 }
}

function base(): FlowDocument {
  return doc(
    [
      { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [] } },
      { id: 'end', type: 'end', title: 'E', position: { x: 0, y: 0 }, data: { mode: 'variables', inputs: [] } },
    ],
    [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'end' }],
  )
}

function codes(flow: FlowDocument): string[] {
  return validateFlow(flow, lookup).map(issue => issue.code)
}

describe('validateFlow', () => {
  it('passes a minimal valid flow', () => {
    expect(codes(base())).toEqual([])
  })

  it('flags START_COUNT / END_COUNT', () => {
    const flow = base()
    flow.nodes.push({ id: 'start2', type: 'start', title: 'S2', position: { x: 0, y: 0 }, data: { fields: [] } })
    expect(codes(flow)).toContain('START_COUNT')
  })

  it('flags DUPLICATE_ID', () => {
    const flow = base()
    flow.nodes.push({ id: 'end', type: 'llm', title: 'L', position: { x: 0, y: 0 }, data: { inputs: [], system: '', prompt: 'x', output: { format: 'text' } } })
    expect(codes(flow)).toContain('DUPLICATE_ID')
  })

  it('flags BAD_ID for a bad node id', () => {
    const flow = base()
    flow.nodes[0].id = 'bad id!'
    expect(codes(flow)).toContain('BAD_ID')
  })

  it('flags UNKNOWN_PORT', () => {
    const flow = base()
    flow.edges[0].sourceHandle = 'nope'
    expect(codes(flow)).toContain('UNKNOWN_PORT')
  })

  it('flags CROSS_SCOPE_EDGE', () => {
    const flow = doc(
      [
        { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [] } },
        { id: 'loop', type: 'loop', title: 'L', position: { x: 0, y: 0 }, data: { mode: 'count', count: { kind: 'literal', value: 1 }, maxIterations: 5, variables: [], outputs: [] } },
        { id: 'end', type: 'end', title: 'E', position: { x: 0, y: 0 }, parentId: 'loop', data: { mode: 'variables', inputs: [] } },
      ],
      [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'end' }],
    )
    expect(codes(flow)).toContain('CROSS_SCOPE_EDGE')
  })

  it('flags CYCLE', () => {
    const flow = doc(
      [
        { id: 'a', type: 'llm', title: 'A', position: { x: 0, y: 0 }, data: { inputs: [], system: '', prompt: 'x', output: { format: 'text' } } },
        { id: 'b', type: 'llm', title: 'B', position: { x: 0, y: 0 }, data: { inputs: [], system: '', prompt: 'x', output: { format: 'text' } } },
      ],
      [
        { id: 'e1', source: 'a', sourceHandle: 'next', target: 'b' },
        { id: 'e2', source: 'b', sourceHandle: 'next', target: 'a' },
      ],
    )
    expect(codes(flow)).toContain('CYCLE')
  })

  it('flags BAD_PARENT when parent is not a container', () => {
    const flow = doc(
      [
        { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [] } },
        { id: 'llm', type: 'llm', title: 'L', position: { x: 0, y: 0 }, parentId: 'start', data: { inputs: [], system: '', prompt: 'x', output: { format: 'text' } } },
      ],
      [],
    )
    expect(codes(flow)).toContain('BAD_PARENT')
  })

  it('flags UNREACHABLE as a warning', () => {
    const flow = base()
    flow.nodes.push({ id: 'orphan', type: 'llm', title: 'O', position: { x: 0, y: 0 }, data: { inputs: [], system: '', prompt: 'x', output: { format: 'text' } } })
    const issues = validateFlow(flow, lookup)
    expect(issues.some(issue => issue.code === 'UNREACHABLE' && issue.severity === 'warning')).toBe(true)
  })

  it('flags END_UNREACHABLE', () => {
    const flow = doc(
      [
        { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [] } },
        { id: 'end', type: 'end', title: 'E', position: { x: 0, y: 0 }, data: { mode: 'variables', inputs: [] } },
      ],
      [],
    )
    expect(codes(flow)).toContain('END_UNREACHABLE')
  })

  it('flags DANGLING_REF for a missing node', () => {
    const flow = doc(
      [
        { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [] } },
        { id: 'llm', type: 'llm', title: 'L', position: { x: 0, y: 0 }, data: { inputs: [{ name: 'x', schema: { type: 'string' }, value: { kind: 'ref', node: 'ghost', source: 'output', path: ['text'] } }], system: '', prompt: '{{x}}', output: { format: 'text' } } },
        { id: 'end', type: 'end', title: 'E', position: { x: 0, y: 0 }, data: { mode: 'variables', inputs: [] } },
      ],
      [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'llm' },
        { id: 'e2', source: 'llm', sourceHandle: 'next', target: 'end' },
      ],
    )
    expect(codes(flow)).toContain('DANGLING_REF')
  })

  it('flags NOT_ANCESTOR for a forward reference', () => {
    const flow = doc(
      [
        { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [] } },
        { id: 'llm1', type: 'llm', title: 'L1', position: { x: 0, y: 0 }, data: { inputs: [{ name: 'x', schema: { type: 'string' }, value: { kind: 'ref', node: 'llm2', source: 'output', path: ['text'] } }], system: '', prompt: '{{x}}', output: { format: 'text' } } },
        { id: 'llm2', type: 'llm', title: 'L2', position: { x: 0, y: 0 }, data: { inputs: [], system: '', prompt: 'p', output: { format: 'text' } } },
        { id: 'end', type: 'end', title: 'E', position: { x: 0, y: 0 }, data: { mode: 'variables', inputs: [] } },
      ],
      [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'llm1' },
        { id: 'e2', source: 'llm1', sourceHandle: 'next', target: 'llm2' },
        { id: 'e3', source: 'llm2', sourceHandle: 'next', target: 'end' },
      ],
    )
    expect(codes(flow)).toContain('NOT_ANCESTOR')
  })

  it('flags TYPE_MISMATCH', () => {
    const flow = doc(
      [
        { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [{ name: 'n', schema: { type: 'string' } }] } },
        { id: 'llm', type: 'llm', title: 'L', position: { x: 0, y: 0 }, data: { inputs: [{ name: 'n', schema: { type: 'integer' }, value: { kind: 'ref', node: 'start', source: 'output', path: ['n'] } }], system: '', prompt: '{{n}}', output: { format: 'text' } } },
        { id: 'end', type: 'end', title: 'E', position: { x: 0, y: 0 }, data: { mode: 'variables', inputs: [] } },
      ],
      [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'llm' },
        { id: 'e2', source: 'llm', sourceHandle: 'next', target: 'end' },
      ],
    )
    expect(codes(flow)).toContain('TYPE_MISMATCH')
  })

  it('flags TEMPLATE_UNKNOWN_VAR', () => {
    const flow = doc(
      [
        { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [] } },
        { id: 'llm', type: 'llm', title: 'L', position: { x: 0, y: 0 }, data: { inputs: [], system: '', prompt: '{{unknown}}', output: { format: 'text' } } },
        { id: 'end', type: 'end', title: 'E', position: { x: 0, y: 0 }, data: { mode: 'variables', inputs: [] } },
      ],
      [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'llm' },
        { id: 'e2', source: 'llm', sourceHandle: 'next', target: 'end' },
      ],
    )
    expect(codes(flow)).toContain('TEMPLATE_UNKNOWN_VAR')
  })

  it('flags BAD_REGEX for an invalid matches pattern', () => {
    const flow = doc(
      [
        { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [] } },
        { id: 'cond', type: 'condition', title: 'C', position: { x: 0, y: 0 }, data: { branches: [{ id: 'b1', label: 'B', logic: 'and', conditions: [{ left: { kind: 'literal', value: 'x' }, op: 'matches', right: { kind: 'literal', value: '[' } }] }] } },
        { id: 'end', type: 'end', title: 'E', position: { x: 0, y: 0 }, data: { mode: 'variables', inputs: [] } },
      ],
      [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'cond' },
        { id: 'e2', source: 'cond', sourceHandle: 'else', target: 'end' },
      ],
    )
    expect(codes(flow)).toContain('BAD_REGEX')
  })

  it('flags BAD_LIMIT for a loop over the configured max', () => {
    const flow = doc(
      [
        { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [] } },
        { id: 'loop', type: 'loop', title: 'L', position: { x: 0, y: 0 }, data: { mode: 'count', count: { kind: 'literal', value: 1 }, maxIterations: 999, variables: [], outputs: [] } },
        { id: 'end', type: 'end', title: 'E', position: { x: 0, y: 0 }, data: { mode: 'variables', inputs: [] } },
      ],
      [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'loop' },
        { id: 'e2', source: 'loop', sourceHandle: 'next', target: 'end' },
      ],
    )
    const issues = validateFlow(flow, lookup, { maxLoopIterations: 10 })
    expect(issues.map(issue => issue.code)).toContain('BAD_LIMIT')
  })

  it('flags LOOP_BODY_EMPTY', () => {
    const flow = doc(
      [
        { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [] } },
        { id: 'loop', type: 'loop', title: 'L', position: { x: 0, y: 0 }, data: { mode: 'count', count: { kind: 'literal', value: 1 }, maxIterations: 5, variables: [], outputs: [] } },
        { id: 'end', type: 'end', title: 'E', position: { x: 0, y: 0 }, data: { mode: 'variables', inputs: [] } },
      ],
      [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'loop' },
        { id: 'e2', source: 'loop', sourceHandle: 'next', target: 'end' },
      ],
    )
    expect(codes(flow)).toContain('LOOP_BODY_EMPTY')
  })
})
