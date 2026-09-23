/**
 * workflow-canvas: a visual node workflow the model reads and executes. The
 * canvas is a method description for the AI; the model executes steps with
 * existing tools and reports status. Host side wires the store, routes, and the
 * `canvas_workflow` tool.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-workspace'
import { ROUTES, CanvasGraph, CanvasRun, NodeStatus, CompiledStep } from '../protocol.ts'
import { CanvasStore } from './store.ts'
import { compileGraph } from './compile.ts'
import { registerCanvasRoutes } from './routes.ts'

export const name = 'token-saver-workflow-canvas'
export const inject = ['tools', 'systemPrompt', 'connection', 'workspaceRegistry']

/** Workflow-canvas configuration. */
export interface Config {
  /** Storage directory; defaults to the DSH home token-saver canvas dir. */
  storageDir?: string
  /** Maximum serialized graph size in bytes. */
  maxGraphBytes: number
  /** Runs kept per graph. */
  keepRuns: number
}

/** Schemastery configuration for the workflow-canvas row. */
export const Config: z<Config> = z.object({
  storageDir: z.string(),
  maxGraphBytes: z.natural().min(1).default(262144),
  keepRuns: z.natural().min(1).default(20),
})

const CANVAS_DESCRIPTION = 'Work with a visual node workflow (canvas) that a user defined. '
  + 'Use `list` to see available workflows. Use `start` to begin one, then execute each '
  + 'step in order, reporting `running`/`done`/`failed` for each node via `report`. Use '
  + '`status` to see progress.'

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
  registerCanvasRoutes(ctx, store, { maxGraphBytes: config.maxGraphBytes })

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
      graphId: { type: 'string', description: 'The workflow id (list/start).' },
      runId: { type: 'string', description: 'The run id (report/status).' },
      nodeId: { type: 'string', description: 'The node id (report).' },
      status: {
        type: 'string',
        enum: ['pending', 'running', 'done', 'failed', 'skipped'],
        description: 'The node status (report).',
      },
      summary: { type: 'string', description: 'A short result summary (report).' },
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
                hint: { type: 'string', required: true },
              },
            },
          },
          done: { type: 'integer' },
          total: { type: 'integer' },
          next: { type: 'array', items: { type: 'string' } },
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
        const { steps } = compileGraph(graph)
        const runId = `run-${randomUUID().slice(0, 12)}`
        const now = Date.now()
        const nodes: CanvasRun['nodes'] = {}
        for (const step of steps) nodes[step.nodeId] = { status: 'pending' as NodeStatus, updatedAt: now }
        const run: CanvasRun = {
          runId,
          graphId: graph.id,
          ...(exec.agent === undefined ? {} : { sessionId: exec.agent.session.id }),
          startedAt: now,
          updatedAt: now,
          nodes,
        }
        await store.saveRun(run)
        return { runId, steps: steps.map(step => ({ nodeId: step.nodeId, kind: step.kind, title: step.title, instruction: step.instruction, hint: step.hint })) }
      }
      if (args.action === 'report') {
        if (args.runId === undefined || args.nodeId === undefined || args.status === undefined) {
          throw new Error('canvas_workflow report requires runId, nodeId, and status')
        }
        const run = store.getRun(args.runId)
        if (run === undefined) throw new Error(`canvas_workflow: unknown run ${JSON.stringify(args.runId)}`)
        const node = run.nodes[args.nodeId]
        if (node === undefined) throw new Error(`canvas_workflow: unknown node ${JSON.stringify(args.nodeId)} in run ${args.runId}`)
        const summary = args.summary?.trim()
        run.nodes[args.nodeId] = {
          status: args.status as NodeStatus,
          ...(summary === undefined || summary === '' ? {} : { summary }),
          updatedAt: Date.now(),
        }
        run.updatedAt = Date.now()
        await store.saveRun(run)
        const entries = Object.entries(run.nodes)
        const done = entries.filter(([, value]) => value.status === 'done' || value.status === 'failed').length
        const next = entries.filter(([, value]) => value.status === 'pending').map(([id]) => id)
        return { done, total: entries.length, next }
      }
      if (args.action === 'status') {
        if (args.runId === undefined) throw new Error('canvas_workflow status requires runId')
        const run = store.getRun(args.runId)
        if (run === undefined) throw new Error(`canvas_workflow: unknown run ${JSON.stringify(args.runId)}`)
        const nodes: Record<string, string> = {}
        for (const [id, value] of Object.entries(run.nodes)) nodes[id] = value.status
        return { nodes }
      }
      throw new Error(`canvas_workflow: unknown action ${JSON.stringify(args.action)}`)
    },
    isConcurrencySafe: () => false,
  }))

  ctx.systemPrompt.section({
    name: 'token-saver-workflow-canvas',
    order: 1870,
    text: () => 'A user may have defined reusable workflows on a canvas. Use canvas_workflow list/start to execute one, reporting each node as you go.',
  })

  ctx.effect(() => () => {
    // The store holds no handles; nothing to dispose beyond the routes (registered
    // via connection.fetch.register, which is effect-scoped).
  })
}

