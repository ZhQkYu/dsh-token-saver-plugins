/**
 * Flow validation: checks a {@link FlowDocument} for structural and semantic
 * problems. Saving a draft does not block; test-run and publish do. Each
 * {@link IssueCode} has at least one trigger test in `tests/validate.test.ts`.
 *
 * @module @dsh-plugins/flow/spec/validate
 */

import type { FlowDocument, FlowEdge, FlowLookup, FlowNode, InputBinding, Issue, IssueCode, VarSchema, ValueSource } from './types.ts'
import { GUIDED_NODE_TYPES, ID_PATTERN } from './types.ts'
import { flowKind } from './guided.ts'
import { NODE_SPECS, specOf } from './nodes/index.ts'
import { buildScopeIndex, containerChainOf, nodeById, nodesInScope, visibleOutputNodes, type ScopeIndex } from './scope.ts'
import { compatible } from './var-schema.ts'
import { templateVariables } from './template.ts'
import { isUnary } from './conditions.ts'

/** Limits and catalogs that validation checks against, drawn from config and the Host. */
export interface ValidateLimits {
  maxLoopIterations?: number
  maxBatchConcurrency?: number
  maxBatchItems?: number
  maxNodeTimeoutMs?: number
  maxRetries?: number
  maxNestingDepth?: number
  maxRegexInputChars?: number
  /** Registered tool names; when present, `tool` nodes naming another tool raise `TOOL_UNKNOWN`. */
  toolNames?: ReadonlySet<string>
  /** Whether `TOOL_UNKNOWN` is an error (publish, run start) rather than a warning (save, validate). */
  strictTools?: boolean
}

/** Names a loop reserves for its own inner variables. */
const RESERVED_INNER_NAMES = new Set(['item', 'index'])

/** Validate a flow document. */
export function validateFlow(doc: FlowDocument, lookup: FlowLookup, limits: ValidateLimits = {}): Issue[] {
  const issues: Issue[] = []
  const index = buildScopeIndex(doc)

  const nodeIds = new Set<string>()
  for (const node of doc.nodes) {
    if (!ID_PATTERN.test(node.id)) issues.push(mk('BAD_ID', `node id "${node.id}" is not valid`, { nodeId: node.id }))
    if (nodeIds.has(node.id)) issues.push(mk('DUPLICATE_ID', `duplicate node id "${node.id}"`, { nodeId: node.id }))
    nodeIds.add(node.id)
  }
  const edgeIds = new Set<string>()
  const edgeKeys = new Set<string>()
  for (const edge of doc.edges) {
    if (!ID_PATTERN.test(edge.id)) issues.push(mk('BAD_ID', `edge id "${edge.id}" is not valid`, { edgeId: edge.id }))
    if (edgeIds.has(edge.id)) issues.push(mk('DUPLICATE_ID', `duplicate edge id "${edge.id}"`, { edgeId: edge.id }))
    edgeIds.add(edge.id)
    const key = `${edge.source}\u0000${edge.sourceHandle}\u0000${edge.target}`
    if (edgeKeys.has(key)) issues.push(mk('DUPLICATE_ID', `edge "${edge.id}" duplicates another edge`, { edgeId: edge.id, severity: 'warning' }))
    edgeKeys.add(key)
  }

  const topNodes = nodesInScope(doc, 'root')
  const starts = topNodes.filter(n => n.type === 'start')
  const ends = topNodes.filter(n => n.type === 'end')
  if (starts.length !== 1) issues.push(mk('START_COUNT', `exactly one start node is required (found ${starts.length})`, { nodeId: starts[1]?.id }))
  if (ends.length !== 1) issues.push(mk('END_COUNT', `exactly one end node is required (found ${ends.length})`, { nodeId: ends[1]?.id }))
  for (const node of doc.nodes) {
    if ((node.type === 'start' || node.type === 'end') && node.parentId !== undefined) {
      issues.push(mk(node.type === 'start' ? 'START_COUNT' : 'END_COUNT', `${node.type} node cannot be inside a container`, { nodeId: node.id }))
    }
  }

  for (const node of doc.nodes) checkNode(node, doc, lookup, limits, index, issues)
  for (const edge of doc.edges) checkEdge(edge, doc, issues)
  for (const scope of scopesOf(doc)) {
    if (hasCycle(doc, scope)) issues.push(mk('CYCLE', `cycle detected in scope "${scope}"`, scope === 'root' ? {} : { nodeId: scope }))
  }
  checkReachability(doc, issues)
  checkSubflowGraph(doc, lookup, limits, issues)
  return flowKind(doc) === 'guided' ? guidedIssues(doc, issues) : issues
}

