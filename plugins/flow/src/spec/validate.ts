/**
 * Flow validation: checks a {@link FlowDocument} for structural and semantic
 * problems. Saving a draft does not block; test-run and publish do. Each
 * {@link IssueCode} has at least one trigger test in `tests/validate.test.ts`.
 *
 * @module @dsh-plugins/flow/spec/validate
 */

import type { FlowDocument, FlowEdge, FlowLookup, FlowNode, InputBinding, Issue, IssueCode, VarSchema, ValueSource } from './types.ts'
import { ID_PATTERN } from './types.ts'
import { NODE_SPECS, specOf } from './nodes/index.ts'
import { containerChainOf, isVisibleOutput, nodeById, nodesInScope } from './scope.ts'
import { compatible } from './var-schema.ts'
import { templateVariables } from './template.ts'
import { isUnary } from './conditions.ts'

/** Limits that validation checks against, drawn from config. */
export interface ValidateLimits {
  maxLoopIterations?: number
  maxBatchConcurrency?: number
  maxBatchItems?: number
  maxNodeTimeoutMs?: number
  maxRetries?: number
  maxNestingDepth?: number
  maxRegexInputChars?: number
}

/** Validate a flow document. */
export function validateFlow(doc: FlowDocument, lookup: FlowLookup, limits: ValidateLimits = {}): Issue[] {
  const issues: Issue[] = []
  const nodes = doc.nodes
  const edges = doc.edges

  // Ids: unique and valid.
  const nodeIds = new Set<string>()
  for (const node of nodes) {
    if (!ID_PATTERN.test(node.id)) issues.push(mk('BAD_ID', `node id "${node.id}" is not valid`, node.id, undefined, undefined))
    if (nodeIds.has(node.id)) issues.push(mk('DUPLICATE_ID', `duplicate node id "${node.id}"`, node.id, undefined, undefined))
    nodeIds.add(node.id)
  }
  const edgeIds = new Set<string>()
  for (const edge of edges) {
    if (!ID_PATTERN.test(edge.id)) issues.push(mk('BAD_ID', `edge id "${edge.id}" is not valid`, undefined, edge.id, undefined))
    if (edgeIds.has(edge.id)) issues.push(mk('DUPLICATE_ID', `duplicate edge id "${edge.id}"`, undefined, edge.id, undefined))
    edgeIds.add(edge.id)
  }

  // Exactly one start and one end at the top level.
  const topNodes = nodesInScope(doc, 'root')
  const starts = topNodes.filter(n => n.type === 'start')
  const ends = topNodes.filter(n => n.type === 'end')
  if (starts.length !== 1) issues.push(mk('START_COUNT', `exactly one start node is required (found ${starts.length})`, starts[0]?.id, undefined, undefined))
  if (ends.length !== 1) issues.push(mk('END_COUNT', `exactly one end node is required (found ${ends.length})`, ends[0]?.id, undefined, undefined))
  for (const node of nodes) {
    if (node.type === 'start' || node.type === 'end') {
      if (node.parentId !== undefined) issues.push(mk(node.type === 'start' ? 'START_COUNT' : 'END_COUNT', `${node.type} node cannot be inside a container`, node.id, undefined, undefined))
    }
  }

  // Per-node checks.
  for (const node of nodes) checkNode(node, doc, lookup, limits, issues)

  // Edge checks.
  for (const edge of edges) checkEdge(edge, doc, nodes, issues)

  // Cycles per scope.
  for (const scope of scopesOf(doc)) {
    if (hasCycle(doc, scope)) {
      issues.push(mk('CYCLE', `cycle detected in scope "${scope}"`, undefined, undefined, undefined))
    }
  }

  // Reachability (warnings).
  checkReachability(doc, issues)

  return issues
}

