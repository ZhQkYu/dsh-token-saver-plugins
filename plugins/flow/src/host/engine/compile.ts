/**
 * Compile a {@link FlowDocument} into an {@link ExecutionPlan}: validate, then
 * group nodes into scopes and compute adjacency and entry sets.
 *
 * @module @dsh-plugins/flow/host/engine/compile
 */

import type { FlowDocument, FlowEdge, FlowLookup, FlowNode, Issue } from '../../spec/types.ts'
import { validateFlow, type ValidateLimits } from '../../spec/validate.ts'

/** Thrown when a flow has error-level validation issues at compile time. */
export class FlowValidationError extends Error {
  constructor(readonly issues: Issue[]) {
    super(issues.map(issue => issue.message).join('; '))
    this.name = 'FlowValidationError'
  }
}

/** A per-scope execution plan. */
export interface ScopePlan {
  scope: string
  nodes: FlowNode[]
  /** Incoming edges per node, within this scope. */
  inEdges: Map<string, FlowEdge[]>
  /** Outgoing edges per node, within this scope. */
  outEdges: Map<string, FlowEdge[]>
  /** Entry node ids: `start` for root, body targets for a container. */
  entry: string[]
}

/** A compiled flow. */
export interface ExecutionPlan {
  doc: FlowDocument
  scopes: Map<string, ScopePlan>
}

/** Compile a flow into an execution plan. */
export function compile(doc: FlowDocument, lookup: FlowLookup, limits: ValidateLimits): ExecutionPlan {
  const issues = validateFlow(doc, lookup, limits)
  const errors = issues.filter(issue => issue.severity === 'error')
  if (errors.length > 0) throw new FlowValidationError(errors)

  const scopes = new Map<string, ScopePlan>()
  const scopeIds = new Set<string>(['root'])
  for (const node of doc.nodes) {
    if (node.type === 'loop' || node.type === 'batch') scopeIds.add(node.id)
  }
  for (const scope of scopeIds) {
    const nodes = doc.nodes.filter(node => (node.parentId ?? 'root') === scope)
    const inEdges = new Map<string, FlowEdge[]>()
    const outEdges = new Map<string, FlowEdge[]>()
    const nodeIds = new Set(nodes.map(node => node.id))
    for (const node of nodes) {
      inEdges.set(node.id, [])
      outEdges.set(node.id, [])
    }
    for (const edge of doc.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
      outEdges.get(edge.source)?.push(edge)
      inEdges.get(edge.target)?.push(edge)
    }
    let entry: string[]
    if (scope === 'root') {
      entry = nodes.filter(node => node.type === 'start').map(node => node.id)
    } else {
      entry = doc.edges.filter(edge => edge.source === scope && edge.sourceHandle === 'body').map(edge => edge.target)
    }
    scopes.set(scope, { scope, nodes, inEdges, outEdges, entry })
  }
  return { doc, scopes }
}
