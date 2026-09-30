/**
 * Scope and visibility helpers: which scope a node lives in, which outputs are
 * referable from a node, and the container chain and inner variables that a
 * container exposes. Shared by validation and the browser variable picker.
 *
 * @module @dsh-plugins/flow/spec/scope
 */

import type { FlowDocument, FlowLookup, FlowNode, VarField, VarType } from './types.ts'
import { specOf } from './nodes/index.ts'
import { sourceSchema } from './source-schema.ts'

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
  const seen = new Set<string>()
  let current: string | undefined = nodeById(doc, nodeId)?.parentId
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    chain.unshift(current)
    current = nodeById(doc, current)?.parentId
  }
  return chain
}

/** Precomputed same-scope ancestry for one document; build once per validation or render. */
export interface ScopeIndex {
  /** Same-scope nodes with a directed path to `nodeId` (excluding `nodeId`). */
  ancestors(nodeId: string): ReadonlySet<string>
}

/**
 * Build a {@link ScopeIndex}. Only edges whose endpoints share a scope count;
 * `body` edges cross into a container and never make a node an ancestor.
 * @param doc - the flow document.
 * @returns the memoized index.
 */
export function buildScopeIndex(doc: FlowDocument): ScopeIndex {
  const scopeById = new Map(doc.nodes.map(node => [node.id, node.parentId ?? ROOT_SCOPE]))
  const reverse = new Map<string, string[]>()
  for (const edge of doc.edges) {
    const sourceScope = scopeById.get(edge.source)
    if (edge.sourceHandle === 'body' || sourceScope === undefined || sourceScope !== scopeById.get(edge.target)) continue
    const list = reverse.get(edge.target) ?? []
    list.push(edge.source)
    reverse.set(edge.target, list)
  }
  const memo = new Map<string, Set<string>>()
  return {
    ancestors(nodeId) {
      const cached = memo.get(nodeId)
      if (cached !== undefined) return cached
      const out = new Set<string>()
      const stack = [...(reverse.get(nodeId) ?? [])]
      while (stack.length > 0) {
        const current = stack.pop() as string
        if (out.has(current)) continue
        out.add(current)
        stack.push(...(reverse.get(current) ?? []))
      }
      out.delete(nodeId)
      memo.set(nodeId, out)
      return out
    },
  }
}

/** Whether `from` can reach `to` in the same scope through directed edges. */
export function canReach(doc: FlowDocument, from: string, to: string, index: ScopeIndex = buildScopeIndex(doc)): boolean {
  return from !== to && index.ancestors(to).has(from)
}

/** Options for {@link visibleOutputNodes}. */
export interface VisibilityOptions {
  /**
   * Whether a container node may see its own body nodes. Only a container's
   * `outputs[].value` collects body results; its array/count/initial values
   * are resolved outside the body and must not.
   */
  includeOwnBody?: boolean
  index?: ScopeIndex
}

/**
 * The node ids whose outputs are referable from `nodeId`: same-scope ancestors,
 * plus each outer container's ancestors in its parent scope.
 */
export function visibleOutputNodes(doc: FlowDocument, nodeId: string, options: VisibilityOptions = {}): Set<string> {
  const index = options.index ?? buildScopeIndex(doc)
  const out = new Set<string>(index.ancestors(nodeId))
  const self = nodeById(doc, nodeId)
  if ((options.includeOwnBody ?? true) && (self?.type === 'loop' || self?.type === 'batch')) {
    for (const node of nodesInScope(doc, nodeId)) out.add(node.id)
  }
  for (const containerId of containerChainOf(doc, nodeId)) {
    for (const ancestor of index.ancestors(containerId)) out.add(ancestor)
  }
  return out
}

/** Whether a node id's output is visible (referable) from `nodeId`. */
export function isVisibleOutput(doc: FlowDocument, sourceId: string, nodeId: string, options: VisibilityOptions = {}): boolean {
  return visibleOutputNodes(doc, nodeId, options).has(sourceId)
}

/** A group of variables offered to a picker. */
export interface VarGroup {
  label: string
  /** Node outputs in this group. */
  nodes: { nodeId: string; nodeTitle: string; nodeType: string; outputs: VarField[] }[]
  /** Container inner variables, present only for the innermost container group. */
  inner?: { containerId: string; fields: VarField[] }
}

/**
 * The variables a node can reference, grouped by source: same-scope ancestors,
 * outer container-chain ancestors, and the containing container's inner vars.
 */
export function availableVariables(doc: FlowDocument, nodeId: string, lookup: FlowLookup, index: ScopeIndex = buildScopeIndex(doc)): VarGroup[] {
  const groups: VarGroup[] = []
  const describe = (ids: ReadonlySet<string>): VarGroup['nodes'] => doc.nodes
    .filter(node => ids.has(node.id) && specOf(node).executable)
    .map(node => ({ nodeId: node.id, nodeTitle: node.title, nodeType: node.type, outputs: typedOutputs(doc, node, lookup) }))

  const same = describe(index.ancestors(nodeId))
  if (same.length > 0) groups.push({ label: 'same scope', nodes: same })

  const chain = containerChainOf(doc, nodeId)
  for (const containerId of chain) {
    const outer = describe(index.ancestors(containerId))
    if (outer.length > 0) groups.push({ label: `outer ${containerId}`, nodes: outer })
  }

  const innermost = chain[chain.length - 1]
  if (innermost !== undefined) {
    const container = nodeById(doc, innermost)
    if (container !== undefined) {
      const fields = innerVarsOf(container).map(field => field.name === 'item' ? { ...field, schema: sourceSchema(doc, { kind: 'ref', node: innermost, source: 'inner', path: ['item'] }, lookup) } : field)
      if (fields.length > 0) groups.push({ label: `inner ${innermost}`, nodes: [], inner: { containerId: innermost, fields } })
    }
  }
  return groups
}

/**
 * A node's outputs with container collected outputs typed as arrays of the
 * collected value's schema, so `results[0].field` can be picked downstream.
 * @param doc - the flow.
 * @param node - the node.
 * @param lookup - subflow lookup.
 * @returns the output fields.
 */
export function typedOutputs(doc: FlowDocument, node: FlowNode, lookup: FlowLookup): VarField[] {
  const fields = specOf(node).outputs(node, lookup)
  if (node.type !== 'loop' && node.type !== 'batch') return fields
  return fields.map((field) => {
    const collected = node.data.outputs.find(output => output.name === field.name)
    return collected === undefined ? field : { ...field, schema: { type: 'array', items: sourceSchema(doc, collected.value, lookup) } }
  })
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

/** Look up a node by id. */
export function nodeById(doc: FlowDocument, nodeId: string): FlowNode | undefined {
  return doc.nodes.find(node => node.id === nodeId)
}

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