function checkNode(node: FlowNode, doc: FlowDocument, lookup: FlowLookup, limits: ValidateLimits, issues: Issue[]): void {
  const spec = specOf(node)

  // BAD_PARENT.
  if (node.parentId !== undefined) {
    const parent = nodeById(doc, node.parentId)
    if (parent === undefined) {
      issues.push(mk('BAD_PARENT', `node "${node.id}" references missing container "${node.parentId}"`, node.id, undefined, undefined))
    } else {
      const parentSpec = NODE_SPECS[parent.type]
      if (!parentSpec.container) issues.push(mk('BAD_PARENT', `node "${node.id}" parent "${node.parentId}" is not a container`, node.id, undefined, undefined))
      const allowed = spec.allowedParents
      const parentKind = parent.type === 'loop' ? 'loop' : parent.type === 'batch' ? 'batch' : 'root'
      if (allowed !== undefined && !allowed.includes(parentKind as 'root' | 'loop' | 'batch')) {
        issues.push(mk('BAD_PARENT', `node "${node.id}" cannot be inside a ${parentKind} container`, node.id, undefined, undefined))
      }
    }
  }

  // Node-specific validation.
  issues.push(...spec.validate(node, { doc, lookup }))

  // Value source checks.
  for (const { source, expected } of iterValueSources(node)) {
    checkValueSource(source, expected, node, doc, lookup, issues)
  }

  // Template unknown vars.
  for (const { template, field } of iterTemplates(node)) {
    const inputNames = new Set((spec.hasInput(node) ? iterBindings(node).map(b => b.name) : []))
    for (const variable of templateVariables(template)) {
      if (!inputNames.has(variable)) {
        issues.push(mk('TEMPLATE_UNKNOWN_VAR', `template variable "{{${variable}}}" is not an input of node "${node.id}"`, node.id, undefined, field))
      }
    }
  }

  // Limits.
  checkLimits(node, limits, issues)
}

function checkValueSource(source: ValueSource, expected: VarSchema | undefined, node: FlowNode, doc: FlowDocument, lookup: FlowLookup, issues: Issue[]): void {
  if (source.kind === 'literal') return
  if (source.source === 'output') {
    const refNode = nodeById(doc, source.node)
    if (refNode === undefined) {
      issues.push(mk('DANGLING_REF', `node "${node.id}" references missing node "${source.node}"`, node.id, undefined, undefined))
      return
    }
    const outName = source.path[0]
    const refSpec = specOf(refNode)
    const outputs = refSpec.outputs(refNode, lookup)
    const field = outputs.find(f => f.name === outName)
    if (field === undefined) {
      issues.push(mk('DANGLING_REF', `node "${node.id}" references missing output "${source.node}.${outName}"`, node.id, undefined, undefined))
      return
    }
    if (!isVisibleOutput(doc, source.node, node.id)) {
      issues.push(mk('NOT_ANCESTOR', `node "${node.id}" references non-ancestor output "${source.node}.${outName}"`, node.id, undefined, undefined))
      return
    }
    if (expected !== undefined) {
      const comp = compatible(field.schema, expected)
      if (!comp.ok) issues.push(mk('TYPE_MISMATCH', comp.reason, node.id, undefined, undefined))
      else if (comp.severity === 'warning') issues.push(mk('TYPE_MISMATCH', comp.reason, node.id, undefined, undefined))
    }
  } else {
    // inner ref: the container must be an ancestor container of this node.
    const chain = containerChainOf(doc, node.id)
    if (!chain.includes(source.node)) {
      issues.push(mk('NOT_ANCESTOR', `node "${node.id}" references inner variable of non-ancestor container "${source.node}"`, node.id, undefined, undefined))
      return
    }
    const container = nodeById(doc, source.node)
    if (container === undefined) {
      issues.push(mk('DANGLING_REF', `node "${node.id}" references missing container "${source.node}"`, node.id, undefined, undefined))
      return
    }
    const innerName = source.path[0]
    const innerFields = container.type === 'loop'
      ? NODE_SPECS.loop.innerVars?.(container, doc) ?? []
      : container.type === 'batch'
        ? NODE_SPECS.batch.innerVars?.(container, doc) ?? []
        : []
    if (!innerFields.some(f => f.name === innerName)) {
      issues.push(mk('DANGLING_REF', `node "${node.id}" references missing inner variable "${source.node}.${innerName}"`, node.id, undefined, undefined))
    }
  }
}

