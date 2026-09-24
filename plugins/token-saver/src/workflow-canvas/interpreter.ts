/**
 * The strict-mode interpreter: one fixed workflow-engine script that walks a
 * {@link StrictPlan} passed as `args`. Nodes start as soon as their inputs
 * settle, so independent branches run in parallel within the engine's
 * concurrency limit; condition nodes route by branch, loop and subflow nodes
 * run nested workflows. Every model step is one `agent()` child.
 *
 * {@link interpretPlan} must stay self-contained: {@link interpreterScript}
 * ships its source text to the engine, where no module scope exists.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas/interpreter
 */

import type { DecideMode, GraphMode, NodeKind, NodeStatus, RuleMatch } from '../protocol.ts'

/** One node as the interpreter needs it; prompts are rendered by the Host. */
export interface PlanNode {
  id: string
  kind: NodeKind
  title: string
  /** The full step prompt for model steps; empty for `input` pass-through. */
  prompt: string
  /** `condition` and `loop`: the decision question (the node instruction). */
  question: string
  decide: DecideMode
  branches: { id: string; label: string; rule: RuleMatch | null }[]
  /** `loop` body or `subflow` target. */
  graphId: string | null
  maxIterations: number
  exitRule: RuleMatch | null
}

/** One workflow in a plan; guided workflows run as a single model step. */
export interface PlanGraph {
  id: string
  name: string
  mode: GraphMode
  nodes: PlanNode[]
  edges: { source: string; target: string; sourceHandle: string | null }[]
  /** Guided workflows: the step list the model follows. */
  guidedPrompt: string | null
}

/** Everything a strict run needs, as plain JSON. */
export interface StrictPlan {
  /** Marks this interpreter's `log()` lines. */
  tag: string
  rootId: string
  /** Text the root workflow starts from; empty when none was given. */
  input: string
  /** Longest step output passed downstream. */
  maxOutputChars: number
  graphs: Record<string, PlanGraph>
}

/** One progress line, logged as JSON. `path` lists the enclosing loop/subflow node ids from the root. */
export interface ProgressEvent {
  tag: string
  path: string[]
  node: string
  title: string
  status: NodeStatus
  summary?: string
  branch?: string
  iteration?: number
}

/** The run's return value. */
export interface InterpreterResult {
  /** The done final nodes' outputs. */
  output: string
  /** Whether any root step failed. */
  failed: boolean
}

/** The engine hooks the interpreter calls. */
export interface InterpreterHooks {
  agent(prompt: string, options: { label: string; schema?: object }): Promise<unknown>
  log(message: string): void
}

/**
 * Run a plan to completion.
 * @param plan - the plan, as JSON data.
 * @param hooks - the engine's `agent` and `log` hooks.
 * @returns the root workflow's final output and whether a step failed.
 */
