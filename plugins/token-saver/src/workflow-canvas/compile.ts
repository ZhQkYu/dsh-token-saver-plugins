/**
 * Compile a canvas graph into an ordered step list. Pure functions only — this
 * is the most-tested part of the canvas. Steps are topologically ordered, with
 * same-level nodes sorted by `position.y` then `x`. Cycles are rejected.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas/compile
 */

import { ELSE_BRANCH, type CanvasGraph, type CanvasNode, type CompiledStep, type NodeKind, type RuleMatch } from '../protocol.ts'
import { MAX_EDGES, MAX_NODES } from './schema.ts'

/** One error carrying a stable `code` for the canvas. */
export class CanvasError extends Error {
  constructor(readonly code: 'CYCLE' | 'BAD_EDGE' | 'BAD_ID' | 'BAD_NODE' | 'BAD_REFERENCE' | 'TOO_MANY', message: string) {
    super(message)
    this.name = 'CanvasError'
  }
}

/** Looks up a saved workflow's name for hints; undefined when it does not exist. */
export type GraphNameLookup = (graphId: string) => string | undefined

function describeRule(rule: RuleMatch): string {
  switch (rule.op) {
    case 'contains': return `the input contains ${JSON.stringify(rule.value)}`
    case 'equals': return `the input equals ${JSON.stringify(rule.value)}`
    case 'regex': return `the input matches /${rule.value}/i`
  }
}

function describeWorkflow(graphId: string | undefined, graphName: GraphNameLookup | undefined): string {
  const name = graphId === undefined ? undefined : graphName?.(graphId)
  return name === undefined ? `workflow ${graphId ?? '(unset)'}` : `workflow "${name}" (graphId=${graphId ?? ''})`
}

/** Generate a model-facing hint for a step based on its node kind. */
export function hintFor(kind: NodeKind, config: CanvasNode['config'], graphName?: GraphNameLookup): string {
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
    case 'condition': {
      const branches = config.branches ?? []
      const choices = config.decide === 'rule'
        ? branches.map(branch => `"${branch.label}" if ${branch.rule === undefined ? 'its rule matches' : describeRule(branch.rule)}`)
        : branches.map(branch => `"${branch.label}"`)
      return `Choose exactly one branch: ${[...choices, `"${ELSE_BRANCH}" otherwise`].join(', ')}; report it in the summary, and report steps reached only through other branches as skipped`
    }
    case 'loop': {
      const exit = config.decide === 'rule' && config.exitRule !== undefined ? describeRule(config.exitRule).replace('the input', 'a round\'s result') : 'the instruction below is met'
      return `Repeat ${describeWorkflow(config.graphId, graphName)} for at most ${config.maxIterations ?? 1} rounds, feeding each round's result into the next, and stop early once ${exit}`
    }
    case 'subflow':
      return `Run ${describeWorkflow(config.graphId, graphName)} with canvas_workflow start, follow its steps, and use its result here`
    default:
      return 'Execute the node instruction'
  }
}

/**
 * Check the fields each control-flow kind needs and that only condition nodes emit branch edges.
 * @param graph - the graph whose nodes and edges to check.
 */