/**
 * Adjust issues for a guided flow: a model follows it, so typed-data checks
 * (types, placeholder result fields, rule-less branches) do not apply, unknown
 * template names are only warnings, and engine-only node types are rejected.
 */
function guidedIssues(doc: FlowDocument, issues: Issue[]): Issue[] {
  const out: Issue[] = []
  for (const issue of issues) {
    const field = issue.field ?? ''
    if (issue.code === 'TYPE_MISMATCH') continue
    if (issue.code === 'REQUIRED_INPUT' && field.endsWith('.value')) continue
    if (issue.code === 'BAD_NAME' && field.endsWith('.conditions')) continue
    out.push(issue.code === 'TEMPLATE_UNKNOWN_VAR' ? { ...issue, severity: 'warning' } : issue)
  }
  for (const node of doc.nodes) {
    if (!GUIDED_NODE_TYPES.includes(node.type)) out.push(mk('GUIDED_UNSUPPORTED', `${node.type} nodes need the engine and cannot be part of a guided flow`, { nodeId: node.id }))
  }
  return out
}

function checkNode(node: FlowNode, doc: FlowDocument, lookup: FlowLookup, limits: ValidateLimits, index: ScopeIndex, issues: Issue[]): void {
  const spec = specOf(node)

  if (node.parentId !== undefined) {
    const parent = nodeById(doc, node.parentId)
    if (parent === undefined) {
      issues.push(mk('BAD_PARENT', `node "${node.id}" references missing container "${node.parentId}"`, { nodeId: node.id }))
    } else {
      if (!NODE_SPECS[parent.type].container) issues.push(mk('BAD_PARENT', `node "${node.id}" parent "${node.parentId}" is not a container`, { nodeId: node.id }))
      const parentKind = parent.type === 'loop' ? 'loop' : parent.type === 'batch' ? 'batch' : 'root'
      if (spec.allowedParents !== undefined && !spec.allowedParents.includes(parentKind)) {
        issues.push(mk('BAD_PARENT', `node "${node.id}" cannot be inside a ${parentKind} container`, { nodeId: node.id }))
      }
    }
  } else if (spec.allowedParents !== undefined && !spec.allowedParents.includes('root')) {
    issues.push(mk('BAD_PARENT', `node "${node.id}" must be inside a ${spec.allowedParents.join('/')} container`, { nodeId: node.id }))
  }

  issues.push(...spec.validate(node, { doc, lookup }))

  for (const entry of iterValueSources(node)) checkValueSource(entry, node, doc, lookup, index, issues)

  for (const [i, binding] of iterBindings(node).entries()) {
    if ((binding.required ?? true) && binding.value.kind === 'literal' && binding.value.value === null) {
      issues.push(mk('REQUIRED_INPUT', `required input "${binding.name}" has no value`, { nodeId: node.id, field: `${bindingsField(node)}.${i}.value` }))
    }
  }
  for (const { text, field } of requiredTexts(node)) {
    if (text.trim() === '' && !issues.some(issue => issue.nodeId === node.id && issue.code === 'REQUIRED_INPUT' && issue.field === field)) {
      issues.push(mk('REQUIRED_INPUT', `${node.type} ${field} is required`, { nodeId: node.id, field }))
    }
  }

  const inputNames = new Set(iterBindings(node).map(b => b.name))
  for (const { template, field } of iterTemplates(node)) {
    for (const variable of templateVariables(template)) {
      if (!inputNames.has(variable)) {
        issues.push(mk('TEMPLATE_UNKNOWN_VAR', `template variable "{{${variable}}}" is not an input of node "${node.id}"`, { nodeId: node.id, field }))
      }
    }
  }

  if (node.type === 'loop') {
    for (const [i, variable] of node.data.variables.entries()) {
      if (RESERVED_INNER_NAMES.has(variable.name)) {
        issues.push(mk('BAD_NAME', `loop variable "${variable.name}" is reserved for the loop's inner variables`, { nodeId: node.id, field: `variables.${i}.name` }))
      }
    }
  }
  if (node.type === 'question' && node.data.answer.kind === 'options') {
    checkDuplicates(node.data.answer.options.map(option => option.label), node.id, 'answer.options', 'option label', issues)
    checkDuplicates(node.data.answer.options.map(option => option.id), node.id, 'answer.options', 'option id', issues)
  }
  if (node.type === 'condition') checkDuplicates(node.data.branches.map(branch => branch.id), node.id, 'branches', 'branch id', issues)
  if (node.type === 'intent') checkDuplicates(node.data.intents.map(intent => intent.id), node.id, 'intents', 'intent id', issues)
  if (node.type === 'aggregate') checkDuplicates(node.data.groups.map(group => group.name), node.id, 'groups', 'group name', issues)
  if (node.type === 'tool' && limits.toolNames !== undefined && node.data.tool !== '' && !limits.toolNames.has(node.data.tool)) {
    issues.push(mk('TOOL_UNKNOWN', `tool "${node.data.tool}" is not registered`, { nodeId: node.id, field: 'tool', severity: limits.strictTools === true ? 'error' : 'warning' }))
  }

  checkLimits(node, limits, issues)
}

