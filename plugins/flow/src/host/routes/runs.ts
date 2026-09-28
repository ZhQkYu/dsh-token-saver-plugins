/**
 * Run routes: list, get (with folded events), and the run lifecycle. The
 * lifecycle handlers (start/events/cancel/answer/debug) delegate to a
 * {@link RunController} provided by the plugin entry; until the engine is
 * wired, they respond 501.
 *
 * @module @dsh-plugins/flow/host/routes/runs
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { FlowDocument, JsonValue, RunEvent } from '../../spec/types.ts'
import { ID_PATTERN, ROUTES } from '../../spec/types.ts'
import { foldRunEvents } from '../../spec/run-view.ts'
import { nodeDebugSchema, runAnswerSchema, runCancelSchema, runStartSchema } from '../schemas.ts'
import { errorResponse, json, readJsonBody, textError } from '../http.ts'
import type { RunStore } from '../store/run-store.ts'

/** The run lifecycle the routes delegate to; the engine implements this. */
export interface RunController {
  start(request: { flowId: string; version: number | 'draft'; inputs: JsonValue; workspaceId?: string }): Promise<{ runId: string }>
  cancel(runId: string): Promise<boolean>
  answer(runId: string, execKey: string, answer: { text?: string; optionId?: string }): Promise<boolean>
  eventsStream(runId: string, after: number, signal: AbortSignal): ReadableStream<Uint8Array>
  debug(flow: FlowDocument, nodeId: string, inputs: JsonValue, workspaceId?: string): Promise<{ runId: string }>
}

/** Register the run routes. */
export function registerRunRoutes(ctx: Context, store: RunStore, controller: RunController): void {
  ctx.connection.fetch.register({
    path: ROUTES.runs,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const flowId = new URL(request.url).searchParams.get('flowId') ?? ''
      if (!ID_PATTERN.test(flowId)) return Promise.resolve(textError('invalid flow id', 400))
      return Promise.resolve(json({ runs: store.list(flowId) }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.runGet,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const runId = new URL(request.url).searchParams.get('runId') ?? ''
      if (!ID_PATTERN.test(runId)) return Promise.resolve(textError('invalid run id', 400))
      const summary = store.get(runId)
      if (summary === undefined) return Promise.resolve(textError('run not found', 404))
      const events = store.readEvents(runId)
      return Promise.resolve(json({ summary, events }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.runStart,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, runStartSchema)
        return json(await controller.start({ flowId: body.flowId, version: body.version, inputs: body.inputs as JsonValue, workspaceId: body.workspaceId }))
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.runCancel,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, runCancelSchema)
        if (!await controller.cancel(body.runId)) return textError('run is not active', 404)
        return json({ ok: true })
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.runAnswer,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, runAnswerSchema)
        if (!await controller.answer(body.runId, body.execKey, body.answer)) return textError('run is not waiting', 409)
        return json({ ok: true })
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.runEvents,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const url = new URL(request.url)
      const runId = url.searchParams.get('runId') ?? ''
      const after = Number(url.searchParams.get('after') ?? '0')
      if (!ID_PATTERN.test(runId)) return Promise.resolve(textError('invalid run id', 400))
      const stream = controller.eventsStream(runId, Number.isFinite(after) ? after : 0, request.signal)
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.nodeDebug,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, nodeDebugSchema)
        return json(await controller.debug(body.flow, body.nodeId, body.inputs as JsonValue, body.workspaceId))
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
    },
  })
}

/** Fold persisted events for the `run.get` fallback. */
export function foldStoredEvents(events: readonly RunEvent[]): ReturnType<typeof foldRunEvents> {
  return foldRunEvents(events)
}
