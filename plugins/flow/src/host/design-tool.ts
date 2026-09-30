/**
 * `flow_design`: the model-facing tool a workflow-designer agent uses to read
 * the node reference and tool catalog, write flows, validate them, run the
 * whole flow or one node with sample inputs, and read back a compact trace.
 * Publishing stays in the editor, so a person always reviews what becomes a
 * callable tool.
 *
 * @module @dsh-plugins/flow/host/design-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FlowDocument, FlowNode, Issue, JsonValue, RunEvent, RunView, RunViewNode } from '../spec/types.ts'
import { FLOW_KINDS, NODE_TYPES } from '../spec/types.ts'
import { NODE_SPECS } from '../spec/nodes/index.ts'
import { validateFlow, type ValidateLimits } from '../spec/validate.ts'
import { autoLayout } from '../spec/layout.ts'
import { debugInputsOf, isDebuggable } from '../spec/debug.ts'
import { foldRunEvents } from '../spec/run-view.ts'
import { describeVarSchema, jsonSchemaToVarSchema } from '../spec/var-schema.ts'
import { flowInterface } from '../spec/guided.ts'
import { FLOW_WORKFLOW_TOOL } from '../spec/guided.ts'
import { flowDocumentSchema } from './schemas.ts'
import type { FlowStore } from './store/flow-store.ts'
import type { RunStore } from './store/run-store.ts'
import type { FlowEngine } from './engine/engine.ts'
import type { ToolCatalog } from './known-tools.ts'
import { FlowValidationError } from './engine/compile.ts'

/** The tool name. */
export const FLOW_DESIGN_TOOL = 'flow_design'

/** Characters kept per recorded value in a trace. */
const TRACE_VALUE_CHARS = 1500

/** How often a design test checks whether its run stopped at a question. */
const WAIT_POLL_MS = 250

const ACTIONS = ['reference', 'catalog', 'list', 'get', 'create', 'save', 'validate', 'test', 'debug_node', 'answer', 'cancel', 'run', 'delete'] as const
type Action = (typeof ACTIONS)[number]

const DESCRIPTION = 'Design, validate, and debug workflows in the Flow editor. '
  + '`reference` returns every node type with its data fields and ports; `catalog` lists callable tools (with argument and output schemas) and existing flows. '
  + '`list`/`get` read flows. `create` makes an empty flow (name, description, kind). '
  + '`save` replaces a flow draft with `flow` (the full document; omit positions to auto-arrange) and returns validation issues. '
  + '`validate` checks a flow without saving. `test` runs the saved draft with `inputs` and returns every node\'s inputs, outputs, and errors. '
  + '`debug_node` runs one node alone with `inputs` keyed by its input names (upstream references are replaced by these values). '
  + 'When a run reaches a question node it pauses: the trace ends with status waiting and the question\'s execKey; '
  + 'reply with `answer` (runId, execKey, and `answer` {text} or {optionId}) to continue, or `cancel` the run. '
  + '`run` reads a past run by runId. `delete` removes a never-published flow (scratch or probe flows you created). The user publishes flows from the editor.'

/** What the design tool needs from the plugin. */
export interface DesignToolDeps {
  flowStore: FlowStore
  runStore: RunStore
  engine: FlowEngine
  toolCatalog: ToolCatalog
  toolPrefix: string
  limits: () => ValidateLimits
}

/**
 * Register `flow_design`.
 * @param ctx - the plugin context owning the registration.
 * @param deps - stores, engine, and catalog.
 */
