/**
 * Document-side graph operations for the editor. The {@link FlowDocument} is
 * the only source of truth: React Flow nodes and edges are derived from it,
 * and every canvas change (move, resize, connect, delete) is written back
 * through these pure helpers.
 *
 * @module @dsh-plugins/flow-ui/client/editor/convert
 */

import type { Edge, Node } from '@xyflow/react'
import type { FlowDocument, FlowEdge, FlowNode, Issue, PortSpec, RunViewNode } from '@dsh-plugins/flow/spec'
import { NODE_SPECS, specOf } from '@dsh-plugins/flow/spec'
import type { LocaleKey, Translate } from '../locales.ts'

/** Per-node overlay data the canvas renders on top of the document. */
export interface NodeOverlay {
  status?: RunViewNode['status'] | 'waiting'
  durationMs?: number
  tokens?: number
  issues: Issue[]
}

/** The data a React Flow node carries. */
export interface RfNodeData extends Record<string, unknown> {
  flowNode: FlowNode
  overlay: NodeOverlay
}

/** A React Flow node for a flow node. */
export type RfNode = Node<RfNodeData>

/** Default size of a new loop/batch container. */
export const CONTAINER_SIZE = { width: 420, height: 280 } as const

/** Build React Flow nodes from a flow document (parents before children). */
export function toRfNodes(doc: FlowDocument, overlays: ReadonlyMap<string, NodeOverlay>, selectedId: string | undefined): RfNode[] {
  return sortParentsFirst(doc.nodes).map((flowNode) => ({
    id: flowNode.id,
    type: flowNode.type === 'comment' ? 'comment' : NODE_SPECS[flowNode.type].container ? 'container' : 'flow',
    position: { x: flowNode.position.x, y: flowNode.position.y },
    selected: flowNode.id === selectedId,
    ...(flowNode.parentId === undefined ? {} : { parentId: flowNode.parentId, extent: 'parent' as const }),
    ...(flowNode.size === undefined ? {} : { style: { width: flowNode.size.width, height: flowNode.size.height } }),
    data: { flowNode, overlay: overlays.get(flowNode.id) ?? { issues: [] } },
  }))
}

/** Build React Flow edges from a flow document; `fired` marks edges the last run took. */
export function toRfEdges(doc: FlowDocument, fired: ReadonlyMap<string, readonly string[]> | undefined, t: Translate): Edge[] {
  return doc.edges.map((edge) => {
    const source = doc.nodes.find(node => node.id === edge.source)
    const ports = source === undefined ? [] : specOf(source).ports(source)
    const port = ports.find(candidate => candidate.id === edge.sourceHandle)
    const firedPorts = fired?.get(edge.source)
    const state = firedPorts === undefined ? undefined : firedPorts.includes(edge.sourceHandle) ? 'taken' : 'idle'
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: 'in',
      ...(ports.length > 1 && port !== undefined && port.kind !== 'body' ? { label: portLabel(t, port) } : {}),
      ...(state === undefined ? {} : { className: `dsflow-edge--${state}`, animated: state === 'taken' }),
    }
  })
}

/** A port label: the declared branch label for branch ports, the localized name otherwise. */
export function portLabel(t: Translate, port: PortSpec): string {
  if (port.kind === 'branch') return port.label
  const key = `port.${port.id}` as LocaleKey
  const localized = t(key)
  return localized === key ? port.label : localized
}

/** Order nodes so containers come before their children (React Flow requires it). */
export function sortParentsFirst(nodes: readonly FlowNode[]): FlowNode[] {
  const result: FlowNode[] = []
  const visited = new Set<string>()
  const visit = (node: FlowNode): void => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    result.push(node)
    for (const child of nodes) if (child.parentId === node.id) visit(child)
  }
  for (const node of nodes) if (node.parentId === undefined || !nodes.some(candidate => candidate.id === node.parentId)) visit(node)
  return result
}

/** Move a node. */
export function moveNode(doc: FlowDocument, nodeId: string, position: { x: number; y: number }): FlowDocument {
  return { ...doc, nodes: doc.nodes.map(node => node.id === nodeId ? { ...node, position: { x: Math.round(position.x), y: Math.round(position.y) } } : node) }
}

/** Resize a container or comment node. */
export function resizeNode(doc: FlowDocument, nodeId: string, size: { width: number; height: number }): FlowDocument {
  return { ...doc, nodes: doc.nodes.map(node => node.id === nodeId ? { ...node, size: { width: Math.round(size.width), height: Math.round(size.height) } } : node) }
}

/** Remove nodes (and every container descendant) plus every edge touching them. */
export function removeNodes(doc: FlowDocument, nodeIds: readonly string[]): FlowDocument {
  const removed = new Set(nodeIds)
  let grew = true
  while (grew) {
    grew = false
    for (const node of doc.nodes) {
      if (node.parentId !== undefined && removed.has(node.parentId) && !removed.has(node.id)) {
        removed.add(node.id)
        grew = true
      }
    }
  }
  return {
    ...doc,
    nodes: doc.nodes.filter(node => !removed.has(node.id)),
    edges: doc.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)),
  }
}

/** Remove edges by id. */
export function removeEdges(doc: FlowDocument, edgeIds: readonly string[]): FlowDocument {
  const removed = new Set(edgeIds)
  return { ...doc, edges: doc.edges.filter(edge => !removed.has(edge.id)) }
}

