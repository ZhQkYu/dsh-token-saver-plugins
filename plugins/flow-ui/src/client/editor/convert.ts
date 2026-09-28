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

/**
 * Remove one node; when it sat in a chain (one edge in, one edge out), its
 * predecessor connects to its successor so the flow stays connected.
 * @param doc - the flow.
 * @param nodeId - the node to remove.
 * @param edgeId - the id for the reconnecting edge.
 * @returns the flow without the node.
 */
export function removeNodeAndReconnect(doc: FlowDocument, nodeId: string, edgeId: string): FlowDocument {
  const incoming = doc.edges.filter(edge => edge.target === nodeId)
  const outgoing = doc.edges.filter(edge => edge.source === nodeId && edge.sourceHandle !== 'body')
  const next = removeNodes(doc, [nodeId])
  const from = incoming[0]
  const to = outgoing[0]
  if (incoming.length !== 1 || outgoing.length !== 1 || from === undefined || to === undefined) return next
  return connect(next, { source: from.source, sourceHandle: from.sourceHandle, target: to.target }, edgeId)
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

/** Horizontal distance between a node and the node added after it. */
export const GAP_X = 300
const GAP_Y = 120
const NODE_WIDTH = 220

function widthOf(node: FlowNode): number {
  return node.size?.width ?? NODE_WIDTH
}

/**
 * Give a fresh node a usable starting configuration where the spec defaults
 * would leave it invalid: one condition branch, one intent, a code input and output.
 * @param node - a node from {@link createNode}.
 * @param t - the translator for default labels.
 * @returns the seeded node.
 */
export function seedNode(node: FlowNode, t: Translate): FlowNode {
  switch (node.type) {
    case 'condition':
      return { ...node, data: { branches: [{ id: newId('branch'), label: `${t('branch')} 1`, logic: 'and', conditions: [{ left: { kind: 'literal', value: '' }, op: 'eq', right: { kind: 'literal', value: '' } }] }] } }
    case 'intent':
      return { ...node, data: { ...node.data, intents: [{ id: newId('intent'), label: `${t('intent')} 1` }] } }
    case 'code':
      return { ...node, data: { ...node.data, inputs: [{ name: 'input', schema: { type: 'string' }, value: { kind: 'literal', value: '' } }], outputs: [{ name: 'result', schema: { type: 'any' } }] } }
    case 'loop':
      return { ...node, data: { ...node.data, maxIterations: 100 } }
    default:
      return node
  }
}

const NODE_HEIGHT = 80

function overlaps(doc: FlowDocument, node: FlowNode, position: { x: number; y: number }): boolean {
  const width = widthOf(node)
  const height = node.size?.height ?? NODE_HEIGHT
  return doc.nodes.some(other => other.id !== node.id && other.parentId === node.parentId
    && position.x < other.position.x + widthOf(other) + 20 && other.position.x < position.x + width + 20
    && position.y < other.position.y + (other.size?.height ?? NODE_HEIGHT) + 20 && other.position.y < position.y + height + 20)
}

function freePosition(doc: FlowDocument, node: FlowNode, position: { x: number; y: number }): { x: number; y: number } {
  let next = position
  while (overlaps(doc, node, next)) next = { x: next.x, y: next.y + GAP_Y }
  return next
}

/**
 * Add a node after an anchor node in the anchor's scope. When the anchor's
 * main port leads to exactly one node and the new node has an exit, the new
 * node is inserted in between (its first exit leads on) and the nodes to the
 * right move over; when the port is free, the anchor connects to the new node.
 * @param doc - the flow.
 * @param anchor - the node to add after.
 * @param node - the new node (its position and parent are replaced).
 * @param edgeId - id factory for new edges.
 * @returns the flow with the node and its edges.
 */
export function addNodeAfter(doc: FlowDocument, anchor: FlowNode, node: FlowNode, edgeId: () => string): FlowDocument {
  const parentId = anchor.parentId
  const { parentId: _ignored, ...rest } = node
  const placed = (parentId === undefined ? rest : { ...rest, parentId }) as FlowNode
  const ports = specOf(anchor).ports(anchor).filter(port => port.kind !== 'body')
  const port = ports.find(candidate => candidate.id === 'next') ?? ports[0]
  const target = { x: anchor.position.x + widthOf(anchor) + GAP_X - NODE_WIDTH, y: anchor.position.y }
  if (port === undefined) {
    return { ...doc, nodes: [...doc.nodes, { ...placed, position: freePosition(doc, placed, target) }] }
  }
  const outgoing = doc.edges.filter(edge => edge.source === anchor.id && edge.sourceHandle === port.id)
  const exits = specOf(placed).ports(placed).filter(candidate => candidate.kind !== 'body' && candidate.kind !== 'error')
  const exit = exits.find(candidate => candidate.id === 'next') ?? exits[0]
  if (outgoing.length === 1 && exit !== undefined && outgoing[0] !== undefined) {
    const downstream = outgoing[0]
    const shift = widthOf(placed) + GAP_X - NODE_WIDTH
    const shifted = doc.nodes.map(other => other.parentId === parentId && other.position.x > anchor.position.x
      ? { ...other, position: { x: other.position.x + shift, y: other.position.y } }
      : other)
    return {
      ...doc,
      nodes: [...shifted, { ...placed, position: target }],
      edges: [
        ...doc.edges.filter(edge => edge.id !== downstream.id),
        { id: edgeId(), source: anchor.id, sourceHandle: port.id, target: placed.id },
        { id: edgeId(), source: placed.id, sourceHandle: exit.id, target: downstream.target },
      ],
    }
  }
  const withNode = { ...doc, nodes: [...doc.nodes, { ...placed, position: freePosition(doc, placed, target) }] }
  if (outgoing.length > 0 || !specOf(placed).hasInput(placed)) return withNode
  return { ...withNode, edges: [...withNode.edges, { id: edgeId(), source: anchor.id, sourceHandle: port.id, target: placed.id }] }
}

/**
 * Add a node inside a loop/batch: after its right-most child, or as the first
 * body node connected from the `body` port. The container grows to fit.
 * @param doc - the flow.
 * @param container - the loop or batch node.
 * @param node - the new node (its position and parent are replaced).
 * @param edgeId - id factory for new edges.
 * @returns the flow with the node, its edges, and the resized container.
 */
export function addNodeInside(doc: FlowDocument, container: FlowNode, node: FlowNode, edgeId: () => string): FlowDocument {
  const children = doc.nodes.filter(child => child.parentId === container.id)
  const last = children.reduce<FlowNode | undefined>((best, child) => best === undefined || child.position.x > best.position.x ? child : best, undefined)
  let next: FlowDocument
  if (last === undefined) {
    const placed = { ...node, parentId: container.id, position: { x: 40, y: 70 } } as FlowNode
    next = { ...doc, nodes: [...doc.nodes, placed], edges: [...doc.edges, { id: edgeId(), source: container.id, sourceHandle: 'body', target: placed.id }] }
  } else {
    next = addNodeAfter(doc, last, node, edgeId)
  }
  const inside = next.nodes.filter(child => child.parentId === container.id)
  const width = Math.max(container.size?.width ?? CONTAINER_SIZE.width, ...inside.map(child => child.position.x + 260))
  const height = Math.max(container.size?.height ?? CONTAINER_SIZE.height, ...inside.map(child => child.position.y + 140))
  return { ...next, nodes: next.nodes.map(candidate => candidate.id === container.id ? { ...candidate, size: { width, height } } : candidate) }
}

/**
 * Add a node at a free position in a scope, without edges.
 * @param doc - the flow.
 * @param node - the new node, positioned where it should go.
 * @returns the flow with the node moved clear of existing nodes.
 */
export function addNodeAt(doc: FlowDocument, node: FlowNode): FlowDocument {
  return { ...doc, nodes: [...doc.nodes, { ...node, position: freePosition(doc, node, node.position) }] }
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
      x += columnWidth + GAP_X - NODE_WIDTH
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

/** A new id in the spec's id charset. */
export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}
