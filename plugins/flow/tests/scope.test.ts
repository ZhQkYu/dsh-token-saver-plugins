import { describe, expect, it } from 'vitest'
import type { FlowDocument, FlowLookup } from '../src/spec/types.ts'
import { availableVariables, canReach, containerChainOf, isVisibleOutput, scopeOf } from '../src/spec/scope.ts'

const lookup: FlowLookup = () => undefined

function doc(nodes: FlowDocument['nodes'], edges: FlowDocument['edges']): FlowDocument {
  return { schemaVersion: 1, id: 'flow-1', name: 'f', description: '', nodes, edges, revision: 1, updatedAt: 0 }
}

const simple = doc(
  [
    { id: 'a', type: 'start', title: 'A', position: { x: 0, y: 0 }, data: { fields: [] } },
    { id: 'b', type: 'llm', title: 'B', position: { x: 0, y: 0 }, data: { inputs: [], system: '', prompt: '', output: { format: 'text' } } },
    { id: 'c', type: 'end', title: 'C', position: { x: 0, y: 0 }, data: { mode: 'variables', inputs: [] } },
  ],
  [
    { id: 'e1', source: 'a', sourceHandle: 'next', target: 'b' },
    { id: 'e2', source: 'b', sourceHandle: 'next', target: 'c' },
  ],
)

describe('scopeOf', () => {
  it('returns root for top-level nodes', () => {
    expect(scopeOf(simple, 'a')).toBe('root')
  })
})

describe('canReach', () => {
  it('detects a path', () => {
    expect(canReach(simple, 'a', 'c')).toBe(true)
    expect(canReach(simple, 'c', 'a')).toBe(false)
  })
})

describe('isVisibleOutput', () => {
  it('exposes only ancestors', () => {
    expect(isVisibleOutput(simple, 'a', 'b')).toBe(true)
    expect(isVisibleOutput(simple, 'b', 'a')).toBe(false)
    expect(isVisibleOutput(simple, 'a', 'c')).toBe(true)
  })
})

describe('containerChainOf', () => {
  it('finds the container chain', () => {
    const nested = doc(
      [
        { id: 'start', type: 'start', title: 'S', position: { x: 0, y: 0 }, data: { fields: [] } },
        { id: 'loop', type: 'loop', title: 'L', position: { x: 0, y: 0 }, data: { mode: 'count', count: { kind: 'literal', value: 1 }, maxIterations: 5, variables: [], outputs: [] } },
        { id: 'inner', type: 'llm', title: 'I', position: { x: 0, y: 0 }, parentId: 'loop', data: { inputs: [], system: '', prompt: '', output: { format: 'text' } } },
      ],
      [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'loop' },
        { id: 'e2', source: 'loop', sourceHandle: 'body', target: 'inner' },
      ],
    )
    expect(containerChainOf(nested, 'inner')).toEqual(['loop'])
    expect(containerChainOf(nested, 'loop')).toEqual([])
  })
})

describe('availableVariables', () => {
  it('groups same-scope ancestors', () => {
    const groups = availableVariables(simple, 'c', lookup)
    const nodeIds = groups.flatMap(group => group.nodes.map(n => n.nodeId))
    expect(nodeIds).toContain('a')
    expect(nodeIds).toContain('b')
  })
})
