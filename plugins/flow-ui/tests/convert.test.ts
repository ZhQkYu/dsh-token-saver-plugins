import { describe, expect, it } from 'vitest'
import type { FlowDocument, FlowNode } from '@dsh-plugins/flow/spec'
import { canConnect, connect, createNode, moveNode, removeNodes, sortParentsFirst, toRfEdges } from '../src/client/editor/convert.ts'

const t = (key: string): string => key
const node = (value: Record<string, unknown>): FlowNode => ({ position: { x: 0, y: 0 }, title: String(value['id']), ...value }) as never

function flow(): FlowDocument {
  return {
    schemaVersion: 1, id: 'f', name: 'f', description: '', revision: 1, updatedAt: 0,
    nodes: [
      node({ id: 'start', type: 'start', data: { fields: [] } }),
      node({ id: 'cond', type: 'condition', data: { branches: [{ id: 'yes', label: 'Yes', logic: 'and', conditions: [] }] } }),
      node({ id: 'a', type: 'message', data: { inputs: [], template: 'a' } }),
      node({ id: 'loop', type: 'loop', data: { mode: 'count', maxIterations: 3, variables: [], outputs: [] } }),
      node({ id: 'inner', type: 'message', parentId: 'loop', data: { inputs: [], template: 'i' } }),
      node({ id: 'end', type: 'end', data: { mode: 'variables', inputs: [] } }),
    ],
    edges: [
      { id: 'e1', source: 'start', sourceHandle: 'next', target: 'cond' },
      { id: 'e2', source: 'cond', sourceHandle: 'yes', target: 'a' },
    ],
  }
}

describe('editor document operations', () => {
  it('connects only valid ports and scopes, and never closes a cycle', () => {
    const doc = flow()
    expect(canConnect(doc, { source: 'a', sourceHandle: 'next', target: 'end' })).toBe(true)
    expect(canConnect(doc, { source: 'cond', sourceHandle: 'nope', target: 'end' })).toBe(false)
    expect(canConnect(doc, { source: 'a', sourceHandle: 'next', target: 'start' })).toBe(false)
    expect(canConnect(doc, { source: 'a', sourceHandle: 'next', target: 'cond' })).toBe(false)
    expect(canConnect(doc, { source: 'a', sourceHandle: 'next', target: 'inner' })).toBe(false)
    expect(canConnect(doc, { source: 'loop', sourceHandle: 'body', target: 'inner' })).toBe(true)
    expect(canConnect(doc, { source: 'loop', sourceHandle: 'body', target: 'a' })).toBe(false)
    expect(canConnect(doc, { source: 'start', sourceHandle: 'next', target: 'cond' })).toBe(false)
  })

  it('writes a new connection into the document', () => {
    const next = connect(flow(), { source: 'a', sourceHandle: 'next', target: 'end' }, 'e3')
    expect(next.edges.at(-1)).toEqual({ id: 'e3', source: 'a', sourceHandle: 'next', target: 'end' })
  })

  it('removes a container with its children and every touching edge', () => {
    const doc = connect(flow(), { source: 'loop', sourceHandle: 'body', target: 'inner' }, 'body')
    const next = removeNodes(doc, ['loop'])
    expect(next.nodes.map(n => n.id)).not.toContain('inner')
    expect(next.edges.map(e => e.id)).not.toContain('body')
  })

  it('moves a node and keeps parents before children', () => {
    const moved = moveNode(flow(), 'a', { x: 10.6, y: 20.2 })
    expect(moved.nodes.find(n => n.id === 'a')?.position).toEqual({ x: 11, y: 20 })
    const order = sortParentsFirst([...flow().nodes].reverse()).map(n => n.id)
    expect(order.indexOf('loop')).toBeLessThan(order.indexOf('inner'))
  })

  it('labels branch edges by their port label', () => {
    const edges = toRfEdges(flow(), undefined, t as never)
    expect(edges.find(edge => edge.id === 'e2')?.label).toBe('Yes')
    expect(edges.find(edge => edge.id === 'e1')?.label).toBeUndefined()
  })

  it('marks taken and idle edges from the last run', () => {
    const edges = toRfEdges(flow(), new Map([['start', ['next']], ['cond', ['else']]]), t as never)
    expect(edges.find(edge => edge.id === 'e1')?.className).toBe('dsflow-edge--taken')
    expect(edges.find(edge => edge.id === 'e2')?.className).toBe('dsflow-edge--idle')
  })

  it('creates nodes with spec defaults inside a container', () => {
    const child = createNode('llm', 'llm-1', { x: 1, y: 2 }, 'LLM', 'loop')
    expect(child.parentId).toBe('loop')
    expect(child.type === 'llm' && child.data.output).toEqual({ format: 'text' })
    expect(createNode('batch', 'b', { x: 0, y: 0 }, 'B').size).toBeDefined()
  })
})
