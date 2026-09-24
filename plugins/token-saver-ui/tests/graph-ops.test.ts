import { describe, expect, it } from 'vitest'
import type { CanvasGraph, CanvasNode } from '@dsh-plugins/token-saver/protocol'
import { autoLayout, hasCycle, LAYOUT_GAP, reconcileBranchEdges, wouldCreateCycle } from '../src/client/graph-ops.ts'

function node(id: string, y = 0): CanvasNode {
  return { id, kind: 'task', title: id, instruction: '', config: {}, position: { x: 0, y } }
}

const chain = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]

describe('reconcileBranchEdges', () => {
  const gate: CanvasNode = { ...node('gate'), kind: 'condition', config: { branches: [{ id: 'yes', label: 'yes' }] } }
  const graphOf = (nodes: CanvasNode[], edges: CanvasGraph['edges']): CanvasGraph =>
    ({ version: 1, id: 'g', name: 'g', description: '', nodes, edges, updatedAt: 0 })

  it('returns the same graph when every edge is consistent', () => {
    const graph = graphOf([gate, node('a')], [{ id: 'e1', source: 'gate', target: 'a', sourceHandle: 'yes' }])
    expect(reconcileBranchEdges(graph)).toBe(graph)
  })

  it('moves unassigned condition edges to else and strips handles from plain sources', () => {
    const graph = graphOf([gate, node('a'), node('b')], [
      { id: 'e1', source: 'gate', target: 'a' },
      { id: 'e2', source: 'a', target: 'b', sourceHandle: 'yes' },
    ])
    expect(reconcileBranchEdges(graph).edges).toEqual([
      { id: 'e1', source: 'gate', target: 'a', sourceHandle: 'else' },
      { id: 'e2', source: 'a', target: 'b' },
    ])
  })

  it('drops edges of removed branches and collapses duplicates', () => {
    const graph = graphOf([gate, node('a')], [
      { id: 'e1', source: 'gate', target: 'a', sourceHandle: 'gone' },
      { id: 'e2', source: 'gate', target: 'a', sourceHandle: 'yes' },
      { id: 'e3', source: 'gate', target: 'a', sourceHandle: 'yes' },
    ])
    expect(reconcileBranchEdges(graph).edges.map(edge => edge.id)).toEqual(['e2'])
  })
})

describe('wouldCreateCycle', () => {
  it('rejects self loops and back edges', () => {
    expect(wouldCreateCycle(chain, 'a', 'a')).toBe(true)
    expect(wouldCreateCycle(chain, 'c', 'a')).toBe(true)
    expect(wouldCreateCycle(chain, 'c', 'b')).toBe(true)
  })

  it('accepts forward and unrelated edges', () => {
    expect(wouldCreateCycle(chain, 'a', 'c')).toBe(false)
    expect(wouldCreateCycle(chain, 'c', 'd')).toBe(false)
  })
})

describe('hasCycle', () => {
  it('detects cycles', () => {
    const nodes = ['a', 'b', 'c'].map(id => node(id))
    expect(hasCycle({ nodes, edges: [] })).toBe(false)
    expect(hasCycle({ nodes, edges: chain.map((edge, index) => ({ id: `e${index}`, ...edge })) })).toBe(false)
    expect(hasCycle({ nodes, edges: [...chain, { source: 'c', target: 'a' }].map((edge, index) => ({ id: `e${index}`, ...edge })) })).toBe(true)
  })
})

describe('autoLayout', () => {
  it('places each node in the column of its longest incoming path', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')]
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
      { id: 'e3', source: 'a', target: 'c' },
      { id: 'e4', source: 'a', target: 'd' },
    ]
    const positions = autoLayout({ nodes, edges })
    expect(positions.get('a')?.x).toBe(40)
    expect(positions.get('b')?.x).toBe(40 + LAYOUT_GAP.x)
    expect(positions.get('d')?.x).toBe(40 + LAYOUT_GAP.x)
    expect(positions.get('c')?.x).toBe(40 + 2 * LAYOUT_GAP.x)
  })

  it('keeps the current vertical order within a column', () => {
    const nodes = [node('root'), node('low', 500), node('high', -500)]
    const edges = [{ id: 'e1', source: 'root', target: 'low' }, { id: 'e2', source: 'root', target: 'high' }]
    const positions = autoLayout({ nodes, edges })
    expect(positions.get('high')?.y).toBe(40)
    expect(positions.get('low')?.y).toBe(40 + LAYOUT_GAP.y)
  })
})