/** Replace one node. */
export function replaceNode(doc: FlowDocument, next: FlowNode): FlowDocument {
  return { ...doc, nodes: doc.nodes.map(node => node.id === next.id ? next : node) }
}

/** A proposed connection. */
export interface ConnectionProposal {
  source: string | null
  sourceHandle: string | null | undefined
  target: string | null
}

/**
 * Whether a connection is valid: both ends exist, the port exists, the target
 * accepts input, both ends share a scope (a `body` edge enters its own
 * container), and the edge is neither a duplicate nor closes a cycle.
 */
export function canConnect(doc: FlowDocument, connection: ConnectionProposal): boolean {
  const { source, target, sourceHandle } = connection
  if (source === null || target === null || sourceHandle === null || sourceHandle === undefined || source === target) return false
  const from = doc.nodes.find(node => node.id === source)
  const to = doc.nodes.find(node => node.id === target)
  if (from === undefined || to === undefined) return false
  if (!specOf(from).ports(from).some(port => port.id === sourceHandle)) return false
  if (!specOf(to).hasInput(to)) return false
  if (sourceHandle === 'body') {
    if (to.parentId !== from.id) return false
  } else if ((from.parentId ?? 'root') !== (to.parentId ?? 'root')) {
    return false
  }
  if (doc.edges.some(edge => edge.source === source && edge.sourceHandle === sourceHandle && edge.target === target)) return false
  if (sourceHandle === 'body') return true
  // Adding source -> target closes a cycle when target already reaches source.
  const stack = [target]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (current === source) return false
    if (seen.has(current)) continue
    seen.add(current)
    for (const edge of doc.edges) if (edge.source === current && edge.sourceHandle !== 'body') stack.push(edge.target)
  }
  return true
}

/** Add an edge when {@link canConnect} allows it. */
export function connect(doc: FlowDocument, connection: ConnectionProposal, id: string): FlowDocument {
  if (!canConnect(doc, connection)) return doc
  const edge: FlowEdge = { id, source: connection.source as string, sourceHandle: connection.sourceHandle as string, target: connection.target as string }
  return { ...doc, edges: [...doc.edges, edge] }
}

/**
 * Create a fresh node with defaults for a type.
 * @param type - the node type.
 * @param id - the new node id.
 * @param position - position (relative to the container when `parentId` is set).
 * @param title - the display title.
 * @param parentId - the containing loop/batch, if any.
 * @returns the node.
 */
export function createNode(type: FlowNode['type'], id: string, position: { x: number; y: number }, title: string, parentId?: string): FlowNode {
  const base = { id, title, description: '', position, ...(parentId === undefined ? {} : { parentId }) }
  const withSize = NODE_SPECS[type].container ? { ...base, size: { ...CONTAINER_SIZE } } : type === 'comment' ? { ...base, size: { width: 220, height: 100 } } : base
  switch (type) {
    case 'start': return { ...withSize, type: 'start', data: NODE_SPECS.start.defaults() }
    case 'end': return { ...withSize, type: 'end', data: NODE_SPECS.end.defaults() }
    case 'llm': return { ...withSize, type: 'llm', data: NODE_SPECS.llm.defaults() }
    case 'intent': return { ...withSize, type: 'intent', data: NODE_SPECS.intent.defaults() }
    case 'agent': return { ...withSize, type: 'agent', data: NODE_SPECS.agent.defaults() }
    case 'condition': return { ...withSize, type: 'condition', data: NODE_SPECS.condition.defaults() }
    case 'code': return { ...withSize, type: 'code', data: NODE_SPECS.code.defaults() }
    case 'http': return { ...withSize, type: 'http', data: NODE_SPECS.http.defaults() }
    case 'tool': return { ...withSize, type: 'tool', data: NODE_SPECS.tool.defaults() }
    case 'text': return { ...withSize, type: 'text', data: NODE_SPECS.text.defaults() }
    case 'json': return { ...withSize, type: 'json', data: NODE_SPECS.json.defaults() }
    case 'aggregate': return { ...withSize, type: 'aggregate', data: NODE_SPECS.aggregate.defaults() }
    case 'loop': return { ...withSize, type: 'loop', data: NODE_SPECS.loop.defaults() }
    case 'batch': return { ...withSize, type: 'batch', data: NODE_SPECS.batch.defaults() }
    case 'break': return { ...withSize, type: 'break', data: NODE_SPECS.break.defaults() }
    case 'continue': return { ...withSize, type: 'continue', data: NODE_SPECS.continue.defaults() }
    case 'assign': return { ...withSize, type: 'assign', data: NODE_SPECS.assign.defaults() }
    case 'subflow': return { ...withSize, type: 'subflow', data: NODE_SPECS.subflow.defaults() }
    case 'question': return { ...withSize, type: 'question', data: NODE_SPECS.question.defaults() }
    case 'message': return { ...withSize, type: 'message', data: NODE_SPECS.message.defaults() }
    case 'comment': return { ...withSize, type: 'comment', data: NODE_SPECS.comment.defaults() }
    default: return assertNever(type)
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable node type ${String(value)}`)
}

/** A new id in the spec's id charset. */
export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}
