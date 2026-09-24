/**
 * workflow-canvas: a visual node workflow with two engines. Guided graphs are a
 * method description the model reads and executes with existing tools,
 * reporting status through `canvas_workflow`. Strict graphs run in the
 * workflow engine, which controls the flow and uses a model per step. Host
 * side wires the store, routes, the strict runner, and the tool.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-workflow'
import { NODE_STATUSES, type CanvasRun } from '../protocol.ts'
import { CanvasStore } from './store.ts'
import { compileGraph, formatSteps } from './compile.ts'
import { registerCanvasRoutes } from './routes.ts'
import { graphSchema, MAX_LOOP_ITERATIONS, MAX_SUMMARY_CHARS, runSchema } from './schema.ts'
import { StrictRunner } from './strict-runner.ts'
import { LAUNCH_SESSION_SERVICES } from '../shared/session-launch.ts'

export const name = 'token-saver-workflow-canvas'
export const inject = ['tools', 'systemPrompt', 'connection', ...LAUNCH_SESSION_SERVICES]

/** Workflow-canvas configuration. */
export interface Config {
  /** Storage directory; defaults to the DSH home token-saver canvas dir. */
  storageDir?: string
  /** Maximum serialized graph size in bytes. */
  maxGraphBytes: number
  /** Runs kept per graph. */
  keepRuns: number
  /** Agent preset of strict-run Sessions; it must compose a workflow engine. Absent uses the deployment default. */
  strictAgentPreset?: string
  /** Child-agent ceiling for one strict run; must not exceed the engine's own ceiling. */
  maxAgentsPerRun: number
  /** Longest chain of loop and subflow references a strict run may nest. */
  maxNestingDepth: number
  /** Highest round limit a loop node may set. */
  maxLoopIterations: number
  /** Longest step output a strict run passes to downstream steps, in characters. */
  maxStepOutputChars: number
}

/** Schemastery configuration for the workflow-canvas row. */
export const Config: z<Config> = z.object({
  storageDir: z.string(),
  maxGraphBytes: z.natural().min(1).default(262144),
  keepRuns: z.natural().min(1).default(20),
  strictAgentPreset: z.string(),
  maxAgentsPerRun: z.natural().min(1).default(200),
  maxNestingDepth: z.natural().min(1).default(4),
  maxLoopIterations: z.natural().min(1).max(MAX_LOOP_ITERATIONS).default(20),
  maxStepOutputChars: z.natural().min(200).default(6000),
})

const CANVAS_DESCRIPTION = 'Work with a visual node workflow (canvas) that a user defined. '
  + 'Use `list` to see available workflows. Use `start` to begin one, then execute each '
  + 'step in order, reporting `running`/`done`/`failed` for each node via `report`. Use '
  + '`status` to see progress.'

/** One step as the tool returns it. */
interface StepValue {
  nodeId: string
  kind: string
  title: string
  instruction: string
  dependsOn: string[]
  hint: string
}

/** The union of fields the four actions return. */
interface CanvasValue {
  graphs?: { id: string; name: string; description: string; nodeCount: number }[]
  runId?: string
  steps?: StepValue[]
  done?: number
  total?: number
  next?: string[]
  nodes?: Record<string, unknown>
}