function checkEdge(edge: FlowEdge, doc: FlowDocument, nodes: FlowNode[], issues: Issue[]): void {
  const source = nodeById(doc, edge.source)
  const target = nodeById(doc, edge.target)
  if (source === undefined || target === undefined) {
    issues.push(mk('DANGLING_REF', `edge "${edge.id}" references a missing node`, undefined, edge.id, undefined))
    return
  }
  const sourceSpec = specOf(source)
  const ports = sourceSpec.ports(source)
  if (!ports.some(p => p.id === edge.sourceHandle)) {
    issues.push(mk('UNKNOWN_PORT', `edge "${edge.id}" uses unknown source port "${edge.sourceHandle}"`, source.id, edge.id, undefined))
  }
  const targetSpec = specOf(target)
  if (!targetSpec.hasInput(target)) {
    issues.push(mk('UNKNOWN_PORT', `edge "${edge.id}" targets node "${target.id}" which cannot receive input`, target.id, edge.id, undefined))
  }
  // CROSS_SCOPE_EDGE. A `body` edge intentionally crosses from a container to
  // its own body scope, so it is exempt from the generic scope check and
  // validated against the container id below.
  if (edge.sourceHandle !== 'body' && (source.parentId ?? 'root') !== (target.parentId ?? 'root')) {
    issues.push(mk('CROSS_SCOPE_EDGE', `edge "${edge.id}" crosses scopes`, undefined, edge.id, undefined))
  }
  if (edge.sourceHandle === 'body') {
    if (target.parentId !== source.id) {
      issues.push(mk('CROSS_SCOPE_EDGE', `body edge "${edge.id}" must target a node inside the container`, undefined, edge.id, undefined))
    }
  }
  void nodes
}

function checkLimits(node: FlowNode, limits: ValidateLimits, issues: Issue[]): void {
  if (node.type === 'loop' && limits.maxLoopIterations !== undefined && node.data.maxIterations > limits.maxLoopIterations) {
    issues.push(mk('BAD_LIMIT', `loop maxIterations ${node.data.maxIterations} exceeds limit ${limits.maxLoopIterations}`, node.id, undefined, undefined))
  }
  if (node.type === 'batch') {
    if (limits.maxBatchConcurrency !== undefined && node.data.concurrency > limits.maxBatchConcurrency) {
      issues.push(mk('BAD_LIMIT', `batch concurrency ${node.data.concurrency} exceeds limit ${limits.maxBatchConcurrency}`, node.id, undefined, undefined))
    }
    if (limits.maxBatchItems !== undefined && node.data.maxItems > limits.maxBatchItems) {
      issues.push(mk('BAD_LIMIT', `batch maxItems ${node.data.maxItems} exceeds limit ${limits.maxBatchItems}`, node.id, undefined, undefined))
    }
  }
  if (node.onError !== undefined) {
    if (limits.maxNodeTimeoutMs !== undefined && (node.onError.timeoutMs ?? 0) > limits.maxNodeTimeoutMs) {
      issues.push(mk('BAD_LIMIT', `timeout ${node.onError.timeoutMs} exceeds limit ${limits.maxNodeTimeoutMs}`, node.id, undefined, undefined))
    }
    if (limits.maxRetries !== undefined && (node.onError.retries ?? 0) > limits.maxRetries) {
      issues.push(mk('BAD_LIMIT', `retries ${node.onError.retries} exceeds limit ${limits.maxRetries}`, node.id, undefined, undefined))
    }
  }
  if (node.type === 'condition') {
    for (const branch of node.data.branches) {
      for (const condition of branch.conditions) {
        if (!isUnary(condition.op) && condition.right === undefined) {
          issues.push(mk('REQUIRED_INPUT', `operator "${condition.op}" requires a right value`, node.id, undefined, undefined))
        }
        if (condition.op === 'matches' && condition.right?.kind === 'literal' && typeof condition.right.value === 'string') {
          try {
            new RegExp(condition.right.value, 'u')
          } catch {
            issues.push(mk('BAD_REGEX', 'matches pattern is not a valid regex', node.id, undefined, undefined))
          }
        }
      }
    }
  }
  if (node.type === 'subflow') {
    // Depth and recursion are checked by the caller against a stack; here only presence.
    void node
  }
}