export function registerDesignTool(ctx: Context, deps: DesignToolDeps): void {
  ctx.tools.register(defineTool({
    name: FLOW_DESIGN_TOOL,
    description: DESCRIPTION,
    parameters: {
      action: { type: 'string', required: true, enum: [...ACTIONS], description: 'What to do.' },
      flowId: { type: 'string', description: 'The flow id (get, save, validate, test, debug_node, delete).' },
      flow: { type: 'json', description: 'A full flow document (save, validate). Node `position` may be omitted; the flow is then arranged automatically.' },
      name: { type: 'string', description: 'The flow name (create).' },
      description: { type: 'string', description: 'The flow description (create).' },
      kind: { type: 'string', enum: [...FLOW_KINDS], description: 'The flow kind (create); default "flow".' },
      nodeId: { type: 'string', description: 'The node to run alone (debug_node).' },
      inputs: { type: 'json', description: 'test: the start inputs; debug_node: the node inputs keyed by input name.' },
      runId: { type: 'string', description: 'The run id (run, answer, cancel).' },
      execKey: { type: 'string', description: 'The waiting question\'s execKey (answer).' },
      answer: { type: 'json', description: 'The answer (answer): {"text": "..."} or {"optionId": "..."}.' },
      nodeType: { type: 'string', enum: [...NODE_TYPES], description: 'reference: only this node type.' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    timeoutMs: deps.engine.timeoutMs(),
    isConcurrencySafe: () => false,
    execute: async (args, exec): Promise<never> => {
      const workspacePath = exec.agent?.session.header.cwd
      const text = await runAction(deps, args.action as Action, args, workspacePath, exec.signal)
      return { text } as never
    },
  }))
}

interface DesignArgs {
  flowId?: string
  flow?: JsonValue
  name?: string
  description?: string
  kind?: string
  nodeId?: string
  inputs?: JsonValue
  runId?: string
  execKey?: string
  answer?: JsonValue
  nodeType?: string
}

async function runAction(deps: DesignToolDeps, action: Action, args: DesignArgs, workspacePath: string | undefined, signal: AbortSignal): Promise<string> {
  switch (action) {
    case 'reference': return nodeReference(args.nodeType)
    case 'catalog': return await catalogText(deps)
    case 'list': return listText(deps.flowStore)
    case 'get': return JSON.stringify(stripLayout(existing(deps.flowStore, required(args.flowId, 'flowId'))), null, 1)
    case 'create': {
      const kind = args.kind === 'guided' ? 'guided' : 'flow'
      const doc = deps.flowStore.create(required(args.name, 'name'), args.description ?? '', kind)
      return `Created flow ${doc.id} (${kind}) with a start and an end node:\n${JSON.stringify(stripLayout(doc), null, 1)}`
    }
    case 'validate': {
      const doc = prepare(args.flow, args.flowId === undefined ? undefined : deps.flowStore.get(args.flowId))
      return issuesText(validateFlow(doc, deps.flowStore.lookup, deps.limits()))
    }
    case 'save': {
      const current = existing(deps.flowStore, required(args.flowId, 'flowId'))
      const doc = prepare(args.flow, current)
      const issues = validateFlow(doc, deps.flowStore.lookup, deps.limits())
      const saved = await deps.flowStore.save(doc, current.revision)
      return `Saved ${saved.id} as revision ${saved.revision}. The editor shows it after reopening the flow.\n${issuesText(issues)}`
    }
    case 'test': {
      const flowId = required(args.flowId, 'flowId')
      const doc = existing(deps.flowStore, flowId)
      const { runId } = await deps.engine.start({ flowId, version: 'draft', inputs: args.inputs ?? {}, ...workspaceOf(workspacePath) })
        .catch((error: unknown) => { throw rejection(error) })
      return await awaitTrace(deps, doc, runId, signal)
    }
    case 'debug_node': {
      const doc = existing(deps.flowStore, required(args.flowId, 'flowId'))
      const nodeId = required(args.nodeId, 'nodeId')
      const node = doc.nodes.find(candidate => candidate.id === nodeId)
      if (node === undefined) throw new Error(`node ${nodeId} is not in flow ${doc.id}`)
      if (!isDebuggable(node)) throw new Error(`${node.type} nodes cannot run alone; use test to run the whole flow`)
      if (workspacePath === undefined) throw new Error('debug_node needs a session with a working directory')
      const { runId } = await deps.engine.debug(doc, nodeId, args.inputs ?? {}, { path: workspacePath })
        .catch((error: unknown) => { throw rejection(error, debugInputsText(node)) })
      return await awaitTrace(deps, doc, runId, signal)
    }
    case 'answer': {
      const runId = required(args.runId, 'runId')
      const answer = args.answer
      const reply = answer !== null && typeof answer === 'object' && !Array.isArray(answer)
        ? { ...(typeof answer['text'] === 'string' ? { text: answer['text'] } : {}), ...(typeof answer['optionId'] === 'string' ? { optionId: answer['optionId'] } : {}) }
        : typeof answer === 'string' ? { text: answer } : {}
      const result = await deps.engine.answer(runId, required(args.execKey, 'execKey'), reply)
      if (result === 'not-waiting') throw new Error(`run ${runId} has no question waiting at that execKey; read it with action run`)
      if (result === 'invalid') throw new Error('the answer does not fit the question: give {"optionId"} from its options, or {"text"} when it takes text or allows other')
      const summary = deps.runStore.get(runId)
      return await awaitTrace(deps, summary === undefined ? undefined : deps.flowStore.get(summary.flowId), runId, signal)
    }
    case 'cancel': {
      const runId = required(args.runId, 'runId')
      if (!await deps.engine.cancel(runId)) return `Run ${runId} is not running.`
      await deps.engine.awaitRun(runId)
      return `Cancelled run ${runId}.`
    }
    case 'delete': {
      const flowId = required(args.flowId, 'flowId')
      const summary = deps.flowStore.list().find(candidate => candidate.id === flowId)
      if (summary === undefined) throw new Error(`flow ${flowId} not found`)
      if (summary.publishedVersion !== undefined) throw new Error(`flow ${flowId} is published; only the user can delete it from the editor`)
      await deps.engine.cancelFlow(flowId)
      deps.flowStore.delete(flowId)
      return `Deleted flow ${flowId}.`
    }
    case 'run': {
      const runId = required(args.runId, 'runId')
      const summary = deps.runStore.get(runId)
      if (summary === undefined) throw new Error(`run ${runId} not found`)
      const doc = deps.flowStore.get(summary.flowId)
      return traceText(doc, foldRunEvents(deps.runStore.readEvents(runId)))
    }
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') throw new Error(`${FLOW_DESIGN_TOOL}: ${name} is required for this action`)
  return value
}

function existing(store: FlowStore, flowId: string): FlowDocument {
  const doc = store.get(flowId)
  if (doc === undefined) throw new Error(`flow ${flowId} not found`)
  return doc
}

function workspaceOf(workspacePath: string | undefined): { workspacePath?: string } {
  return workspacePath === undefined ? {} : { workspacePath }
}

/** Turn a start or debug failure into an error message the model can act on. */
function rejection(error: unknown, hint?: string): Error {
  if (error instanceof FlowValidationError) return new Error(`the flow does not validate:\n${issuesText(error.issues)}`)
  const message = error instanceof Error ? error.message : String(error)
  return new Error(hint === undefined ? message : `${message}\n${hint}`)
}

/**
 * Complete a model-written document: keep the stored identity, fill the
 * bookkeeping fields, and arrange the nodes when any position is missing.
 */
function prepare(raw: JsonValue | undefined, current: FlowDocument | undefined): FlowDocument {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${FLOW_DESIGN_TOOL}: flow must be a flow document object`)
  const input = raw as Record<string, JsonValue>
  const nodes = Array.isArray(input['nodes']) ? input['nodes'] : []
  const unplaced = nodes.some(node => node === null || typeof node !== 'object' || Array.isArray(node) || node['position'] === undefined)
  const candidate = {
    schemaVersion: 1,
    description: '',
    edges: [],
    ...input,
    id: current?.id ?? input['id'],
    name: input['name'] ?? current?.name,
    revision: current?.revision ?? 1,
    updatedAt: Date.now(),
    nodes: nodes.map(node => node !== null && typeof node === 'object' && !Array.isArray(node) && node['position'] === undefined ? { ...node, position: { x: 0, y: 0 } } : node),
  }
  const parsed = flowDocumentSchema.safeParse(candidate)
  if (!parsed.success) {
    const lines = parsed.error.issues.slice(0, 10).map(issue => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`the flow document is malformed:\n${lines.join('\n')}\nCall reference for the node data fields.`)
  }
  const doc = parsed.data as FlowDocument
  return unplaced ? autoLayout(doc) : doc
}

/** A document without canvas coordinates, which the model does not need to read. */
function stripLayout(doc: FlowDocument): unknown {
  return { ...doc, nodes: doc.nodes.map(({ position: _position, size: _size, ...node }) => node) }
}

function issuesText(issues: readonly Issue[]): string {
  if (issues.length === 0) return 'Validation: no issues.'
  const errors = issues.filter(issue => issue.severity === 'error').length
  const lines = issues.map(issue => `- ${issue.severity} ${issue.code}${issue.nodeId === undefined ? '' : ` node=${issue.nodeId}`}${issue.field === undefined ? '' : ` field=${issue.field}`}: ${issue.message}`)
  return `Validation: ${errors} error(s), ${issues.length - errors} warning(s). Errors block test runs and publishing.\n${lines.join('\n')}`
}

function listText(store: FlowStore): string {
  const flows = store.list().filter(summary => summary.broken !== true)
  if (flows.length === 0) return 'No flows exist yet.'
  return flows.map((summary) => {
    const doc = store.get(summary.id)
    const io = doc === undefined ? undefined : flowInterface(doc)
    const fields = (list: { name: string; schema: Parameters<typeof describeVarSchema>[0] }[] | undefined): string => list === undefined || list.length === 0 ? 'none' : list.map(field => `${field.name}: ${describeVarSchema(field.schema)}`).join(', ')
    return `- ${summary.id}: ${summary.name} [${summary.kind}, ${summary.publishedVersion === undefined ? 'draft' : `v${summary.publishedVersion}`}, ${summary.nodeCount} nodes]\n  inputs: ${fields(io?.inputs)}\n  outputs: ${fields(io?.outputs)}`
  }).join('\n')
}

async function catalogText(deps: DesignToolDeps): Promise<string> {
  await deps.toolCatalog.refresh()
  const hidden = (name: string): boolean => name === 'run_code' || name === FLOW_WORKFLOW_TOOL || name === FLOW_DESIGN_TOOL || name.startsWith(deps.toolPrefix)
  const tools = deps.toolCatalog.schemas().filter(tool => !hidden(tool.name)).map((tool) => {
    const params = jsonSchemaToVarSchema(tool.parameters)
    const output = deps.toolCatalog.outputSchema(tool.name)
    const args = (params.properties ?? []).map(field => `${field.name}${field.required === true ? '' : '?'}: ${describeVarSchema(field.schema)}`).join(', ')
    const value = output === undefined ? '' : `\n  value: ${describeVarSchema(jsonSchemaToVarSchema(output))}`
    return `- ${tool.name}(${args}) — ${firstLine(tool.description)}${value}`
  })
  return `Tools a tool node can call (args are bindings; the node outputs \`value\` and \`text\`):\n${tools.join('\n')}\n\nFlows a subflow node can call:\n${listText(deps.flowStore)}`
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

/** Every node type (or one) with its defaults, ports, and outputs, generated from the node specs. */
function nodeReference(only: string | undefined): string {
  const types = only === undefined ? NODE_TYPES : NODE_TYPES.filter(type => type === only)
  const common = 'Every node: { id, type, title, description?, parentId?, data, onError? }. '
    + 'onError is { onError: "fail" | "default" | "branch", timeoutMs?, retries? (0-5), defaultOutputs? }; timeoutMs and retries live only inside onError.'
  return [common, ...types.map((type) => {
    const spec = NODE_SPECS[type]
    const sample = { id: `${type}1`, type, title: type, position: { x: 0, y: 0 }, data: spec.defaults() } as FlowNode
    const ports = spec.ports(sample as never).map(port => port.id).join(', ') || 'none'
    const outputs = spec.outputs(sample as never, () => undefined).map(field => `${field.name}: ${describeVarSchema(field.schema)}`).join(', ') || 'declared by data'
    const where = spec.container ? 'container (children set parentId; body port enters the body)' : `allowed in: ${(spec.allowedParents ?? ['root']).join(', ')}`
    return `## ${type}\n${where}\nports: ${ports}\noutputs: ${outputs}\ndefault data: ${JSON.stringify(spec.defaults())}`
  })].join('\n\n')
}

function debugInputsText(node: FlowNode): string {
  const inputs = debugInputsOf(node)
  if (inputs.length === 0) return 'This node takes no inputs.'
  return `Node inputs:\n${inputs.map(input => `- ${input.name}: ${describeVarSchema(input.schema)}${input.required ? ' (required)' : ''}${input.ref === undefined ? ` default ${JSON.stringify(input.literal)}` : ` (from ${input.ref})`}`).join('\n')}`
}

/**
 * Wait until the run finishes or pauses at a question, then return its trace.
 * A paused run keeps waiting for `answer`; aborting the tool call cancels it.
 */
async function awaitTrace(deps: DesignToolDeps, doc: FlowDocument | undefined, runId: string, signal: AbortSignal): Promise<string> {
  const onAbort = (): void => { void deps.engine.cancel(runId) }
  signal.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  let paused = false
  try {
    const waiting = new Promise<void>((resolve) => {
      const check = (): void => {
        if (deps.runStore.get(runId)?.status === 'waiting') {
          paused = true
          resolve()
          return
        }
        timer = setTimeout(check, WAIT_POLL_MS)
      }
      timer = setTimeout(check, WAIT_POLL_MS)
    })
    await Promise.race([deps.engine.awaitRun(runId), waiting])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
  const trace = traceText(doc, foldRunEvents(deps.runStore.readEvents(runId)))
  return paused ? `${trace}\n${waitingText(deps.runStore.readEvents(runId))}` : trace
}

/** The open question of a paused run, with the execKey `answer` needs. */
function waitingText(events: readonly RunEvent[]): string {
  const last = [...events].reverse().find(event => event.type === 'run.waiting')
  if (last === undefined || last.type !== 'run.waiting') return 'The run is waiting.'
  const choices = last.answer.kind === 'options'
    ? ` Options: ${last.answer.options.map(option => `${option.id}="${option.label}"`).join(', ')}${last.answer.allowOther ? '; free text allowed' : ''}.`
    : ' Answer with {"text"}.'
  return `The run is paused at a question (execKey ${last.execKey}): "${last.question}".${choices} Call answer to continue or cancel to stop.`
}

/** A compact run trace: status, outputs, and per-node inputs/outputs/errors with values truncated. */
function traceText(doc: FlowDocument | undefined, view: RunView): string {
  const title = (id: string): string => doc?.nodes.find(node => node.id === id)?.title ?? id
  const lines = [`Run ${view.runId}: ${view.status} in ${view.durationMs} ms, ${view.usage.inputTokens + view.usage.outputTokens} tokens.`]
  if (view.error !== undefined) lines.push(`Error${view.error.nodeId === undefined ? '' : ` at ${view.error.nodeId} "${title(view.error.nodeId)}"`}: ${view.error.code}: ${view.error.message}`)
  if (view.outputs !== undefined) lines.push(`Outputs: ${clip(view.outputs)}`)
  for (const message of view.messages) lines.push(`Message: ${clip(message.text)}`)
  lines.push('Nodes:')
  for (const node of view.nodes) lines.push(nodeLine(node, title))
  return lines.join('\n')
}

function nodeLine(node: RunViewNode, title: (id: string) => string): string {
  const where = node.path.length === 0 ? '' : ` @${node.path.map(step => `${step.node}${step.index === undefined ? '' : `#${step.index}`}`).join('/')}`
  const parts = [`- ${node.nodeId} "${title(node.nodeId)}"${where}: ${node.status}${node.durationMs === undefined ? '' : ` ${node.durationMs}ms`}`]
  if (node.inputs !== undefined && !isEmpty(node.inputs)) parts.push(`    in: ${clip(node.inputs)}`)
  if (node.outputs !== undefined && !isEmpty(node.outputs)) parts.push(`    out: ${clip(node.outputs)}`)
  if (node.firedPorts !== undefined && node.firedPorts.length > 0) parts.push(`    took: ${node.firedPorts.join(', ')}`)
  if (node.error !== undefined) parts.push(`    error: ${node.error.code}: ${node.error.message}`)
  if (node.warnings !== undefined && node.warnings.length > 0) parts.push(`    warnings: ${node.warnings.join('; ')}`)
  if (node.logs !== undefined && node.logs.length > 0) parts.push(`    logs: ${clip(node.logs.join('\n'))}`)
  return parts.join('\n')
}

function isEmpty(value: JsonValue): boolean {
  return value === null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
}

function clip(value: JsonValue): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > TRACE_VALUE_CHARS ? `${text.slice(0, TRACE_VALUE_CHARS)}…[${text.length - TRACE_VALUE_CHARS} more chars]` : text
}
