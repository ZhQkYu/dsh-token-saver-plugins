/**
 * Compile a canvas graph into an ordered step list. Pure functions only — this
 * is the most-tested part of the canvas. Steps are topologically ordered, with
 * same-level nodes sorted by `position.y` then `x`. Cycles are rejected.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas/compile
 */

import type { CanvasGraph, CanvasNode, CompiledStep, NodeKind } from '../protocol.ts'
import { MAX_EDGES, MAX_NODES } from './schema.ts'

/** One error carrying a stable `code` for the canvas. */
export class CanvasError extends Error {
  constructor(readonly code: 'CYCLE' | 'BAD_EDGE' | 'BAD_ID' | 'TOO_MANY', message: string) {
    super(message)
    this.name = 'CanvasError'
  }
}

/** Generate a model-facing hint for a step based on its node kind. */
export function hintFor(kind: NodeKind, config: CanvasNode['config']): string {
  switch (kind) {
    case 'web-ai':
      return `Delegate with web_ai_ask (provider=${config.provider ?? 'default'})`
    case 'subagent':
      return 'Delegate with the subagent tool'
    case 'tool':
      return `Use the ${config.tool ?? 'required'} tool`
    case 'review':
      return 'Review the outputs of the dependencies and decide whether to continue'
    case 'input':
      return 'Read the required inputs and state what is being worked on'
    case 'output':
      return 'Produce the final deliverable and report the result'
    default:
      return 'Execute the node instruction'
  }
}

/**
 * Compile a graph into an ordered step list, rejecting cycles and bad edges.
 * @param graph - the graph to compile.
 * @param maxNodes - the node-count limit.
 * @param maxEdges - the edge-count limit.
 * @returns the ordered steps.
 */
export function compileGraph(graph: CanvasGraph, maxNodes = MAX_NODES, maxEdges = MAX_EDGES): { steps: CompiledStep[] } {
  if (graph.nodes.length > maxNodes) {
    throw new CanvasError('TOO_MANY', `graph has ${graph.nodes.length} nodes; limit is ${maxNodes}`)
  }
  if (graph.edges.length > maxEdges) {
    throw new CanvasError('TOO_MANY', `graph has ${graph.edges.length} edges; limit is ${maxEdges}`)
  }
  const nodeById = new Map<string, { node: CanvasGraph['nodes'][number]; dependsOn: string[] }>()
  const seenNodes = new Set<string>()
  for (const node of graph.nodes) {
    if (nodeById.has(node.id)) throw new CanvasError('BAD_ID', `duplicate node id ${JSON.stringify(node.id)}`)
    nodeById.set(node.id, { node, dependsOn: [] })
    seenNodes.add(node.id)
  }
  const inDegree = new Map<string, number>()
  for (const id of seenNodes) inDegree.set(id, 0)
  const adjacency = new Map<string, string[]>()
  for (const id of seenNodes) adjacency.set(id, [])
  for (const edge of graph.edges) {
    const source = edge.source
    const target = edge.target
    if (!nodeById.has(source)) throw new CanvasError('BAD_EDGE', `edge source ${JSON.stringify(source)} does not exist`)
    if (!nodeById.has(target)) throw new CanvasError('BAD_EDGE', `edge target ${JSON.stringify(target)} does not exist`)
    const entry = nodeById.get(target)!
    entry.dependsOn.push(source)
    adjacency.get(source)!.push(target)
    inDegree.set(target, (inDegree.get(target) ?? 0) + 1)
  }

  // Kahn's algorithm with a stable tie-break by position (y, then x).
  const ready: string[] = []
  for (const [id, degree] of inDegree) {
    if (degree === 0) ready.push(id)
  }
  ready.sort(compareNodes(nodeById))

  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(id)
    const nextNodes = adjacency.get(id) ?? []
    for (const next of nextNodes) {
      const degree = (inDegree.get(next) ?? 1) - 1
      inDegree.set(next, degree)
      if (degree === 0) ready.push(next)
    }
    ready.sort(compareNodes(nodeById))
  }
  if (order.length !== seenNodes.size) {
    throw new CanvasError('CYCLE', 'graph contains a cycle; a workflow must be a DAG')
  }

  const steps: CompiledStep[] = order.map(id => {
    const entry = nodeById.get(id)!
    return {
      nodeId: id,
      kind: entry.node.kind,
      title: entry.node.title,
      instruction: entry.node.instruction,
      dependsOn: [...entry.dependsOn],
      hint: hintFor(entry.node.kind, entry.node.config),
    }
  })
  return { steps }
}

/** Sort nodes by `position.y` then `position.x` for a stable level order. */
function compareNodes(nodeById: Map<string, { node: CanvasGraph['nodes'][number]; dependsOn: string[] }>): (a: string, b: string) => number {
  return (a, b) => {
    const na = nodeById.get(a)!.node.position
    const nb = nodeById.get(b)!.node.position
    return na.y - nb.y || na.x - nb.x
  }
}
