/**
 * Guided flows: a flow a model follows instead of the engine running it. This
 * module compiles a guided flow into the numbered step list the model reads,
 * either in a conversation (reporting each step through `flow_workflow`) or as
 * one delegated agent inside another flow. It also defines the input/output
 * interface every flow kind exposes to callers.
 *
 * @module @dsh-plugins/flow/spec/guided
 */

import type { FlowDocument, FlowEdge, FlowKind, FlowNode, InputBinding, JsonValue, ValueSource, VarField } from './types.ts'
import { specOf } from './nodes/index.ts'
import { describeVarSchema } from './var-schema.ts'

/** The fixed conversation tool that lists, runs, and follows flows. */
export const FLOW_WORKFLOW_TOOL = 'flow_workflow'

/**
 * A document's kind.
 * @param doc - the flow.
 * @returns `flow` unless the document is guided.
 */
export function flowKind(doc: Pick<FlowDocument, 'kind'>): FlowKind {
  return doc.kind ?? 'flow'
}

/**
 * The inputs and outputs a flow exposes to runs, subflow nodes, and tools.
 * A guided flow without result fields returns its final result as `text`.
 * @param doc - the flow.
 * @returns the start fields and the end outputs.
 */
export function flowInterface(doc: FlowDocument): { inputs: VarField[]; outputs: VarField[] } {
  const start = doc.nodes.find(node => node.type === 'start')
  const end = doc.nodes.find(node => node.type === 'end')
  const inputs = start?.type === 'start'
    ? start.data.fields.map(field => ({ name: field.name, schema: field.schema, ...(field.required === undefined ? {} : { required: field.required }), ...(field.description === undefined ? {} : { description: field.description }) }))
    : []
  if (end?.type !== 'end') return { inputs, outputs: [] }
  if (end.data.mode === 'text' || (flowKind(doc) === 'guided' && end.data.inputs.length === 0)) return { inputs, outputs: [{ name: 'text', schema: { type: 'string' } }] }
  return { inputs, outputs: end.data.inputs.map(binding => ({ name: binding.name, schema: binding.schema })) }
}

/** One step of a compiled guided flow. */
export interface GuidedStep {
  nodeId: string
  /** `1`, `2`, … at the top level; `3.1`, `3.2`, … inside the body of step 3. */
  number: string
  type: FlowNode['type']
  title: string
  /** What to do, with `{{name}}` references explained on the `uses` line. */
  instruction: string
  /** How each referenced name is sourced. */
  uses: string[]
  /** Step numbers this step waits for. */
  after: string[]
  /** How to carry the step out and report it. */
  hint: string
}

/** How a compiled step list is meant to be followed. */
export type GuidedAudience = 'conversation' | 'agent'

/** Options for {@link compileGuided}. */
export interface GuidedOptions {
  /** Resolves a subflow id to its name. */
  flowName?: (flowId: string) => string | undefined
}

const SKIPPED_TYPES: ReadonlySet<FlowNode['type']> = new Set(['start', 'comment'])

function order(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  const ids = new Set(nodes.map(node => node.id))
  const inDegree = new Map(nodes.map(node => [node.id, 0]))
  for (const edge of edges) if (ids.has(edge.source) && ids.has(edge.target)) inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
  const byPosition = (a: FlowNode, b: FlowNode): number => a.position.y - b.position.y || a.position.x - b.position.x
  const ready = nodes.filter(node => inDegree.get(node.id) === 0).sort(byPosition)
  const out: FlowNode[] = []
  while (ready.length > 0) {
    const node = ready.shift() as FlowNode
    out.push(node)
    for (const edge of edges) {
      if (edge.source !== node.id || !ids.has(edge.target)) continue
      const degree = (inDegree.get(edge.target) ?? 1) - 1
      inDegree.set(edge.target, degree)
      if (degree === 0) {
        const target = nodes.find(candidate => candidate.id === edge.target)
        if (target !== undefined) ready.push(target)
        ready.sort(byPosition)
      }
    }
  }
  // Nodes on a cycle (rejected by validation) still appear, in position order.
  return [...out, ...nodes.filter(node => !out.includes(node)).sort(byPosition)]
}

function bindingsOf(node: FlowNode): InputBinding[] {
  switch (node.type) {
    case 'end': case 'agent': case 'subflow': case 'question': case 'message': case 'llm': case 'intent': case 'code': case 'http':
      return node.data.inputs
    case 'tool': return node.data.args
    case 'text': return node.data.op === 'concat' ? node.data.inputs : []
    default: return []
  }
}

function literalText(value: JsonValue): string {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value ?? null)
}

/**
 * Compile a flow into the step list a model follows. Start and comment nodes
 * are not steps; the start fields are the workflow inputs.
 * @param doc - the guided flow.
 * @param options - name resolution for subflows.
 * @returns the steps in execution order, loop bodies numbered under their loop.
 */