function checkReachability(doc: FlowDocument, issues: Issue[]): void {
  const top = nodesInScope(doc, 'root')
  const start = top.find(n => n.type === 'start')
  if (start !== undefined) {
    const reachable = reachableSet(doc, start.id, 'root')
    for (const node of top) {
      if (node.type === 'comment') continue
      if (!reachable.has(node.id) && node.id !== start.id) {
        issues.push(mk('UNREACHABLE', `node "${node.id}" is not reachable from start`, node.id, undefined, undefined, 'warning'))
        if (node.type === 'end') issues.push(mk('END_UNREACHABLE', 'end node is not reachable from start', node.id, undefined, undefined, 'warning'))
      }
    }
  }
  // Container body reachability.
  for (const container of doc.nodes) {
    if (container.type !== 'loop' && container.type !== 'batch') continue
    const bodyTargets = doc.edges.filter(e => e.source === container.id && e.sourceHandle === 'body').map(e => e.target)
    const scope = container.id
    const bodyNodes = nodesInScope(doc, scope)
    if (bodyTargets.length === 0) {
      issues.push(mk('LOOP_BODY_EMPTY', `container "${container.id}" has no body edges`, container.id, undefined, undefined))
    }
    const reachable = new Set(bodyTargets)
    for (const entry of bodyTargets) {
      for (const n of reachableSet(doc, entry, scope)) reachable.add(n)
    }
    for (const node of bodyNodes) {
      if (!reachable.has(node.id)) issues.push(mk('UNREACHABLE', `node "${node.id}" is not reachable from the body`, node.id, undefined, undefined, 'warning'))
    }
  }
}

function reachableSet(doc: FlowDocument, from: string, scope: string): Set<string> {
  const out = new Set<string>()
  const adjacency = new Map<string, string[]>()
  for (const edge of doc.edges) {
    if (edge.sourceHandle === 'body') continue
    if ((nodeById(doc, edge.source)?.parentId ?? 'root') !== scope) continue
    const list = adjacency.get(edge.source) ?? []
    list.push(edge.target)
    adjacency.set(edge.source, list)
  }
  const stack = [from]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (out.has(current)) continue
    out.add(current)
    for (const next of adjacency.get(current) ?? []) stack.push(next)
  }
  return out
}

