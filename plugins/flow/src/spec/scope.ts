/**
 * Scope and visibility helpers: which scope a node lives in, which outputs are
 * referable from a node, and the container chain and inner variables that a
 * container exposes. Shared by validation and the browser variable picker.
 *
 * @module @dsh-plugins/flow/spec/scope
 */

import type { FlowDocument, FlowLookup, FlowNode, VarField, VarType } from './types.ts'

/** The root scope marker. */
export const ROOT_SCOPE = 'root'

/** The container (loop/batch) scope a node belongs to, or `root`. */
export function scopeOf(doc: FlowDocument, nodeId: string): string {
  const node = nodeById(doc, nodeId)
  return node?.parentId ?? ROOT_SCOPE
}

/** All nodes that live directly in a scope (not nested in a deeper container). */
export function nodesInScope(doc: FlowDocument, scope: string): FlowNode[] {
  return doc.nodes.filter(node => (node.parentId ?? ROOT_SCOPE) === scope)
}

/** The container chain containing a node, outermost first. */
export function containerChainOf(doc: FlowDocument, nodeId: string): string[] {
  const chain: string[] = []
  let current: string | undefined = nodeById(doc, nodeId)?.parentId
  while (current !== undefined) {
    chain.unshift(current)
    current = nodeById(doc, current)?.parentId
  }
  return chain
}

/**
 * Whether `from` can reach `to` in the same scope through directed edges.
 * Used to decide whether `from`'s output has finished before `to` runs.
 */
export function canReach(doc: FlowDocument, from: string, to: string): boolean {
  if (from === to) return false
  const scope = scopeOf(doc, from)
  const adjacency = buildAdjacency(doc, scope)
  const visited = new Set<string>()
  const stack = [...(adjacency.get(from) ?? [])]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (current === to) return true
    if (visited.has(current)) continue
    visited.add(current)
    const next = adjacency.get(current)
    if (next !== undefined) stack.push(...next)
  }
  return false
}

/**
 * The node ids whose outputs are referable from `nodeId`: same-scope ancestors,
 * plus each outer container's ancestors in its parent scope.
 */
export function visibleOutputNodes(doc: FlowDocument, nodeId: string): Set<string> {
  const out = new Set<string>()
  const ownScope = scopeOf(doc, nodeId)
  // Same-scope ancestors.
  for (const node of nodesInScope(doc, ownScope)) {
    if (node.id !== nodeId && canReach(doc, node.id, nodeId)) out.add(node.id)
  }
  // A container node can reference the outputs of its own body scope (its
  // `outputs[].value` collect body-node results).
  const self = nodeById(doc, nodeId)
  if (self?.type === 'loop' || self?.type === 'batch') {
    for (const node of nodesInScope(doc, nodeId)) out.add(node.id)
  }
  // Outer containers' ancestors.
  for (const containerId of containerChainOf(doc, nodeId)) {
    const parentScope = scopeOf(doc, containerId)
    for (const node of nodesInScope(doc, parentScope)) {
      if (node.id !== containerId && canReach(doc, node.id, containerId)) out.add(node.id)
    }
  }
  return out
}

/** Whether a node id's output is visible (referable) from `nodeId`. */
export function isVisibleOutput(doc: FlowDocument, sourceId: string, nodeId: string): boolean {
  return visibleOutputNodes(doc, nodeId).has(sourceId)
}

/** A group of variables offered to a picker. */
export interface VarGroup {
  label: string
  /** Node outputs in this group. */
  nodes: { nodeId: string; nodeTitle: string; nodeType: string; outputs: VarField[] }[]
  /** Container inner variables, present only for the innermost container group. */
  inner?: VarField[]
}

/**
 * The variables a node can reference, grouped by source: same-scope ancestors,
 * outer container-chain ancestors, and the containing container's inner vars.
 */
export function availableVariables(doc: FlowDocument, nodeId: string, _lookup: FlowLookup): VarGroup[] {
  const groups: VarGroup[] = []
  const ownScope = scopeOf(doc, nodeId)

  const sameScopeGroup: VarGroup = { label: 'same scope', nodes: [] }
  for (const node of nodesInScope(doc, ownScope)) {
    if (node.id !== nodeId && canReach(doc, node.id, nodeId)) {
      sameScopeGroup.nodes.push({ nodeId: node.id, nodeTitle: node.title, nodeType: node.type, outputs: outputsOf(node) })
    }
  }
  if (sameScopeGroup.nodes.length > 0) groups.push(sameScopeGroup)

  const chain = containerChainOf(doc, nodeId)
  for (const containerId of chain) {
    const parentScope = scopeOf(doc, containerId)
    const group: VarGroup = { label: `outer ${containerId}`, nodes: [] }
    for (const node of nodesInScope(doc, parentScope)) {
      if (node.id !== containerId && canReach(doc, node.id, containerId)) {
        group.nodes.push({ nodeId: node.id, nodeTitle: node.title, nodeType: node.type, outputs: outputsOf(node) })
      }
    }
    if (group.nodes.length > 0) groups.push(group)
  }

  // Innermost container inner variables.
  const innermost = chain[chain.length - 1]
  if (innermost !== undefined) {
    const container = nodeById(doc, innermost)
    if (container !== undefined && (container.type === 'loop' || container.type === 'batch')) {
      const inner = innerVarsOf(container)
      if (inner.length > 0) groups.push({ label: `inner ${innermost}`, nodes: [], inner })
    }
  }
  return groups
}

function innerVarsOf(container: FlowNode): VarField[] {
  if (container.type === 'loop') {
    const vars = container.data.variables.map(v => ({ name: v.name, schema: v.schema }))
    return [{ name: 'item', schema: { type: 'any' } }, { name: 'index', schema: { type: 'integer' } }, ...vars]
  }
  if (container.type === 'batch') {
    return [{ name: 'item', schema: { type: 'any' } }, { name: 'index', schema: { type: 'integer' } }]
  }
  return []
}

function outputsOf(node: FlowNode): VarField[] {
  // Lightweight: return node data outputs where statically derivable.
  switch (node.type) {
    case 'start': return node.data.fields.map(f => ({ name: f.name, schema: f.schema, ...(f.required === undefined ? {} : { required: f.required }) }))
    case 'llm': return node.data.output.format === 'json' ? node.data.output.fields : [{ name: 'text', schema: { type: 'string' } }]
    case 'code': return node.data.outputs
    case 'end': return []
    case 'comment': return []
    default: return []
  }
}

function buildAdjacency(doc: FlowDocument, scope: string): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()
  const scopeNodes = new Set(nodesInScope(doc, scope).map(n => n.id))
  for (const edge of doc.edges) {
    if (!scopeNodes.has(edge.source) || !scopeNodes.has(edge.target)) continue
    const list = adjacency.get(edge.source) ?? []
    list.push(edge.target)
    adjacency.set(edge.source, list)
  }
  return adjacency
}

/** Look up a node by id. */
export function nodeById(doc: FlowDocument, nodeId: string): FlowNode | undefined {
  return doc.nodes.find(node => node.id === nodeId)
}

/** The inner variable types a container exposes. */
export type InnerVarKind = 'item' | 'index' | string

/** Resolve the inner variable schema of a container. */
export function innerVarSchema(container: FlowNode, name: string): VarType | undefined {
  if (container.type === 'batch') {
    if (name === 'item') return 'any'
    if (name === 'index') return 'integer'
    return undefined
  }
  if (container.type === 'loop') {
    if (name === 'item') return 'any'
    if (name === 'index') return 'integer'
    const variable = container.data.variables.find(v => v.name === name)
    return variable?.schema.type
  }
  return undefined
}