export function compileGuided(doc: FlowDocument, options: GuidedOptions = {}): GuidedStep[] {
  const numbers = new Map<string, string>()
  const steps: GuidedStep[] = []
  const titleOf = (id: string): string => {
    const node = doc.nodes.find(candidate => candidate.id === id)
    return node === undefined ? id : node.title || node.type
  }
  const describe = (source: ValueSource): string => {
    if (source.kind === 'literal') return literalText(source.value)
    const node = doc.nodes.find(candidate => candidate.id === source.node)
    const field = source.path.join('.')
    if (source.source === 'inner') return `the current ${field} of loop step ${numbers.get(source.node) ?? '?'} (${titleOf(source.node)})`
    if (node?.type === 'start') return `the workflow input "${field}"`
    return `"${field}" from step ${numbers.get(source.node) ?? '?'} (${titleOf(source.node)})`
  }
  const branchLabel = (source: FlowNode, handle: string): string => {
    const port = specOf(source).ports(source).find(candidate => candidate.id === handle)
    return port?.label ?? handle
  }

  const visit = (parentId: string | undefined, prefix: string): void => {
    const scopeNodes = doc.nodes.filter(node => node.parentId === parentId)
    const ids = new Set(scopeNodes.map(node => node.id))
    const edges = doc.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target) && edge.sourceHandle !== 'body')
    let counter = 0
    const ordered = order(scopeNodes, edges).filter(node => !SKIPPED_TYPES.has(node.type))
    for (const node of ordered) numbers.set(node.id, `${prefix}${++counter}`)
    for (const node of ordered) {
      const incoming = edges.filter(edge => edge.target === node.id)
      const after = incoming.map(edge => numbers.get(edge.source)).filter((value): value is string => value !== undefined)
      const gates = incoming.flatMap((edge) => {
        const source = doc.nodes.find(candidate => candidate.id === edge.source)
        if (source === undefined || edge.sourceHandle === 'next') return []
        const kind = specOf(source).ports(source).find(port => port.id === edge.sourceHandle)?.kind
        return kind === 'branch' || kind === 'error' ? [`step ${numbers.get(source.id) ?? '?'} chose "${branchLabel(source, edge.sourceHandle)}"`] : []
      })
      const { instruction, hint } = stepText(node, describe, options)
      steps.push({
        nodeId: node.id,
        number: numbers.get(node.id) ?? '?',
        type: node.type,
        title: node.title || node.type,
        instruction,
        uses: bindingsOf(node).map(binding => `${binding.name} = ${describe(binding.value)}`),
        after,
        hint: gates.length === 0 ? hint : `Only if ${gates.join(' or ')}; otherwise report it skipped. ${hint}`,
      })
      if (node.type === 'loop') visit(node.id, `${numbers.get(node.id) ?? '?'}.`)
    }
  }
  visit(undefined, '')
  return steps
}