function checkDuplicates(values: readonly string[], nodeId: string, field: string, label: string, issues: Issue[]): void {
  const seen = new Set<string>()
  for (const [i, value] of values.entries()) {
    if (seen.has(value)) issues.push(mk('DUPLICATE_NAME', `duplicate ${label} "${value}"`, { nodeId, field: `${field}.${i}` }))
    seen.add(value)
  }
}

function checkValueSource(entry: ValueSourceEntry, node: FlowNode, doc: FlowDocument, lookup: FlowLookup, index: ScopeIndex, issues: Issue[]): void {
  const { source, expected, field } = entry
  if (source.kind === 'literal') return
  if (source.source === 'output') {
    const refNode = nodeById(doc, source.node)
    if (refNode === undefined) {
      issues.push(mk('DANGLING_REF', `node "${node.id}" references missing node "${source.node}"`, { nodeId: node.id, field }))
      return
    }
    const outName = source.path[0]
    const outField = specOf(refNode).outputs(refNode, lookup).find(f => f.name === outName)
    if (outField === undefined) {
      issues.push(mk('DANGLING_REF', `node "${node.id}" references missing output "${source.node}.${outName}"`, { nodeId: node.id, field }))
      return
    }
    if (!visibleOutputNodes(doc, node.id, { index, includeOwnBody: entry.scope === 'body' }).has(source.node)) {
      issues.push(mk('NOT_ANCESTOR', `node "${node.id}" references non-ancestor output "${source.node}.${outName}"`, { nodeId: node.id, field }))
      return
    }
    if (expected !== undefined) {
      const comp = compatible(fieldSchemaAt(outField.schema, source.path.slice(1)), expected)
      if (!comp.ok) issues.push(mk('TYPE_MISMATCH', comp.reason, { nodeId: node.id, field }))
      else if (comp.severity === 'warning') issues.push(mk('TYPE_MISMATCH', comp.reason, { nodeId: node.id, field, severity: 'warning' }))
    }
    return
  }
  if (!containerChainOf(doc, node.id).includes(source.node)) {
    issues.push(mk('NOT_ANCESTOR', `node "${node.id}" references inner variable of non-ancestor container "${source.node}"`, { nodeId: node.id, field }))
    return
  }
  const container = nodeById(doc, source.node)
  const innerFields = container?.type === 'loop'
    ? NODE_SPECS.loop.innerVars?.(container, doc) ?? []
    : container?.type === 'batch'
      ? NODE_SPECS.batch.innerVars?.(container, doc) ?? []
      : []
  if (!innerFields.some(f => f.name === source.path[0])) {
    issues.push(mk('DANGLING_REF', `node "${node.id}" references missing inner variable "${source.node}.${source.path[0]}"`, { nodeId: node.id, field }))
  }
}

/** The schema at an object field path; unknown or loose paths are `any`. */
function fieldSchemaAt(schema: VarSchema, path: readonly string[]): VarSchema {
  let current = schema
  for (const segment of path) {
    if (current.type !== 'object' || current.properties === undefined) return { type: 'any' }
    const next = current.properties.find(field => field.name === segment)
    if (next === undefined) return { type: 'any' }
    current = next.schema
  }
  return current
}

