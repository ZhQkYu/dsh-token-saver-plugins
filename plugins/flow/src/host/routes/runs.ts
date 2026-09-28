/**
 * Run routes: list, get (summary + persisted events), and the run lifecycle
 * (start/events/cancel/answer/debug), which delegates to a {@link RunController}.
 * Start failures are typed: validation issues, input errors, and missing
 * flows or workspaces each map to their own status and body.
 *
 * @module @dsh-plugins/flow/host/routes/runs
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { FlowDocument, JsonValue } from '../../spec/types.ts'
import { ID_PATTERN, ROUTES } from '../../spec/types.ts'
import { nodeDebugSchema, runAnswerSchema, runCancelSchema, runStartSchema } from '../schemas.ts'
import { json, readJsonBody, textError, RequestBodyError } from '../http.ts'
import type { RunStore } from '../store/run-store.ts'
import { FlowValidationError } from '../engine/compile.ts'
import { InputValidationError, RunStartError } from '../engine/engine.ts'

/** The run lifecycle the routes delegate to; the engine implements this. */
export interface RunController {
  start(request: { flowId: string; version: number | 'draft'; inputs: JsonValue; workspaceId: string }): Promise<{ runId: string }>
  hasRun(runId: string): boolean
  cancel(runId: string): Promise<boolean>
  answer(runId: string, execKey: string, answer: { text?: string; optionId?: string }): Promise<'ok' | 'not-waiting' | 'invalid'>
  eventsStream(runId: string, after: number, signal: AbortSignal): ReadableStream<Uint8Array>
  debug(flow: FlowDocument, nodeId: string, inputs: JsonValue, workspaceId: string): Promise<{ runId: string }>
}

/**
 * Map a run-start failure to a response; unexpected errors are logged and answered generically.
 * @param ctx - the plugin context, for logging.
 * @param error - the thrown value.
 * @returns the error response.
 */
export function runStartErrorResponse(ctx: Context, error: unknown): Response {
  if (error instanceof FlowValidationError) return json({ issues: error.issues }, { status: 400 })
  if (error instanceof InputValidationError) return json({ error: { code: error.code, message: error.message, field: error.field } }, { status: 400 })
  if (error instanceof RunStartError) return json({ error: { code: error.code, message: error.message } }, { status: error.status })
  if (error instanceof RequestBodyError) return textError(error.message, 400)
  ctx.logger.warn(`flow: run start failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  return textError('internal error', 500)
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
      return Promise.resolve(json({ summary, events: store.readEvents(runId) }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.runStart,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, runStartSchema)
        return json(await controller.start({ flowId: body.flowId, version: body.version, inputs: body.inputs, workspaceId: body.workspaceId }))
      } catch (error: unknown) {
        return runStartErrorResponse(ctx, error)
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
        return runStartErrorResponse(ctx, error)
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
        const outcome = await controller.answer(body.runId, body.execKey, body.answer)
        if (outcome === 'not-waiting') return textError('run is not waiting for this question', 409)
        if (outcome === 'invalid') return textError('the answer does not fit the question', 400)
        return json({ ok: true })
      } catch (error: unknown) {
        return runStartErrorResponse(ctx, error)
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
      if (!controller.hasRun(runId)) return Promise.resolve(textError('run not found', 404))
      const stream = controller.eventsStream(runId, Number.isFinite(after) ? after : 0, request.signal)
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.nodeDebug,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, nodeDebugSchema)
        return json(await controller.debug(body.flow, body.nodeId, body.inputs, body.workspaceId))
      } catch (error: unknown) {
        return runStartErrorResponse(ctx, error)
      }
    },
  })
}
