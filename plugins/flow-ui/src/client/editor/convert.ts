/**
 * Convert a FlowDocument to React Flow nodes/edges and back. The editor holds a
 * FlowDocument as its source of truth; React Flow views are derived on every
 * render so the canvas and the saved model never drift.
 *
 * @module @dsh-plugins/flow-ui/client/editor/convert
 */

import type { Node, Edge } from '@xyflow/react'
import type { FlowDocument, FlowEdge, FlowNode, PortSpec } from '@dsh-plugins/flow/spec'
import { specOf } from '@dsh-plugins/flow/spec'

/** The React Flow node type for a flow node. */
export type RfNode = Node<{ flowNode: FlowNode }>

/** Build React Flow nodes from a flow document (parents before children). */
export function toRfNodes(doc: FlowDocument): RfNode[] {
  const sorted = sortParentsFirst(doc.nodes)
  return sorted.map((flowNode) => ({
    id: flowNode.id,
    type: flowNode.type === 'comment' ? 'comment' : 'flow',
    position: { x: flowNode.position.x, y: flowNode.position.y },
    ...(flowNode.parentId === undefined ? {} : { parentId: flowNode.parentId, extent: 'parent' as const }),
    ...(flowNode.size === undefined ? {} : { style: { width: flowNode.size.width, height: flowNode.size.height } }),
    data: { flowNode },
  }))
}

/** Build React Flow edges from a flow document. */
export function toRfEdges(doc: FlowDocument): Edge[] {
  return doc.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    type: 'flow',
  }))
}

/** Collect the doc back from the current nodes/edges. */
export function fromRf(doc: FlowDocument, nodes: RfNode[], edges: Edge[]): FlowDocument {
  const flowNodes: FlowNode[] = []
  for (const node of nodes) {
    const flowNode = node.data.flowNode
    flowNodes.push({
      ...flowNode,
      position: { x: node.position.x, y: node.position.y },
      ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    })
  }
  const flowEdges: FlowEdge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? 'next',
  }))
  return { ...doc, nodes: flowNodes, edges: flowEdges }
}

/** Order nodes so containers come before their children. */
export function sortParentsFirst(nodes: FlowNode[]): FlowNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const result: FlowNode[] = []
  const visited = new Set<string>()
  const visit = (node: FlowNode): void => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    result.push(node)
    for (const child of nodes) {
      if (child.parentId === node.id) visit(child)
    }
  }
  for (const node of nodes) {
    if (node.parentId === undefined) visit(node)
  }
  void byId
  return result
}

/** The output ports a node exposes for edge handles. */
export function portsOf(node: FlowNode): PortSpec[] {
  return specOf(node).ports(node)
}

/** Create a fresh node with defaults for a type. */
export function createNode(type: FlowNode['type'], id: string, position: { x: number; y: number }): FlowNode {
  const spec = specOf({ type, id, title: type, data: {} as never } as never)
  const data = spec.defaults()
  return {
    id,
    type,
    title: type,
    description: '',
    position,
    ...(spec.container === true ? { size: { width: 360, height: 320 } } : {}),
    data,
  } as unknown as FlowNode
}

/** A stable new id generator. */
export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}