function checkEdge(edge: FlowEdge, doc: FlowDocument, issues: Issue[]): void {
  const source = nodeById(doc, edge.source)
  const target = nodeById(doc, edge.target)
  if (source === undefined || target === undefined) {
    issues.push(mk('DANGLING_REF', `edge "${edge.id}" references a missing node`, { edgeId: edge.id }))
    return
  }
  if (!specOf(source).ports(source).some(p => p.id === edge.sourceHandle)) {
    issues.push(mk('UNKNOWN_PORT', `edge "${edge.id}" uses unknown source port "${edge.sourceHandle}"`, { nodeId: source.id, edgeId: edge.id }))
  }
  if (!specOf(target).hasInput(target)) {
    issues.push(mk('UNKNOWN_PORT', `edge "${edge.id}" targets node "${target.id}" which cannot receive input`, { nodeId: target.id, edgeId: edge.id }))
  }
  // A `body` edge crosses from a container into its own body scope; every other edge stays in one scope.
  if (edge.sourceHandle === 'body') {
    if (target.parentId !== source.id) issues.push(mk('CROSS_SCOPE_EDGE', `body edge "${edge.id}" must target a node inside the container`, { edgeId: edge.id }))
  } else if ((source.parentId ?? 'root') !== (target.parentId ?? 'root')) {
    issues.push(mk('CROSS_SCOPE_EDGE', `edge "${edge.id}" crosses scopes`, { edgeId: edge.id }))
  }
}

function checkLimits(node: FlowNode, limits: ValidateLimits, issues: Issue[]): void {
  if (node.type === 'loop' && limits.maxLoopIterations !== undefined && node.data.maxIterations > limits.maxLoopIterations) {
    issues.push(mk('BAD_LIMIT', `loop maxIterations ${node.data.maxIterations} exceeds limit ${limits.maxLoopIterations}`, { nodeId: node.id, field: 'maxIterations' }))
  }
  if (node.type === 'batch') {
    if (limits.maxBatchConcurrency !== undefined && node.data.concurrency > limits.maxBatchConcurrency) {
      issues.push(mk('BAD_LIMIT', `batch concurrency ${node.data.concurrency} exceeds limit ${limits.maxBatchConcurrency}`, { nodeId: node.id, field: 'concurrency' }))
    }
    if (limits.maxBatchItems !== undefined && node.data.maxItems > limits.maxBatchItems) {
      issues.push(mk('BAD_LIMIT', `batch maxItems ${node.data.maxItems} exceeds limit ${limits.maxBatchItems}`, { nodeId: node.id, field: 'maxItems' }))
    }
  }
  if (node.onError !== undefined) {
    if (limits.maxNodeTimeoutMs !== undefined && (node.onError.timeoutMs ?? 0) > limits.maxNodeTimeoutMs) {
      issues.push(mk('BAD_LIMIT', `timeout ${node.onError.timeoutMs} exceeds limit ${limits.maxNodeTimeoutMs}`, { nodeId: node.id, field: 'onError.timeoutMs' }))
    }
    if (limits.maxRetries !== undefined && (node.onError.retries ?? 0) > limits.maxRetries) {
      issues.push(mk('BAD_LIMIT', `retries ${node.onError.retries} exceeds limit ${limits.maxRetries}`, { nodeId: node.id, field: 'onError.retries' }))
    }
  }
  if (node.type === 'condition') {
    for (const [b, branch] of node.data.branches.entries()) {
      for (const [c, condition] of branch.conditions.entries()) {
        const field = `branches.${b}.conditions.${c}.right`
        if (!isUnary(condition.op) && condition.right === undefined) {
          issues.push(mk('REQUIRED_INPUT', `operator "${condition.op}" requires a right value`, { nodeId: node.id, field }))
        }
        if (condition.op === 'matches' && condition.right?.kind === 'literal' && typeof condition.right.value === 'string') {
          try {
            new RegExp(condition.right.value, 'u')
          } catch {
            issues.push(mk('BAD_REGEX', 'matches pattern is not a valid regex', { nodeId: node.id, field }))
          }
        }
      }
    }
  }
}

