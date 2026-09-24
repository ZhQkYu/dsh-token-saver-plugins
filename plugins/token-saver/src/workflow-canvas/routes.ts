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
import { ROUTES, ID_PATTERN } from '../protocol.ts'
import type { CanvasStore } from './store.ts'
import { compileGraph } from './compile.ts'
import { deleteRequestSchema, graphSchema, runRequestSchema } from './schema.ts'
import { errorResponse, json, readJsonBody, textError } from '../shared/http.ts'
import { launchSession } from '../shared/session-launch.ts'
import { tokenSaverSource } from '../shared/message-source.ts'

/**
 * Register the canvas routes.
 * @param ctx - plugin context owning the route registrations.
 * @param store - graph and run storage.
 * @param options - body limits.
 */
export function registerCanvasRoutes(ctx: Context, store: CanvasStore, options: { maxGraphBytes: number }): void {
  ctx.connection.fetch.register({
    path: ROUTES.graphs,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({
      graphs: store.list().map(graph => ({ id: graph.id, name: graph.name, description: graph.description, nodeCount: graph.nodes.length })),
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
          compileGraph(body)
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
      return Promise.resolve(json({ runs: store.runsFor(graphId) }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.run,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: { graphId: string; workspaceId: string }
      try {
        body = await readJsonBody(request, runRequestSchema)
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
      const graph = store.get(body.graphId)
      if (graph === undefined) return textError('graph not found', 404)
      const workspace = ctx.workspaceRegistry.get(brandString<WorkspaceId>(body.workspaceId))
      if (workspace === undefined) return textError('workspace not found', 404)
      try {
        compileGraph(graph)
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
      try {
        const sessionId = await launchSession(ctx, {
          cwd: workspace.path,
          title: graph.name,
          prompt: `Run the canvas workflow "${graph.name}" (graphId=${graph.id}) with canvas_workflow start, then execute every step in order.`,
          source: tokenSaverSource('canvas-run', boundContextSummary(`Run canvas workflow ${graph.name}`)),
        })
        return json({ sessionId })
      } catch (error: unknown) {
        return errorResponse(error, 500)
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
}
