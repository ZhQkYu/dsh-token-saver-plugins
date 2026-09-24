/**
 * Build a {@link StrictPlan} from a saved graph: resolve every workflow that a
 * strict graph references through loop or subflow nodes, reject missing,
 * recursive, or too-deep references before anything runs, and render each
 * step prompt on the Host so the interpreter only routes data.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas/plan
 */

import type { CanvasGraph, CanvasNode } from '../protocol.ts'
import { CanvasError, compileGraph, formatSteps, hintFor } from './compile.ts'
import type { PlanGraph, PlanNode, StrictPlan } from './interpreter.ts'

/** Limits a strict plan must satisfy. */
export interface PlanLimits {
  /** Longest nesting chain of loop and subflow references. */
  maxDepth: number
  /** Highest round limit a loop node may set. */
  maxLoopIterations: number
  /** Longest step output passed downstream. */
  maxOutputChars: number
}

/** Marks the interpreter's progress lines among other `workflow/log` narration. */
export const PROGRESS_TAG = 'token-saver-canvas'

const AGENT_KINDS = new Set(['input', 'task', 'web-ai', 'subagent', 'tool', 'review', 'output'])

function stepPrompt(graph: CanvasGraph, node: CanvasNode): string {
  if (node.kind === 'input' && node.instruction.trim() === '') return ''
  return `You are one step of the automated workflow "${graph.name}". Complete only this step and reply with its result; the reply is passed to the next steps.\n`
    + `Step: ${node.title === '' ? node.kind : node.title} (${node.kind})\n`
    + `Instruction: ${node.instruction.trim() === '' ? '(none; do what the step title says)' : node.instruction}\n`
    + `How: ${node.kind === 'web-ai'
      ? `${hintFor(node.kind, node.config)}; if web_ai_ask is not available, do it another way and say so in the reply`
      : hintFor(node.kind, node.config)}`
}

function guidedPrompt(graph: CanvasGraph, graphName: (id: string) => string | undefined): string {
  const { steps } = compileGraph(graph, undefined, undefined, graphName)
  return `You are running the workflow "${graph.name}" as one step of a larger automated workflow. `
    + 'Follow these steps in order without the canvas_workflow tool, then reply with the final result; the reply is passed to the next steps.\n'
    + formatSteps(steps)
}

function planNode(graph: CanvasGraph, node: CanvasNode, limits: PlanLimits): PlanNode {
  const { config } = node
  if (node.kind === 'loop' && (config.maxIterations ?? 0) > limits.maxLoopIterations) {
    throw new CanvasError('TOO_MANY', `loop node ${node.id} allows ${config.maxIterations} rounds; the limit is ${limits.maxLoopIterations}`)
  }
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    prompt: AGENT_KINDS.has(node.kind) ? stepPrompt(graph, node) : '',
    question: node.instruction.trim(),
    decide: config.decide ?? 'model',
    branches: (config.branches ?? []).map(branch => ({ id: branch.id, label: branch.label, rule: branch.rule ?? null })),
    graphId: config.graphId ?? null,
    maxIterations: config.maxIterations ?? 1,
    exitRule: config.exitRule ?? null,
  }
}

/**
 * Resolve and validate everything a strict run of `root` needs.
 * @param root - the workflow to run; its own mode is ignored, it always runs strictly.
 * @param lookup - reads a saved workflow by id.
 * @param limits - depth, loop, and output limits.
 * @param input - the text the run starts from.
 * @returns the plan the interpreter receives as `args`.
 */
export function buildStrictPlan(root: CanvasGraph, lookup: (id: string) => CanvasGraph | undefined, limits: PlanLimits, input: string): StrictPlan {
  const graphs: Record<string, PlanGraph> = {}
  const graphName = (id: string): string | undefined => lookup(id)?.name

  const visit = (graph: CanvasGraph, strict: boolean, chain: string[]): void => {
    if (chain.includes(graph.id)) {
      throw new CanvasError('BAD_REFERENCE', `workflow "${graph.name}" references itself through ${[...chain, graph.id].join(' → ')}`)
    }
    if (chain.length > limits.maxDepth) {
      throw new CanvasError('TOO_MANY', `workflows nest deeper than ${limits.maxDepth} levels: ${[...chain, graph.id].join(' → ')}`)
    }
    compileGraph(graph, undefined, undefined, graphName)
    if (!strict) {
      graphs[graph.id] ??= { id: graph.id, name: graph.name, mode: 'guided', nodes: [], edges: [], guidedPrompt: guidedPrompt(graph, graphName) }
      return
    }
    graphs[graph.id] ??= {
      id: graph.id,
      name: graph.name,
      mode: 'strict',
      nodes: graph.nodes.map(node => planNode(graph, node, limits)),
      edges: graph.edges.map(edge => ({ source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle ?? null })),
      guidedPrompt: null,
    }
    for (const node of graph.nodes) {
      if ((node.kind !== 'loop' && node.kind !== 'subflow') || node.config.graphId === undefined) continue
      const child = lookup(node.config.graphId)
      if (child === undefined) throw new CanvasError('BAD_REFERENCE', `${node.kind} node "${node.title}" references a workflow that no longer exists`)
      visit(child, child.mode === 'strict', [...chain, graph.id])
    }
  }

  visit(root, true, [])
  return { tag: PROGRESS_TAG, rootId: root.id, input, maxOutputChars: limits.maxOutputChars, graphs }
}