function checkReachability(doc: FlowDocument, issues: Issue[]): void {
  const top = nodesInScope(doc, 'root')
  const start = top.find(n => n.type === 'start')
  if (start !== undefined) {
    const reachable = reachableSet(doc, start.id, 'root')
    for (const node of top) {
      if (node.type === 'comment' || node.id === start.id || reachable.has(node.id)) continue
      issues.push(mk('UNREACHABLE', `node "${node.id}" is not reachable from start`, { nodeId: node.id, severity: 'warning' }))
      if (node.type === 'end') issues.push(mk('END_UNREACHABLE', 'end node is not reachable from start', { nodeId: node.id }))
    }
  }
  for (const container of doc.nodes) {
    if (container.type !== 'loop' && container.type !== 'batch') continue
    const bodyTargets = doc.edges.filter(e => e.source === container.id && e.sourceHandle === 'body').map(e => e.target)
    if (bodyTargets.length === 0) issues.push(mk('LOOP_BODY_EMPTY', `container "${container.id}" has no body edges`, { nodeId: container.id }))
    const reachable = new Set<string>()
    for (const entry of bodyTargets) for (const n of reachableSet(doc, entry, container.id)) reachable.add(n)
    for (const node of nodesInScope(doc, container.id)) {
      if (node.type !== 'comment' && !reachable.has(node.id)) issues.push(mk('UNREACHABLE', `node "${node.id}" is not reachable from the body`, { nodeId: node.id, severity: 'warning' }))
    }
  }
}

/** Detect subflow recursion and nesting depth through the lookup's `subflows` references. */
function checkSubflowGraph(doc: FlowDocument, lookup: FlowLookup, limits: ValidateLimits, issues: Issue[]): void {
  const maxDepth = limits.maxNestingDepth
  for (const node of doc.nodes) {
    if (node.type !== 'subflow' || node.data.flowId === '') continue
    const visit = (flowId: string, version: 'published' | 'draft', chain: string[]): 'recursion' | 'depth' | undefined => {
      if (chain.includes(flowId)) return 'recursion'
      if (maxDepth !== undefined && chain.length > maxDepth) return 'depth'
      for (const ref of lookup(flowId, version)?.subflows ?? []) {
        const found = visit(ref.flowId, ref.version, [...chain, flowId])
        if (found !== undefined) return found
      }
      return undefined
    }
    const found = visit(node.data.flowId, node.data.version, [doc.id])
    if (found === 'recursion') issues.push(mk('SUBFLOW_RECURSION', `subflow "${node.data.flowId}" leads back to a flow already on its call chain`, { nodeId: node.id, field: 'flowId' }))
    if (found === 'depth') issues.push(mk('SUBFLOW_DEPTH', `subflow "${node.data.flowId}" nests deeper than ${maxDepth}`, { nodeId: node.id, field: 'flowId' }))
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
    stack.push(...(adjacency.get(current) ?? []))
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
    for (const next of adjacency.get(id) ?? []) if (dfs(next)) return true
    visiting.delete(id)
    visited.add(id)
    return false
  }
  return nodes.some(node => dfs(node.id))
}