/**
 * Apply the workflow-canvas plugin.
 * @param ctx - registrant context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const storageDir = config.storageDir ?? dshHomePath('token-saver', 'canvas')
  const store = new CanvasStore(
    { storageDir, maxGraphBytes: config.maxGraphBytes, keepRuns: config.keepRuns },
    graphSchema,
    runSchema,
  )
  const limits = { maxDepth: config.maxNestingDepth, maxLoopIterations: config.maxLoopIterations, maxOutputChars: config.maxStepOutputChars }
  const runner = new StrictRunner(ctx, store, {
    agentPreset: config.strictAgentPreset,
    maxAgentsPerRun: config.maxAgentsPerRun,
    limits,
  })
  registerCanvasRoutes(ctx, store, { maxGraphBytes: config.maxGraphBytes, runner, limits })

  ctx.tools.register(defineTool({
    name: 'canvas_workflow',
    description: CANVAS_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'start', 'report', 'status'],
        description: 'What to do with the workflow.',
      },
      graphId: { type: 'string', description: 'The workflow id (start).' },
      runId: { type: 'string', description: 'The run id (report/status).' },
      nodeId: { type: 'string', description: 'The node id (report).' },
      status: {
        type: 'string',
        enum: [...NODE_STATUSES],
        description: 'The node status (report).',
      },
      summary: { type: 'string', description: `A short result summary, at most ${MAX_SUMMARY_CHARS} characters (report).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          graphs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                nodeCount: { type: 'integer', required: true },
              },
            },
          },
          runId: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                nodeId: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                title: { type: 'string', required: true },
                instruction: { type: 'string', required: true },
                dependsOn: { type: 'array', required: true, items: { type: 'string' } },
                hint: { type: 'string', required: true },
              },
            },
          },
          done: { type: 'integer' },
          total: { type: 'integer' },
          next: { type: 'array', items: { type: 'string' } },
          // Keyed by node id; each value is `{ status, summary? }`.
          nodes: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCanvas(value) }],
    },
    execute: async (args, exec) => {
      if (args.action === 'list') {
        return { graphs: store.list().map(graph => ({ id: graph.id, name: graph.name, description: graph.description, nodeCount: graph.nodes.length })) }
      }
      if (args.action === 'start') {
        if (args.graphId === undefined) throw new Error('canvas_workflow start requires graphId')
        const graph = store.get(args.graphId)
        if (graph === undefined) throw new Error(`canvas_workflow: unknown graph ${JSON.stringify(args.graphId)}`)
        const { steps } = compileGraph(graph, undefined, undefined, id => store.get(id)?.name)
        const now = Date.now()
        const run: CanvasRun = {
          runId: `run-${randomUUID()}`,
          graphId: graph.id,
          ...(exec.agent === undefined ? {} : { sessionId: exec.agent.session.id }),
          startedAt: now,
          updatedAt: now,
          nodes: Object.fromEntries(steps.map(step => [step.nodeId, { status: 'pending' as const, updatedAt: now }])),
        }
        await store.saveRun(run)
        return {
          runId: run.runId,
          steps: steps.map(step => ({ nodeId: step.nodeId, kind: step.kind, title: step.title, instruction: step.instruction, dependsOn: step.dependsOn, hint: step.hint })),
        }
      }
      if (args.action === 'report') {
        const { runId, nodeId, status } = args
        if (runId === undefined || nodeId === undefined || status === undefined) {
          throw new Error('canvas_workflow report requires runId, nodeId, and status')
        }
        const summary = args.summary?.trim() ?? ''
        if (summary.length > MAX_SUMMARY_CHARS) throw new Error(`canvas_workflow summary exceeds ${MAX_SUMMARY_CHARS} characters`)
        const run = await store.updateRun(runId, (current) => {
          if (current.nodes[nodeId] === undefined) throw new Error(`canvas_workflow: unknown node ${JSON.stringify(nodeId)} in run ${runId}`)
          const now = Date.now()
          return {
            ...current,
            updatedAt: now,
            nodes: { ...current.nodes, [nodeId]: { status, ...(summary === '' ? {} : { summary }), updatedAt: now } },
          }
        })
        const entries = Object.entries(run.nodes)
        return {
          runId,
          done: entries.filter(([, node]) => node.status !== 'pending' && node.status !== 'running').length,
          total: entries.length,
          next: entries.filter(([, node]) => node.status === 'pending').map(([id]) => id),
        }
      }
      if (args.runId === undefined) throw new Error('canvas_workflow status requires runId')
      const run = store.getRun(args.runId)
      if (run === undefined) throw new Error(`canvas_workflow: unknown run ${JSON.stringify(args.runId)}`)
      const nodes: Record<string, { status: string; summary?: string }> = {}
      for (const [id, node] of Object.entries(run.nodes)) {
        nodes[id] = { status: node.status, ...(node.summary === undefined ? {} : { summary: node.summary }) }
      }
      return { runId: run.runId, nodes }
    },
    isConcurrencySafe: () => false,
  }))

  ctx.systemPrompt.section({
    name: 'token-saver-workflow-canvas',
    order: 1870,
    text: 'A user may have defined reusable workflows on a canvas. Use canvas_workflow list/start to execute one, reporting each node as you go.',
  })
}

/** Render a canvas tool result to model text. */
function renderCanvas(value: CanvasValue): string {
  if (value.graphs !== undefined) {
    if (value.graphs.length === 0) return 'No canvas workflows are defined.'
    return `Canvas workflows:\n${value.graphs.map(graph => `- ${graph.id}: ${graph.name} (${graph.nodeCount} nodes)${graph.description === '' ? '' : ` — ${graph.description}`}`).join('\n')}`
  }
  if (value.steps !== undefined) {
    return `Started run ${value.runId ?? ''}. Execute the steps in order; start a step only after the steps it depends on. `
      + `Report each node with canvas_workflow report (running when you begin, done or failed with a one- or two-sentence summary when you finish):\n${formatSteps(value.steps)}`
  }
  if (value.nodes !== undefined) {
    const lines = Object.entries(value.nodes).map(([id, node]) => {
      const status = typeof node === 'object' && node !== null && 'status' in node && typeof node.status === 'string' ? node.status : 'unknown'
      const summary = typeof node === 'object' && node !== null && 'summary' in node && typeof node.summary === 'string' ? ` — ${node.summary}` : ''
      return `- ${id}: ${status}${summary}`
    })
    return `Run ${value.runId ?? ''} status:\n${lines.join('\n')}`
  }
  const next = value.next ?? []
  return `Run ${value.runId ?? ''}: ${value.done ?? 0}/${value.total ?? 0} nodes finished; pending: ${next.length === 0 ? 'none' : next.join(', ')}`
}
