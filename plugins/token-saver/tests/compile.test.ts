import { describe, expect, it } from 'vitest'
import { compileGraph, hintFor, CanvasError } from '../src/workflow-canvas/compile.ts'
import type { CanvasGraph } from '../src/protocol.ts'

function graph(nodes: CanvasGraph['nodes'], edges: CanvasGraph['edges']): CanvasGraph {
  return { version: 1, id: 'g1', name: 'g', description: '', nodes, edges, updatedAt: 1 }
}

function node(id: string, kind: CanvasGraph['nodes'][number]['kind'], y = 0, x = 0) {
  return { id, kind, title: id, instruction: `do ${id}`, config: {}, position: { x, y } }
}

describe('compileGraph', () => {
  it('orders by dependency and then position', () => {
    const g = graph(
      [node('a', 'task', 0, 0), node('b', 'task', 0, 1), node('c', 'task', 1, 0)],
      [{ id: 'e1', source: 'a', target: 'c' }],
    )
    const { steps } = compileGraph(g)
    const ids = steps.map(step => step.nodeId)
    // a before c (dependency); b is independent, ordered by y then x
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'))
  })

  it('detects a cycle', () => {
    const g = graph(
      [node('a', 'task'), node('b', 'task')],
      [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }],
    )
    expect(() => compileGraph(g)).toThrow(CanvasError)
    expect(() => compileGraph(g)).toThrow(/cycle/)
  })

  it('rejects a dangling edge', () => {
    const g = graph([node('a', 'task')], [{ id: 'e1', source: 'a', target: 'missing' }])
    expect(() => compileGraph(g)).toThrow(/does not exist/)
  })

  it('rejects too many nodes', () => {
    const nodes = Array.from({ length: 201 }, (_, i) => node(`n${i}`, 'task', i, 0))
    expect(() => compileGraph(graph(nodes, []), 200, 500)).toThrow(/limit/)
  })

  it('generates a web-ai hint', () => {
    expect(hintFor('web-ai', { provider: 'doubao' })).toContain('web_ai_ask')
    expect(hintFor('web-ai', { provider: 'doubao' })).toContain('doubao')
  })

  it('generates a tool hint', () => {
    expect(hintFor('tool', { tool: 'read_file' })).toContain('read_file')
  })
})
