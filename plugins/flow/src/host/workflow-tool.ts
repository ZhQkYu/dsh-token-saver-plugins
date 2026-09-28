/**
 * `flow_workflow`: one fixed tool through which a conversation lists flows,
 * runs a flow in the engine, and follows a guided flow step by step. Its
 * definition never changes as flows are added, so the tool list (and the
 * prompt cache) stays stable; publishing a flow as its own `flow_<name>` tool
 * remains optional.
 *
 * @module @dsh-plugins/flow/host/workflow-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '../spec/types.ts'
import { FLOW_WORKFLOW_TOOL, flowInterface } from '../spec/guided.ts'
import { describeVarSchema } from '../spec/var-schema.ts'
import type { FlowStore } from './store/flow-store.ts'
import type { FlowEngine } from './engine/engine.ts'
import { GUIDED_REPORT_STATUSES, type GuidedProgress } from './engine/guided-runs.ts'
import { describeFailure } from './flow-tools.ts'

const DESCRIPTION = 'Use the workflows the user built in the Flow editor. '
  + '`list` shows them with their inputs. A flow of kind "flow" runs in the workflow engine: call `run` with flowId and inputs and use the returned outputs. '
  + 'A "guided" workflow is a step list for you to follow: call `start` with flowId and inputs, carry out each step yourself, '
  + 'and call `report` for every step (running, then done/failed/skipped) so the user can follow progress; `status` shows a run\'s progress.'

/** The union of fields the actions return. */
interface WorkflowValue {
  flows?: { id: string; name: string; description: string; kind: string; version: string; inputs: string[] }[]
  runId?: string
  outputs?: JsonValue
  steps?: string
  progress?: GuidedProgress
}

/**
 * Register `flow_workflow`.
 * @param ctx - the plugin context owning the registration.
 * @param flowStore - flow storage, for `list`.
 * @param engine - runs flows and tracks guided runs.
 */
export function registerWorkflowTool(ctx: Context, flowStore: FlowStore, engine: FlowEngine): void {
  ctx.tools.register(defineTool({
    name: FLOW_WORKFLOW_TOOL,
    description: DESCRIPTION,
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'run', 'start', 'report', 'status'], description: 'What to do.' },
      flowId: { type: 'string', description: 'The workflow id (run, start).' },
      inputs: { type: 'json', description: 'The workflow inputs as an object keyed by input name (run, start).' },
      runId: { type: 'string', description: 'The run id (report, status; start: a run prepared for this session).' },
      nodeId: { type: 'string', description: 'The step id shown in brackets in the step list (report).' },
      status: { type: 'string', enum: [...GUIDED_REPORT_STATUSES], description: 'The step status (report).' },
      summary: { type: 'string', description: 'One or two sentences on the step result; for the last step, the final result (report).' },
      branch: { type: 'string', description: 'For a decision step: the chosen branch (report).' },
      outputs: { type: 'json', description: 'For the last step: the result fields as an object (report).' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderValue(value as WorkflowValue) }],
    },
    timeoutMs: engine.timeoutMs(),
    isConcurrencySafe: () => false,
    execute: async (args, exec): Promise<never> => {
      const value = await (async (): Promise<WorkflowValue> => {
        switch (args.action) {
          case 'list':
            return {
              flows: flowStore.list().filter(summary => summary.broken !== true).map((summary) => {
                const doc = summary.publishedVersion === undefined ? flowStore.get(summary.id) : flowStore.version(summary.id, summary.publishedVersion)
                const inputs = doc === undefined ? [] : flowInterface(doc).inputs.map(field => `${field.name}: ${describeVarSchema(field.schema)}${field.required === true ? ' (required)' : ''}`)
                return { id: summary.id, name: summary.name, description: summary.description, kind: summary.kind, version: summary.publishedVersion === undefined ? 'draft' : `v${summary.publishedVersion}`, inputs }
              }),
            }
          case 'run': {
            const flowId = required(args.flowId, 'flowId')
            const { runId } = await engine.start({
              flowId,
              version: flowStore.latestPublishedVersion(flowId) ?? 'draft',
              inputs: args.inputs ?? {},
              ...(exec.agent === undefined ? {} : { caller: { agent: exec.agent, parent: exec.token, rootCallId: exec.rootCallId, callId: exec.callId } }),
              ...(exec.agent?.session.header.cwd === undefined ? {} : { workspacePath: exec.agent.session.header.cwd }),
            })
            const onAbort = (): void => { void engine.cancel(runId) }
            exec.signal.addEventListener('abort', onAbort, { once: true })
            try {
              const summary = await engine.awaitRun(runId)
              if (summary?.status !== 'succeeded') throw new Error(describeFailure(flowStore.get(flowId) ?? { name: flowId, nodes: [] }, summary))
              return { runId, outputs: summary.outputs ?? {} }
            } finally {
              exec.signal.removeEventListener('abort', onAbort)
            }
          }
          case 'start': {
            const started = engine.startGuided({
              flowId: required(args.flowId, 'flowId'),
              version: 'published',
              inputs: args.inputs ?? {},
              ...(args.runId === undefined ? {} : { runId: args.runId }),
              ...(exec.agent === undefined ? {} : { sessionId: exec.agent.session.id }),
              ...(exec.agent?.session.header.cwd === undefined ? {} : { workspacePath: exec.agent.session.header.cwd }),
            })
            return { runId: started.runId, steps: started.prompt }
          }
          case 'report': {
            const runId = required(args.runId, 'runId')
            const progress = engine.reportGuided(runId, required(args.nodeId, 'nodeId'), required(args.status, 'status'), args.summary, args.branch, args.outputs)
            return { runId, progress }
          }
          case 'status': {
            const runId = required(args.runId, 'runId')
            const progress = engine.guidedProgress(runId)
            if (progress === undefined) throw new Error(`unknown run ${JSON.stringify(runId)}`)
            return { runId, progress }
          }
        }
      })()
      return value as never
    },
  }))
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') throw new Error(`${FLOW_WORKFLOW_TOOL}: ${name} is required for this action`)
  return value
}

/** Render a tool result as model text. */
function renderValue(value: WorkflowValue): string {
  if (value.flows !== undefined) {
    if (value.flows.length === 0) return 'No workflows are defined.'
    return `Workflows:\n${value.flows.map(flow => `- ${flow.id}: ${flow.name} [${flow.kind}, ${flow.version}]${flow.description === '' ? '' : ` — ${flow.description}`}\n  inputs: ${flow.inputs.length === 0 ? 'none' : flow.inputs.join(', ')}`).join('\n')}`
  }
  if (value.steps !== undefined) return `Started guided run ${value.runId ?? ''}.\n\n${value.steps}`
  if (value.progress !== undefined) {
    const progress = value.progress
    const lines = Object.entries(progress.steps).map(([id, step]) => `- ${id}: ${step.status}${step.summary === undefined ? '' : ` — ${step.summary}`}`)
    return `Run ${progress.runId} is ${progress.status}: ${progress.done}/${progress.total} steps finished; pending: ${progress.pending.length === 0 ? 'none' : progress.pending.join(', ')}\n${lines.join('\n')}`
  }
  return `Run ${value.runId ?? ''} succeeded:\n${JSON.stringify(value.outputs ?? {}, null, 2)}`
}