function scopesOf(doc: FlowDocument): string[] {
  const scopes = new Set<string>(['root'])
  for (const node of doc.nodes) if (node.type === 'loop' || node.type === 'batch') scopes.add(node.id)
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

/** The data field holding a node's bindings, for issue locations. */
function bindingsField(node: FlowNode): string {
  return node.type === 'tool' ? 'args' : 'inputs'
}

/** Free-text fields a node cannot run without. */
function requiredTexts(node: FlowNode): { text: string; field: string }[] {
  switch (node.type) {
    case 'llm': return [{ text: node.data.prompt, field: 'prompt' }]
    case 'intent': return [{ text: node.data.query, field: 'query' }]
    case 'agent': return [{ text: node.data.prompt, field: 'prompt' }]
    case 'http': return [{ text: node.data.url, field: 'url' }]
    case 'tool': return [{ text: node.data.tool, field: 'tool' }]
    case 'question': return [{ text: node.data.question, field: 'question' }]
    default: return []
  }
}

/** One value source a node references, with its expected schema, location, and resolution scope. */
export interface ValueSourceEntry {
  source: ValueSource
  expected?: VarSchema
  field: string
  /** `body` only for a container's `outputs[].value`, which reads the container's own body nodes. */
  scope: 'outer' | 'body'
}

/** All value sources a node references. */
export function iterValueSources(node: FlowNode): ValueSourceEntry[] {
  const out: ValueSourceEntry[] = []
  const push = (source: ValueSource, expected: VarSchema | undefined, field: string, scope: 'outer' | 'body' = 'outer'): void => {
    out.push({ source, field, scope, ...(expected === undefined ? {} : { expected }) })
  }
  const bindingsKey = bindingsField(node)
  for (const [i, binding] of iterBindings(node).entries()) push(binding.value, binding.schema, `${bindingsKey}.${i}.value`)
  switch (node.type) {
    case 'condition':
      for (const [b, branch] of node.data.branches.entries()) {
        for (const [c, condition] of branch.conditions.entries()) {
          push(condition.left, { type: 'any' }, `branches.${b}.conditions.${c}.left`)
          if (condition.right !== undefined) push(condition.right, { type: 'any' }, `branches.${b}.conditions.${c}.right`)
        }
      }
      break
    case 'text': if (node.data.op === 'split') push(node.data.input, { type: 'string' }, 'input'); break
    case 'json': push(node.data.input, node.data.op === 'parse' ? { type: 'string' } : { type: 'any' }, 'input'); break
    case 'aggregate':
      for (const [g, group] of node.data.groups.entries()) for (const [c, candidate] of group.candidates.entries()) push(candidate, group.schema, `groups.${g}.candidates.${c}`)
      break
    case 'loop':
      if (node.data.array !== undefined) push(node.data.array, { type: 'array' }, 'array')
      if (node.data.count !== undefined) push(node.data.count, { type: 'integer' }, 'count')
      for (const [i, variable] of node.data.variables.entries()) push(variable.initial, variable.schema, `variables.${i}.initial`)
      for (const [i, output] of node.data.outputs.entries()) push(output.value, { type: 'any' }, `outputs.${i}.value`, 'body')
      break
    case 'batch':
      push(node.data.array, { type: 'array' }, 'array')
      for (const [i, output] of node.data.outputs.entries()) push(output.value, { type: 'any' }, `outputs.${i}.value`, 'body')
      break
    case 'assign':
      for (const [i, assignment] of node.data.assignments.entries()) push(assignment.value, { type: 'any' }, `assignments.${i}.value`)
      break
    default: break
  }
  return out
}

/** All template fields a node uses, with the field name for error reporting. */
export function iterTemplates(node: FlowNode): { template: string; field: string }[] {
  switch (node.type) {
    case 'llm': return [{ template: node.data.system, field: 'system' }, { template: node.data.prompt, field: 'prompt' }]
    case 'intent': return [{ template: node.data.query, field: 'query' }]
    case 'agent': return [{ template: node.data.prompt, field: 'prompt' }]
    case 'http': {
      const out = [{ template: node.data.url, field: 'url' }]
      for (const [i, h] of node.data.headers.entries()) out.push({ template: h.value, field: `headers.${i}.value` })
      for (const [i, q] of node.data.query.entries()) out.push({ template: q.value, field: `query.${i}.value` })
      if (node.data.body.kind === 'json' || node.data.body.kind === 'text') out.push({ template: node.data.body.template, field: 'body' })
      else if (node.data.body.kind === 'form') for (const [i, f] of node.data.body.fields.entries()) out.push({ template: f.value, field: `body.fields.${i}.value` })
      return out
    }
    case 'text': return node.data.op === 'concat' ? [{ template: node.data.template, field: 'template' }] : []
    case 'end': return node.data.mode === 'text' && node.data.template !== undefined ? [{ template: node.data.template, field: 'template' }] : []
    case 'message': return [{ template: node.data.template, field: 'template' }]
    case 'question': return [{ template: node.data.question, field: 'question' }]
    default: return []
  }
}

function mk(code: IssueCode, message: string, at: { nodeId?: string | undefined; edgeId?: string; field?: string; severity?: 'error' | 'warning' }): Issue {
  return {
    severity: at.severity ?? 'error',
    code,
    message,
    ...(at.nodeId === undefined ? {} : { nodeId: at.nodeId }),
    ...(at.edgeId === undefined ? {} : { edgeId: at.edgeId }),
    ...(at.field === undefined ? {} : { field: at.field }),
  }
}