function stepText(node: FlowNode, describe: (source: ValueSource) => string, options: GuidedOptions): { instruction: string; hint: string } {
  switch (node.type) {
    case 'agent': {
      const extras = [
        node.data.persona === undefined ? '' : `Role: ${node.data.persona}`,
        node.data.tools?.allow === undefined ? '' : `Use only these tools: ${node.data.tools.allow.join(', ') || '(none)'}`,
        node.data.outputs === undefined ? '' : `Produce: ${node.data.outputs.map(field => `${field.name} (${describeVarSchema(field.schema)})`).join(', ')}`,
      ].filter(line => line !== '')
      return { instruction: [node.data.prompt, ...extras].join('\n'), hint: 'Do this step yourself with the tools you have.' }
    }
    case 'llm':
      return { instruction: [node.data.system, node.data.prompt].filter(text => text.trim() !== '').join('\n'), hint: 'Answer this step yourself.' }
    case 'tool':
      return { instruction: `Call the ${node.data.tool || '(unset)'} tool${node.data.args.length === 0 ? '' : ' with the arguments listed under Uses'}.`, hint: `Use the ${node.data.tool || 'named'} tool.` }
    case 'condition': {
      const branches = node.data.branches.map((branch) => {
        const rules = branch.conditions
          .filter(condition => !(condition.left.kind === 'literal' && condition.left.value === ''))
          .map(condition => `${describe(condition.left)} ${condition.op}${condition.right === undefined ? '' : ` ${describe(condition.right)}`}`)
        return rules.length === 0 ? `"${branch.label}"` : `"${branch.label}" when ${rules.join(branch.logic === 'and' ? ' and ' : ' or ')}`
      })
      return {
        instruction: node.description === undefined || node.description === '' ? `Decide which branch applies.` : node.description,
        hint: `Choose exactly one branch: ${[...branches, '"else" when none applies'].join(', ')}. Report the chosen branch, and report the steps reached only through other branches as skipped.`,
      }
    }
    case 'loop': {
      const bound = node.data.mode === 'array'
        ? `once for each item of ${node.data.array === undefined ? 'the list' : describe(node.data.array)} (at most ${node.data.maxIterations} rounds)`
        : node.data.mode === 'count'
          ? `${node.data.count === undefined ? node.data.maxIterations : describe(node.data.count)} times`
          : `at most ${node.data.maxIterations} times`
      const until = node.data.until === undefined || node.data.until.trim() === '' ? '' : `; stop early once ${node.data.until.trim()}`
      return { instruction: `Repeat the steps numbered under this one ${bound}${until}.`, hint: 'Report this step running when the first round starts and done when you stop repeating; report the inner steps in every round.' }
    }
    case 'break':
      return { instruction: 'Stop repeating the enclosing loop.', hint: 'Continue after the loop.' }
    case 'continue':
      return { instruction: 'Skip the rest of this round of the enclosing loop.', hint: 'Start the next round.' }
    case 'subflow': {
      const name = options.flowName?.(node.data.flowId) ?? node.data.flowId
      return {
        instruction: `Run the workflow "${name}" (flowId ${node.data.flowId})${node.data.inputs.length === 0 ? '' : ' with the inputs listed under Uses'} and use its result.`,
        hint: `Use ${FLOW_WORKFLOW_TOOL} with action "run" (or "start" if it is a guided workflow).`,
      }
    }
    case 'question': {
      const answer = node.data.answer
      const choices = answer.kind === 'options' ? ` Offer: ${answer.options.map(option => `"${option.label}"`).join(', ')}${answer.allowOther ? ', or another answer' : ''}.` : ''
      return { instruction: `Ask the user: ${node.data.question}${choices}`, hint: 'Wait for the reply before continuing; follow the branch of the chosen option.' }
    }
    case 'message':
      return { instruction: `Tell the user: ${node.data.template}`, hint: 'Say it in your reply.' }
    case 'end': {
      const fields = node.data.inputs.map(binding => `${binding.name} (${describeVarSchema(binding.schema)})`)
      const what = node.data.template ?? ''
      return {
        instruction: ['Produce the final result of the workflow.', what, fields.length === 0 ? '' : `Result fields: ${fields.join(', ')}.`].filter(line => line !== '').join('\n'),
        hint: 'This is the last step.',
      }
    }
    default:
      return { instruction: node.description ?? '', hint: `Carry out this ${node.type} step.` }
  }
}

/**
 * Render a guided flow as the text a model follows.
 * @param doc - the guided flow.
 * @param audience - `conversation` reports each step through the tool; `agent` just replies with the result.
 * @param inputs - the run inputs, shown at the top.
 * @param options - name resolution for subflows.
 * @param runId - the run to report on, for the conversation audience.
 * @returns the prompt text.
 */
export function guidedPrompt(doc: FlowDocument, audience: GuidedAudience, inputs: Record<string, JsonValue>, options: GuidedOptions = {}, runId?: string): string {
  const steps = compileGuided(doc, options)
  const { outputs } = flowInterface(doc)
  const header = [
    `Workflow "${doc.name}"${doc.description === '' ? '' : `: ${doc.description}`}`,
    Object.keys(inputs).length === 0 ? 'Inputs: none.' : `Inputs:\n${Object.entries(inputs).map(([name, value]) => `- ${name}: ${literalText(value)}`).join('\n')}`,
  ]
  const rules = audience === 'conversation'
    ? `Follow the steps in order; start a step only after the steps it comes after. Before each step call ${FLOW_WORKFLOW_TOOL} with action "report", runId "${runId ?? ''}", the step's nodeId, and status "running"; after it, report "done" with a one- or two-sentence summary (and the chosen branch for decisions), or "failed". Report skipped steps as "skipped". Report the last step done with the final result${outputs.some(field => field.name !== 'text') ? ` and outputs containing ${outputs.map(field => field.name).join(', ')}` : ''}.`
    : `Follow the steps in order yourself; do not call ${FLOW_WORKFLOW_TOOL} for this workflow. When you finish, reply with the final result${outputs.some(field => field.name !== 'text') ? ` as the requested fields (${outputs.map(field => field.name).join(', ')})` : ''}.`
  const body = steps.map((step) => {
    const lines = [`${step.number}. [${step.nodeId}] ${step.title}${step.after.length === 0 ? '' : ` (after ${step.after.join(', ')})`}`]
    if (step.instruction !== '') lines.push(`   Do: ${step.instruction.replace(/\n/g, '\n       ')}`)
    if (step.uses.length > 0) lines.push(`   Uses: ${step.uses.join('; ')}`)
    lines.push(`   How: ${step.hint}`)
    return lines.join('\n')
  })
  return [...header, rules, 'Steps:', ...body].join('\n\n')
}
