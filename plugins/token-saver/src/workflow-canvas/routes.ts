/**
 * Connection-fetch routes for the workflow-canvas: list/save/delete graphs, list
 * runs, and start a run in a new session. All routes go through the Connection
 * authentication fence; inputs are validated and bounded.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import { ROUTES, CanvasGraph, ID_PATTERN } from '../protocol.ts'
import { CanvasStore } from './store.ts'
import { compileGraph } from './compile.ts'
import { json, readJsonBody, textError } from '../shared/http.ts'
import { launchSession } from '../shared/session-launch.ts'
import { tokenSaverSource } from '../shared/message-source.ts'
import { boundContextSummary } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-title'

const nodeKinds = ['input', 'task', 'web-ai', 'subagent', 'tool', 'review', 'output'] as const

/** Structural graph validator for the save route. */
const graphValidator = {
  parse(value: unknown): CanvasGraph {
    const graph = value as CanvasGraph
    if (graph === null || typeof graph !== 'object' || graph.version !== 1) throw new Error('invalid graph: expected version 1')
    if (typeof graph.id !== 'string' || !ID_PATTERN.test(graph.id)) throw new Error('invalid graph: bad id')
    if (typeof graph.name !== 'string' || typeof graph.description !== 'string') throw new Error('invalid graph: missing name/description')
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('invalid graph: nodes/edges must be arrays')
    for (const node of graph.nodes) {
      if (typeof node.id !== 'string' || typeof node.kind !== 'string' || !nodeKinds.includes(node.kind as (typeof nodeKinds)[number])) {
        throw new Error('invalid graph: bad node')
      }
    }
    return graph
  },
}

/** Structural validator for a graph id + workspace id run request. */
const runRequestValidator = {
  parse(value: unknown): { graphId: string; workspaceId: string } {
    const record = value as Record<string, unknown>
    if (typeof record['graphId'] !== 'string' || !ID_PATTERN.test(record['graphId'])) throw new Error('invalid graphId')
    if (typeof record['workspaceId'] !== 'string' || !ID_PATTERN.test(record['workspaceId'])) throw new Error('invalid workspaceId')
    return { graphId: record['graphId'], workspaceId: record['workspaceId'] }
  },
}

/** Register the canvas routes. */
export function registerCanvasRoutes(ctx: Context, store: CanvasStore, options: { maxGraphBytes: number }): void {
  ctx.connection.fetch.register({
    path: ROUTES.graphs,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({ graphs: store.list().map(graph => ({ id: graph.id, name: graph.name, description: graph.description, nodeCount: graph.nodes.length })) })),
  })

  ctx.connection.fetch.register({
    path: ROUTES.graph,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'POST') {
        try {
          const body = await readJsonBody(request, graphValidator, options.maxGraphBytes)
          compileGraph(body)
          await store.save(body)
          return json({ ok: true })
        } catch (error: unknown) {
          return textError(error instanceof Error ? error.message : 'invalid graph', 400)
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
        const body = await readJsonBody(request, zod.object({ id: zod.string().regex(ID_PATTERN) }))
        store.delete(body.id)
        return json({ ok: true })
      } catch (error: unknown) {
        return textError(error instanceof Error ? error.message : 'invalid request', 400)
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
      try {
        const body = await readJsonBody(request, runRequestValidator)
        const graph = store.get(body.graphId)
        if (graph === undefined) return textError('graph not found', 404)
        const workspace = ctx.workspaceRegistry.get(brandString<WorkspaceId>(body.workspaceId))
        if (workspace === undefined) return textError('workspace not found', 404)
        compileGraph(graph)
        const prompt = `Run the canvas workflow "${graph.name}" (graphId=${graph.id}) with canvas_workflow start, then execute every step in order.`
        const sessionId = await launchSession(ctx, {
          cwd: workspace.path,
          title: graph.name,
          prompt,
          source: tokenSaverSource('canvas-run', boundContextSummary(`Run canvas workflow ${graph.name}`)),
        })
        return json({ sessionId })
      } catch (error: unknown) {
        return textError(error instanceof Error ? error.message : 'invalid request', 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.workspaces,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({ workspaces: ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.path })) })),
  })
}
