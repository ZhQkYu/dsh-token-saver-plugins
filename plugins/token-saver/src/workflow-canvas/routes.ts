/**
 * Connection-fetch routes for the workflow-canvas: list/save/delete graphs, list
 * runs, and start a run in a new session. All routes go through the Connection
 * authentication fence; inputs are validated and bounded.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-client-connection'
import { ROUTES, ID_PATTERN, type CanvasGraph } from '../protocol.ts'
import type { CanvasStore } from './store.ts'
import { CanvasError, compileGraph } from './compile.ts'
import { listCatalogTools } from './catalog.ts'
import { buildStrictPlan, type PlanLimits } from './plan.ts'
import { cancelRequestSchema, deleteRequestSchema, graphSchema, runRequestSchema } from './schema.ts'
import { StrictRunError, type StrictRunner } from './strict-runner.ts'
import { errorResponse, json, readJsonBody, textError } from '../shared/http.ts'
import { launchSession } from '../shared/session-launch.ts'
import { tokenSaverSource } from '../shared/message-source.ts'

/** What the canvas routes need besides the store. */
export interface CanvasRouteOptions {
  maxGraphBytes: number
  runner: StrictRunner
  limits: PlanLimits
}

/**
 * Reject a graph whose loop or subflow nodes cannot run: strict graphs get the
 * full plan check, guided graphs only need their direct references to exist.
 * @param graph - the graph being saved.
 * @param store - reads the referenced graphs.
 * @param limits - strict-plan limits.
 */
function validateReferences(graph: CanvasGraph, store: CanvasStore, limits: PlanLimits): void {
  const lookup = (id: string): CanvasGraph | undefined => id === graph.id ? graph : store.get(id)
  if (graph.mode === 'strict') {
    buildStrictPlan(graph, lookup, limits, '')
    return
  }
  for (const node of graph.nodes) {
    if (node.config.graphId !== undefined && lookup(node.config.graphId) === undefined) {
      throw new CanvasError('BAD_REFERENCE', `${node.kind} node "${node.title}" references a workflow that does not exist`)
    }
  }
}

/**
 * Register the canvas routes.
 * @param ctx - plugin context owning the route registrations.
 * @param store - graph and run storage.
 * @param options - body limits, the strict runner, and plan limits.
 */
export function registerCanvasRoutes(ctx: Context, store: CanvasStore, options: CanvasRouteOptions): void {
  ctx.connection.fetch.register({
    path: ROUTES.graphs,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({
      graphs: store.list().map(graph => ({ id: graph.id, name: graph.name, description: graph.description, nodeCount: graph.nodes.length, mode: graph.mode ?? 'guided' })),
    })),
  })

  ctx.connection.fetch.register({
    path: ROUTES.graph,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'POST') {
        try {
          const body = await readJsonBody(request, graphSchema, options.maxGraphBytes)
          compileGraph(body, undefined, undefined, id => store.get(id)?.name)
          validateReferences(body, store, options.limits)
          const graph = { ...body, updatedAt: Date.now() }
          await store.save(graph)
          return json({ graph })
        } catch (error: unknown) {
          return errorResponse(error, 400)
        }
      }
      const id = new URL(request.url).searchParams.get('id') ?? ''
      if (!ID_PATTERN.test(id)) return textError('invalid graph id', 400)
      const graph = store.get(id)
      if (graph === undefined) return textError('graph not found', 404)
      return json({ graph })
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.remove,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, deleteRequestSchema)
        store.delete(body.id)
        return json({ ok: true })
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.runs,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const graphId = new URL(request.url).searchParams.get('graphId') ?? ''
      if (!ID_PATTERN.test(graphId)) return Promise.resolve(textError('invalid graph id', 400))
      // A strict run still marked running but not live here was cut off by a restart.
      const runs = store.runsFor(graphId).map(run =>
        run.mode === 'strict' && run.state === 'running' && !options.runner.isLive(run.runId) ? { ...run, state: 'interrupted' as const } : run)
      return Promise.resolve(json({ runs }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.run,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: { graphId: string; workspaceId: string; input?: string | undefined }
      try {
        body = await readJsonBody(request, runRequestSchema)
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
      const graph = store.get(body.graphId)
      if (graph === undefined) return textError('graph not found', 404)
      const workspace = ctx.workspaceRegistry.get(brandString<WorkspaceId>(body.workspaceId))
      if (workspace === undefined) return textError('workspace not found', 404)
      const input = body.input?.trim() ?? ''
      if (graph.mode === 'strict') {
        try {
          return json({ mode: 'strict', ...await options.runner.start(graph, workspace.path, input) })
        } catch (error: unknown) {
          return errorResponse(error, error instanceof CanvasError || error instanceof StrictRunError ? 400 : 500)
        }
      }
      try {
        compileGraph(graph)
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
      try {
        const { sessionId } = await launchSession(ctx, {
          cwd: workspace.path,
          title: graph.name,
          prompt: `Run the canvas workflow "${graph.name}" (graphId=${graph.id}) with canvas_workflow start, then execute every step in order.`
            + (input === '' ? '' : `\n\nWorkflow input:\n${input}`),
          source: tokenSaverSource('canvas-run', boundContextSummary(`Run canvas workflow ${graph.name}`)),
        })
        return json({ mode: 'guided', sessionId })
      } catch (error: unknown) {
        return errorResponse(error, 500)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.cancel,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, cancelRequestSchema)
        if (!options.runner.cancel(body.runId)) return textError('run is not active', 404)
        return json({ ok: true })
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.workspaces,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({
      workspaces: ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.path })),
    })),
  })

  ctx.connection.fetch.register({
    path: ROUTES.tools,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return json({ tools: await listCatalogTools(ctx) })
      } catch (error: unknown) {
        return errorResponse(error, 500)
      }
    },
  })
}
