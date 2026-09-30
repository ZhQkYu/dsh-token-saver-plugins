/**
 * Automatic left-to-right layout of a flow document. Shared by the editor's
 * "arrange" button and the model-facing design tool, so a flow written without
 * coordinates renders the same way it would after arranging it in the editor.
 *
 * @module @dsh-plugins/flow/spec/layout
 */

import type { FlowDocument, FlowNode } from './types.ts'
import { NODE_SPECS, specOf } from './nodes/index.ts'

/** Horizontal distance between a node and the node added after it. */
export const LAYOUT_GAP_X = 300
/** Default width of a non-container node. */
export const LAYOUT_NODE_WIDTH = 220

function widthOf(node: FlowNode): number {
  return node.size?.width ?? LAYOUT_NODE_WIDTH
}

function estimatedHeight(node: FlowNode): number {
  const ports = specOf(node).ports(node).filter(port => port.kind !== 'body').length
  return 64 + 18 * Math.max(0, ports - 1)
}

/**
 * Arrange every scope left to right by execution order: each node goes one
 * column after its furthest predecessor, and containers grow to fit their
 * bodies. Comments keep their positions.
 * @param doc - the flow.
 * @returns the flow with new positions and container sizes.
 */
export function autoLayout(doc: FlowDocument): FlowDocument {
  const positions = new Map<string, { x: number; y: number }>()
  const sizes = new Map<string, { width: number; height: number }>()
  const depthOf = (node: FlowNode): number => {
    let depth = 0
    let parent = doc.nodes.find(candidate => candidate.id === node.parentId)
    while (parent !== undefined) {
      depth++
      const parentId = parent.parentId
      parent = doc.nodes.find(candidate => candidate.id === parentId)
    }
    return depth
  }
  const containers = doc.nodes.filter(node => NODE_SPECS[node.type].container).sort((a, b) => depthOf(b) - depthOf(a))
  const layoutScope = (parentId: string | undefined, origin: { x: number; y: number }): { width: number; height: number } => {
    const nodes = doc.nodes.filter(node => node.parentId === parentId && node.type !== 'comment')
    const ids = new Set(nodes.map(node => node.id))
    const edges = doc.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target) && edge.sourceHandle !== 'body')
    const column = new Map<string, number>(nodes.map(node => [node.id, 0]))
    for (let pass = 0; pass < nodes.length; pass++) {
      let changed = false
      for (const edge of edges) {
        const next = (column.get(edge.source) ?? 0) + 1
        if (next > (column.get(edge.target) ?? 0)) { column.set(edge.target, next); changed = true }
      }
      if (!changed) break
    }
    const columns: FlowNode[][] = []
    for (const node of nodes) (columns[column.get(node.id) ?? 0] ??= []).push(node)
    let x = origin.x
    let width = 0
    let height = 0
    for (const members of columns) {
      if (members === undefined) continue
      members.sort((a, b) => a.position.y - b.position.y)
      let y = origin.y
      let columnWidth = 0
      for (const node of members) {
        const size = sizes.get(node.id) ?? { width: widthOf(node), height: node.size?.height ?? estimatedHeight(node) }
        positions.set(node.id, { x, y })
        y += size.height + 40
        columnWidth = Math.max(columnWidth, size.width)
      }
      width = x + columnWidth - origin.x
      height = Math.max(height, y - 40 - origin.y)
      x += columnWidth + LAYOUT_GAP_X - LAYOUT_NODE_WIDTH
    }
    return { width, height }
  }
  for (const container of containers) {
    const body = layoutScope(container.id, { x: 40, y: 70 })
    sizes.set(container.id, { width: Math.max(300, body.width + 80), height: Math.max(180, body.height + 100) })
  }
  const roots = doc.nodes.filter(node => node.parentId === undefined && node.type !== 'comment')
  const start = roots.find(node => node.type === 'start') ?? roots[0]
  layoutScope(undefined, start === undefined ? { x: 0, y: 0 } : { ...start.position })
  return {
    ...doc,
    nodes: doc.nodes.map((node) => {
      const position = positions.get(node.id)
      const size = sizes.get(node.id)
      return position === undefined && size === undefined ? node : { ...node, ...(position === undefined ? {} : { position }), ...(size === undefined ? {} : { size }) }
    }),
  }
}
