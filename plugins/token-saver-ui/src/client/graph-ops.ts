/** Pure graph helpers for the canvas editor: cycle checks, branch-edge upkeep, and the automatic layout. */

import { ELSE_BRANCH, type CanvasGraph } from '@dsh-plugins/token-saver/protocol'

type Edges = readonly { source: string; target: string }[]

/**
 * Keep edge branch handles consistent with their source nodes: plain sources
 * lose any handle, condition sources move unassigned edges to the else exit
 * and drop edges of removed branches, and duplicates collapse.
 * @param graph - the graph after an edit.
 * @returns the same graph when nothing changes, otherwise a corrected copy.
 */
export function reconcileBranchEdges(graph: CanvasGraph): CanvasGraph {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const seen = new Set<string>()
  let changed = false
  const edges: CanvasGraph['edges'] = []
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source)
    let next = edge
    if (source?.kind === 'condition') {
      const handles = new Set([...(source.config.branches ?? []).map(branch => branch.id), ELSE_BRANCH])
      if (edge.sourceHandle === undefined) next = { ...edge, sourceHandle: ELSE_BRANCH }
      else if (!handles.has(edge.sourceHandle)) {
        changed = true
        continue
      }
    } else if (edge.sourceHandle !== undefined) {
      const { sourceHandle: _dropped, ...plain } = edge
      next = plain
    }
    const key = `${next.source}\u0000${next.sourceHandle ?? ''}\u0000${next.target}`
    if (seen.has(key)) {
      changed = true
      continue
    }
    seen.add(key)
    if (next !== edge) changed = true
    edges.push(next)
  }
  return changed ? { ...graph, edges } : graph
}

/**
 * Whether `target` can already reach `source`, so a new source→target edge would close a cycle.
 * @param edges - the current edges.
 * @param source - the new edge's source node.
 * @param target - the new edge's target node.
 * @returns true when the edge would create a cycle (including a self loop).
 */
export function wouldCreateCycle(edges: Edges, source: string, target: string): boolean {
  if (source === target) return true
  const next = new Map<string, string[]>()
  for (const edge of edges) next.set(edge.source, [...next.get(edge.source) ?? [], edge.target])
  const stack = [target]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === source) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...next.get(id) ?? [])
  }
  return false
}

/**
 * Whether the graph contains any cycle.
 * @param graph - nodes and edges to check.
 * @returns true when the graph is not a DAG.
 */
export function hasCycle(graph: Pick<CanvasGraph, 'nodes' | 'edges'>): boolean {
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]))
  for (const edge of graph.edges) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id)
  let visited = 0
  while (ready.length > 0) {
    const id = ready.pop()!
    visited++
    for (const edge of graph.edges) {
      if (edge.source !== id) continue
      const degree = (indegree.get(edge.target) ?? 0) - 1
      indegree.set(edge.target, degree)
      if (degree === 0) ready.push(edge.target)
    }
  }
  return visited !== graph.nodes.length
}

/** Horizontal and vertical spacing of the automatic layout, in flow units. */
export const LAYOUT_GAP = { x: 280, y: 130 } as const

/**
 * Lay a DAG out left to right: each node's column is its longest path from a
 * source, and rows keep the nodes' current vertical order within a column.
 * @param graph - the graph to arrange; must be acyclic.
 * @returns the new position of every node.
 */
export function autoLayout(graph: Pick<CanvasGraph, 'nodes' | 'edges'>): Map<string, { x: number; y: number }> {
  const column = new Map(graph.nodes.map(node => [node.id, 0]))
  // Longest-path layering converges in at most |nodes| relaxation passes on a DAG.
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let changed = false
    for (const edge of graph.edges) {
      const depth = (column.get(edge.source) ?? 0) + 1
      if (depth > (column.get(edge.target) ?? 0)) {
        column.set(edge.target, depth)
        changed = true
      }
    }
    if (!changed) break
  }
  const columns = new Map<number, typeof graph.nodes>()
  for (const node of graph.nodes) {
    const index = column.get(node.id) ?? 0
    columns.set(index, [...columns.get(index) ?? [], node])
  }
  const positions = new Map<string, { x: number; y: number }>()
  for (const [index, members] of columns) {
    const ordered = [...members].sort((left, right) => left.position.y - right.position.y || left.position.x - right.position.x)
    ordered.forEach((node, row) => {
      positions.set(node.id, { x: 40 + index * LAYOUT_GAP.x, y: 40 + row * LAYOUT_GAP.y })
    })
  }
  return positions
}