function validateControlFlow(graph: CanvasGraph): void {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  for (const node of graph.nodes) {
    const { config } = node
    const name = `${node.kind} node "${node.title === '' ? node.id : node.title}"`
    if (node.kind === 'condition') {
      const branches = config.branches ?? []
      if (branches.length === 0) throw new CanvasError('BAD_NODE', `${name} needs at least one branch`)
      const ids = new Set<string>()
      const labels = new Set<string>()
      for (const branch of branches) {
        if (branch.id === ELSE_BRANCH || ids.has(branch.id)) throw new CanvasError('BAD_NODE', `${name} has a duplicate or reserved branch id ${JSON.stringify(branch.id)}`)
        if (labels.has(branch.label)) throw new CanvasError('BAD_NODE', `${name} has two branches named "${branch.label}"`)
        ids.add(branch.id)
        labels.add(branch.label)
        if (config.decide === 'rule' && branch.rule === undefined) throw new CanvasError('BAD_NODE', `${name} decides by rule but branch "${branch.label}" has no rule`)
      }
    }
    if ((node.kind === 'loop' || node.kind === 'subflow') && config.graphId === undefined) {
      throw new CanvasError('BAD_NODE', `${name} needs a workflow`)
    }
    if (config.graphId !== undefined && config.graphId === graph.id) {
      throw new CanvasError('BAD_REFERENCE', `${name} references its own workflow`)
    }
    if (node.kind === 'loop') {
      if (config.maxIterations === undefined) throw new CanvasError('BAD_NODE', `${name} needs a round limit`)
      if (config.decide === 'rule' && config.exitRule === undefined) throw new CanvasError('BAD_NODE', `${name} decides by rule but has no exit rule`)
    }
  }
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source)
    if (source === undefined) continue
    if (source.kind !== 'condition') {
      if (edge.sourceHandle !== undefined) throw new CanvasError('BAD_EDGE', `edge ${edge.id} names a branch but its source is not a condition node`)
      continue
    }
    const handles = new Set([...(source.config.branches ?? []).map(branch => branch.id), ELSE_BRANCH])
    if (edge.sourceHandle === undefined || !handles.has(edge.sourceHandle)) {
      throw new CanvasError('BAD_EDGE', `edge ${edge.id} leaves condition node ${source.id} without a valid branch`)
    }
  }
}

/**
 * Compile a graph into an ordered step list, rejecting cycles, bad edges, and incomplete control-flow nodes.
 * @param graph - the graph to compile.
 * @param maxNodes - the node-count limit.
 * @param maxEdges - the edge-count limit.
 * @param graphName - resolves referenced workflow names for loop and subflow hints.
 * @returns the ordered steps.
 */
export function compileGraph(graph: CanvasGraph, maxNodes = MAX_NODES, maxEdges = MAX_EDGES, graphName?: GraphNameLookup): { steps: CompiledStep[] } {
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
  validateControlFlow(graph)

  const steps: CompiledStep[] = order.map(id => {
    const entry = nodeById.get(id)!
    const gates = graph.edges
      .filter(edge => edge.target === id && edge.sourceHandle !== undefined)
      .map((edge) => {
        const branches = nodeById.get(edge.source)!.node.config.branches ?? []
        const label = branches.find(branch => branch.id === edge.sourceHandle)?.label ?? ELSE_BRANCH
        return `[${edge.source}] chose "${label}"`
      })
    const hint = hintFor(entry.node.kind, entry.node.config, graphName)
    return {
      nodeId: id,
      kind: entry.node.kind,
      title: entry.node.title,
      instruction: entry.node.instruction,
      dependsOn: [...entry.dependsOn],
      hint: gates.length === 0 ? hint : `Only if ${gates.join(' or ')}; otherwise report skipped. ${hint}`,
    }
  })
  return { steps }
}

/**
 * Render compiled steps as the numbered list a model follows.
 * @param steps - the steps in execution order.
 * @returns one entry per step with its dependencies, instruction, and hint.
 */
export function formatSteps(steps: readonly (Omit<CompiledStep, 'kind'> & { kind: string })[]): string {
  return steps.map((step, index) => {
    const after = step.dependsOn.length === 0 ? '' : ` (after ${step.dependsOn.join(', ')})`
    return `${index + 1}. [${step.nodeId}] ${step.kind}: ${step.title}${after}\n   Instruction: ${step.instruction === '' ? '(none)' : step.instruction}\n   How: ${step.hint}`
  }).join('\n')
}

/** Sort nodes by `position.y` then `position.x` for a stable level order. */
function compareNodes(nodeById: Map<string, { node: CanvasGraph['nodes'][number]; dependsOn: string[] }>): (a: string, b: string) => number {
  return (a, b) => {
    const na = nodeById.get(a)!.node.position
    const nb = nodeById.get(b)!.node.position
    return na.y - nb.y || na.x - nb.x
  }
}