export async function interpretPlan(plan: StrictPlan, hooks: InterpreterHooks): Promise<InterpreterResult> {
  const NONE = 'none of these'
  class StepFailed extends Error {}
  type Input = { title: string; text: string }
  type Settled = { status: 'done' | 'failed' | 'skipped' | 'blocked'; output: string; branch?: string; iteration?: number }

  const clip = (text: string): string => text.length <= plan.maxOutputChars ? text : `${text.slice(0, plan.maxOutputChars)}\n…(truncated)`
  const brief = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300)
  const titled = (inputs: Input[]): string => inputs.map(input => `## ${input.title}\n${input.text}`).join('\n\n')
  const raw = (inputs: Input[]): string => inputs.map(input => input.text).join('\n\n')
  const emit = (path: string[], node: PlanNode, status: NodeStatus, extra: Partial<ProgressEvent> = {}): void => {
    hooks.log(JSON.stringify({ tag: plan.tag, path, node: node.id, title: node.title, status, ...extra }))
  }
  const matches = (rule: RuleMatch, text: string): boolean => {
    switch (rule.op) {
      case 'contains': return text.toLowerCase().includes(rule.value.toLowerCase())
      case 'equals': return text.trim() === rule.value.trim()
      case 'regex': return new RegExp(rule.value, 'i').test(text)
    }
  }
  const labelOf = (node: PlanNode, suffix = ''): string => `${node.title === '' ? node.kind : node.title}${suffix}`

  const ask = async (prompt: string, inputs: Input[], label: string): Promise<string> => {
    const body = inputs.length === 0 ? prompt : `${prompt}\n\nInputs from previous steps:\n\n${titled(inputs)}`
    const text = await hooks.agent(body, { label })
    if (typeof text !== 'string') throw new StepFailed('the step agent did not complete')
    return clip(text)
  }

  const decideBranch = async (node: PlanNode, inputs: Input[]): Promise<string> => {
    if (node.decide === 'rule') {
      const text = raw(inputs)
      return node.branches.find(branch => branch.rule !== null && matches(branch.rule, text))?.id ?? 'else'
    }
    const options = [...node.branches.map(branch => branch.label), NONE]
    const prompt = `You are a routing step in an automated workflow. Read the input and choose exactly one option.\n`
      + `Question: ${node.question === '' ? 'Which option describes the input best?' : node.question}\n`
      + `Options:\n${options.map(option => `- ${option}`).join('\n')}\n\nInput:\n\n${titled(inputs)}\n\n`
      + 'Put the chosen option, verbatim, in `choice` and one sentence of reasoning in `reason`.'
    const schema = {
      type: 'object',
      properties: { choice: { type: 'string', enum: options }, reason: { type: 'string' } },
      required: ['choice', 'reason'],
      additionalProperties: false,
    }
    const value = await hooks.agent(prompt, { label: labelOf(node, ' · decide'), schema })
    if (typeof value !== 'object' || value === null || !('choice' in value)) throw new StepFailed('the decision agent did not complete')
    return node.branches.find(branch => branch.label === value.choice)?.id ?? 'else'
  }

  const shouldStop = async (node: PlanNode, output: string, round: number): Promise<boolean> => {
    if (node.decide === 'rule') return node.exitRule !== null && matches(node.exitRule, output)
    if (node.question === '') return false
    const prompt = 'You check whether a loop in an automated workflow should stop.\n'
      + `Stop condition: ${node.question}\n\nResult of round ${round}:\n\n${output}\n\n`
      + 'Set `stop` to true only if the stop condition is met, and give one sentence of reasoning in `reason`.'
    const schema = {
      type: 'object',
      properties: { stop: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['stop', 'reason'],
      additionalProperties: false,
    }
    const value = await hooks.agent(prompt, { label: labelOf(node, ` · check round ${round}`), schema })
    if (typeof value !== 'object' || value === null || !('stop' in value)) throw new StepFailed('the loop check agent did not complete')
    return value.stop === true
  }

  const runUnit = async (graphId: string, input: string, path: string[], label: string): Promise<string> => {
    const graph = plan.graphs[graphId]
    if (graph === undefined) throw new StepFailed(`workflow ${graphId} is missing from the plan`)
    if (graph.mode === 'guided') return ask(graph.guidedPrompt ?? '', input === '' ? [] : [{ title: 'Input', text: input }], label)
    const result = await runGraph(graph, input, path)
    if (result.failed) throw new StepFailed(`a step of workflow "${graph.name}" failed`)
    return result.output
  }

  const execute = async (node: PlanNode, inputs: Input[], path: string[]): Promise<Omit<Settled, 'status'>> => {
    switch (node.kind) {
      case 'condition':
        return { output: titled(inputs), branch: await decideBranch(node, inputs) }
      case 'subflow':
        return { output: await runUnit(node.graphId ?? '', titled(inputs), [...path, node.id], labelOf(node)) }
      case 'loop': {
        let carry = titled(inputs)
        let round = 1
        for (; round <= node.maxIterations; round++) {
          emit(path, node, 'running', { iteration: round })
          carry = await runUnit(node.graphId ?? '', carry, [...path, node.id], labelOf(node, ` #${round}`))
          if (round < node.maxIterations && await shouldStop(node, carry, round)) break
        }
        return { output: carry, iteration: Math.min(round, node.maxIterations) }
      }
      case 'input':
        if (node.prompt === '') return { output: raw(inputs) }
        return { output: await ask(node.prompt, inputs, labelOf(node)) }
      default:
        return { output: await ask(node.prompt, inputs, labelOf(node)) }
    }
  }

  async function runGraph(graph: PlanGraph, input: string, path: string[]): Promise<InterpreterResult> {
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    const incoming = new Map<string, PlanGraph['edges']>(graph.nodes.map(node => [node.id, []]))
    for (const edge of graph.edges) incoming.get(edge.target)?.push(edge)
    const settled = new Map<string, Promise<Settled>>()

    const run = async (node: PlanNode): Promise<Settled> => {
      const edges = incoming.get(node.id) ?? []
      const upstream = await Promise.all(edges.map(async edge => ({ edge, result: await settle(edge.source) })))
      if (upstream.some(({ result }) => result.status === 'failed' || result.status === 'blocked')) {
        emit(path, node, 'skipped', { summary: 'an upstream step failed' })
        return { status: 'blocked', output: '' }
      }
      const active = upstream.filter(({ edge, result }) => result.status === 'done' && (edge.sourceHandle === null || edge.sourceHandle === result.branch))
      if (edges.length > 0 && active.length === 0) {
        emit(path, node, 'skipped', { summary: 'not on the chosen branch' })
        return { status: 'skipped', output: '' }
      }
      const inputs: Input[] = edges.length === 0
        ? (input === '' ? [] : [{ title: 'Workflow input', text: input }])
        : active.map(({ edge, result }) => ({ title: labelOf(byId.get(edge.source) ?? node), text: result.output }))
      emit(path, node, 'running')
      try {
        const result = await execute(node, inputs, path)
        emit(path, node, 'done', {
          summary: node.kind === 'condition' ? '' : brief(result.output),
          ...(result.branch === undefined ? {} : { branch: result.branch }),
          ...(result.iteration === undefined ? {} : { iteration: result.iteration }),
        })
        return { status: 'done', ...result }
      } catch (error: unknown) {
        // Engine errors (cancellation, hook misuse) end the whole run.
        if (!(error instanceof StepFailed)) throw error
        emit(path, node, 'failed', { summary: error.message })
        return { status: 'failed', output: '' }
      }
    }

    function settle(id: string): Promise<Settled> {
      let pending = settled.get(id)
      if (pending === undefined) {
        const node = byId.get(id)
        pending = node === undefined ? Promise.resolve({ status: 'skipped', output: '' }) : run(node)
        settled.set(id, pending)
      }
      return pending
    }

    const results = await Promise.all(graph.nodes.map(async node => ({ node, result: await settle(node.id) })))
    const sources = new Set(graph.edges.map(edge => edge.source))
    const finals = results.filter(({ node, result }) => !sources.has(node.id) && result.status === 'done')
    return {
      output: finals.length === 1 ? finals[0]!.result.output : titled(finals.map(({ node, result }) => ({ title: labelOf(node), text: result.output }))),
      failed: results.some(({ result }) => result.status === 'failed'),
    }
  }

  const root = plan.graphs[plan.rootId]
  if (root === undefined) throw new Error(`root workflow ${plan.rootId} is missing from the plan`)
  return runGraph(root, plan.input, [])
}

/**
 * The engine script that runs {@link interpretPlan} on the run's `args`.
 * @returns a script body for `ctx.workflowEngine.start`.
 */
export function interpreterScript(): string {
  return `return await (${interpretPlan.toString()})(args, { agent, log })`
}