const nodeKinds = ['input', 'task', 'web-ai', 'subagent', 'tool', 'review', 'output'] as const

/** Validate and parse a saved graph. */
const graphSchema = {
  parse(value: unknown): CanvasGraph {
    const graph = value as CanvasGraph
    if (graph === null || typeof graph !== 'object' || graph.version !== 1) throw new Error('invalid graph: expected version 1')
    if (typeof graph.id !== 'string' || typeof graph.name !== 'string') throw new Error('invalid graph: missing id/name')
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('invalid graph: nodes/edges must be arrays')
    for (const node of graph.nodes) {
      if (typeof node.id !== 'string' || typeof node.kind !== 'string' || !nodeKinds.includes(node.kind as (typeof nodeKinds)[number])) {
        throw new Error('invalid graph: bad node')
      }
    }
    return graph
  },
}

/** Validate and parse a saved run. */
const runSchema = {
  parse(value: unknown): CanvasRun {
    const run = value as CanvasRun
    if (run === null || typeof run !== 'object' || typeof run.runId !== 'string' || typeof run.graphId !== 'string') {
      throw new Error('invalid run: missing runId/graphId')
    }
    if (run.nodes === null || typeof run.nodes !== 'object') throw new Error('invalid run: nodes must be an object')
    return run
  },
}

/** Render a canvas tool result to model text. */
function renderCanvas(value: Record<string, unknown>): string {
  if (Array.isArray(value.graphs)) {
    const graphs = value.graphs as { id: string; name: string; description: string; nodeCount: number }[]
    return `Canvas workflows:\n${graphs.map(graph => `- ${graph.id}: ${graph.name} (${graph.nodeCount} nodes) — ${graph.description}`).join('\n')}`
  }
  if (Array.isArray(value.steps)) {
    const steps = value.steps as { nodeId: string; kind: string; title: string; instruction: string; hint: string }[]
    const numbered = steps.map((step, index) => `${index + 1}. [${step.kind}] ${step.title} — ${step.hint}`)
    return `Started run ${String(value.runId ?? '')}. Execute steps in order; report each node running/done/failed with a short summary:\n${numbered.join('\n')}`
  }
  if (value.nodes !== undefined && typeof value.nodes === 'object') {
    const nodes = value.nodes as Record<string, string>
    return `Run ${String(value.runId ?? '')} status: ${Object.entries(nodes).map(([id, status]) => `${id}=${status}`).join(', ')}`
  }
  return `Progress: ${String(value.done ?? 0)}/${String(value.total ?? 0)} done; next: ${Array.isArray(value.next) ? value.next.join(', ') : ''}`
}

export type { CompiledStep }
export { ROUTES }