function hasCycle(doc: FlowDocument, scope: string): boolean {
  const nodes = nodesInScope(doc, scope)
  const ids = new Set(nodes.map(n => n.id))
  const adjacency = new Map<string, string[]>()
  for (const edge of doc.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue
    const list = adjacency.get(edge.source) ?? []
    list.push(edge.target)
    adjacency.set(edge.source, list)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of adjacency.get(id) ?? []) {
      if (dfs(next)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  for (const node of nodes) {
    if (dfs(node.id)) return true
  }
  return false
}

function scopesOf(doc: FlowDocument): string[] {
  const scopes = new Set<string>(['root'])
  for (const node of doc.nodes) {
    if (node.type === 'loop' || node.type === 'batch') scopes.add(node.id)
  }
  return [...scopes]
}

/** The named input bindings of a node. */
export function iterBindings(node: FlowNode): InputBinding[] {
  switch (node.type) {
    case 'end': return node.data.inputs
    case 'llm': return node.data.inputs
    case 'intent': return node.data.inputs
    case 'agent': return node.data.inputs
    case 'code': return node.data.inputs
    case 'http': return node.data.inputs
    case 'tool': return node.data.args
    case 'subflow': return node.data.inputs
    case 'question': return node.data.inputs
    case 'message': return node.data.inputs
    case 'text': return node.data.op === 'concat' ? node.data.inputs : []
    default: return []
  }
}

/** All value sources a node references, with an optional expected schema. */
export function iterValueSources(node: FlowNode): { source: ValueSource; expected?: VarSchema }[] {
  const out: { source: ValueSource; expected?: VarSchema }[] = []
  for (const binding of iterBindings(node)) out.push({ source: binding.value, expected: binding.schema })
  switch (node.type) {
    case 'condition': {
      for (const branch of node.data.branches) {
        for (const condition of branch.conditions) {
          out.push({ source: condition.left, expected: { type: 'any' } })
          if (condition.right !== undefined) out.push({ source: condition.right, expected: { type: 'any' } })
        }
      }
      break
    }
    case 'text': if (node.data.op === 'split') out.push({ source: node.data.input, expected: { type: 'string' } }); break
    case 'json': out.push({ source: node.data.input, expected: node.data.op === 'parse' ? { type: 'string' } : { type: 'any' } }); break
    case 'aggregate': for (const group of node.data.groups) for (const c of group.candidates) out.push({ source: c, expected: group.schema }); break
    case 'loop': {
      if (node.data.array !== undefined) out.push({ source: node.data.array, expected: { type: 'array' } })
      if (node.data.count !== undefined) out.push({ source: node.data.count, expected: { type: 'integer' } })
      for (const variable of node.data.variables) out.push({ source: variable.initial, expected: variable.schema })
      for (const output of node.data.outputs) out.push({ source: output.value, expected: { type: 'any' } })
      break
    }
    case 'batch': {
      out.push({ source: node.data.array, expected: { type: 'array' } })
      for (const output of node.data.outputs) out.push({ source: output.value, expected: { type: 'any' } })
      break
    }
    case 'assign': for (const assignment of node.data.assignments) out.push({ source: assignment.value, expected: { type: 'any' } }); break
    default: break
  }
  return out
}

/** All template fields a node uses, with the field name for error reporting. */
export function iterTemplates(node: FlowNode): { template: string; field: string }[] {
  switch (node.type) {
    case 'llm': return [{ template: node.data.prompt, field: 'prompt' }]
    case 'agent': return [{ template: node.data.prompt, field: 'prompt' }]
    case 'http': {
      const out = [{ template: node.data.url, field: 'url' }]
      for (const h of node.data.headers) out.push({ template: h.value, field: `headers.${h.name}` })
      for (const q of node.data.query) out.push({ template: q.value, field: `query.${q.name}` })
      if (node.data.body.kind === 'json' || node.data.body.kind === 'text') out.push({ template: node.data.body.template, field: 'body' })
      else if (node.data.body.kind === 'form') for (const f of node.data.body.fields) out.push({ template: f.value, field: `body.fields.${f.name}` })
      return out
    }
    case 'text': return node.data.op === 'concat' ? [{ template: node.data.template, field: 'template' }] : []
    case 'end': return node.data.mode === 'text' && node.data.template !== undefined ? [{ template: node.data.template, field: 'template' }] : []
    case 'message': return [{ template: node.data.template, field: 'template' }]
    case 'question': return [{ template: node.data.question, field: 'question' }]
    default: return []
  }
}

function mk(code: IssueCode, message: string, nodeId: string | undefined, edgeId: string | undefined, field: string | undefined, severity: 'error' | 'warning' = 'error'): Issue {
  return { severity, code, message, nodeId, edgeId, field }
}
