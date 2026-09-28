/**
 * Connection-fetch routes for flow CRUD, validation, publishing, export, and
 * import. All routes go through the Connection authentication fence; inputs
 * are validated and bounded.
 *
 * @module @dsh-plugins/flow/host/routes/flows
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { FlowDocument } from '../../spec/types.ts'
import { ID_PATTERN, ROUTES } from '../../spec/types.ts'
import { validateFlow, type ValidateLimits } from '../../spec/validate.ts'
import { RevisionConflictError, type FlowStore } from '../store/flow-store.ts'
import { createFlowSchema, duplicateFlowSchema, flowDocumentSchema, idRequestSchema, publishFlowSchema, saveFlowSchema } from '../schemas.ts'
import { errorResponse, json, readJsonBody, textError } from '../http.ts'

/** What the flow routes need besides the store. */
export interface FlowRouteOptions {
  maxFlowBytes: number
  /** Validation limits, read per request so the tool catalog is current. */
  limits: () => ValidateLimits
  /** Whether a flow may publish under a tool name. */
  isToolNameAvailable?: (flowId: string, name: string) => boolean
  /** Called before a flow is deleted so its live runs can be cancelled. */
  beforeDelete?: (flowId: string) => Promise<void>
  /** Called after a flow is published so the flow-as-tool registry can sync. */
  onPublished?: (flowId: string) => void
  /** Called after a flow is deleted so the flow-as-tool registry can unregister it. */
  onDeleted?: (flowId: string) => void
}

/** Register the flow CRUD routes. */
export function registerFlowRoutes(ctx: Context, store: FlowStore, options: FlowRouteOptions): void {
  ctx.connection.fetch.register({
    path: ROUTES.flows,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(json({ flows: store.list() })),
  })

  ctx.connection.fetch.register({
    path: ROUTES.flow,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const id = new URL(request.url).searchParams.get('id') ?? ''
      if (!ID_PATTERN.test(id)) return Promise.resolve(textError('invalid flow id', 400))
      const flow = store.get(id)
      if (flow === undefined) return Promise.resolve(textError('flow not found', 404))
      return Promise.resolve(json({ flow, meta: store.getMeta(id) ?? null }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.flowCreate,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, createFlowSchema, options.maxFlowBytes)
        const flow = store.create(body.name, body.description ?? '')
        return json({ flow })
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.flowSave,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, saveFlowSchema, options.maxFlowBytes)
        const flow = await store.save(body.flow, body.baseRevision)
        return json({ flow })
      } catch (error: unknown) {
        if (error instanceof RevisionConflictError) return errorResponse(error, 409)
        return errorResponse(error, 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.flowDelete,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, idRequestSchema)
        await options.beforeDelete?.(body.id)
        store.delete(body.id)
        options.onDeleted?.(body.id)
        return json({ ok: true })
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.flowDuplicate,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, duplicateFlowSchema)
        const flow = store.duplicate(body.id)
        return json({ flow })
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.flowValidate,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, flowDocumentSchema, options.maxFlowBytes)
        const issues = validateFlow(body, store.lookup, options.limits())
        return json({ issues })
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.flowPublish,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, publishFlowSchema, options.maxFlowBytes)
        const draft = store.get(body.id)
        if (draft === undefined) return textError('flow not found', 404)
        const issues = validateFlow(draft, store.lookup, options.limits())
        if (issues.some(issue => issue.severity === 'error')) return json({ issues }, { status: 400 })
        if (body.tool?.enabled === true && options.isToolNameAvailable?.(body.id, body.tool.name) === false) {
          return json({ error: { code: 'TOOL_NAME_TAKEN', message: `tool name "${body.tool.name}" is already in use` } }, { status: 409 })
        }
        const meta = await store.publish(body.id, body.baseRevision, body.note ?? '', body.tool)
        options.onPublished?.(body.id)
        return json({ meta })
      } catch (error: unknown) {
        if (error instanceof RevisionConflictError) return errorResponse(error, 409)
        return errorResponse(error, 400)
      }
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.flowVersions,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const id = new URL(request.url).searchParams.get('id') ?? ''
      if (!ID_PATTERN.test(id)) return Promise.resolve(textError('invalid flow id', 400))
      return Promise.resolve(json({ versions: store.versions(id) }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.flowVersion,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const url = new URL(request.url)
      const id = url.searchParams.get('id') ?? ''
      const version = Number(url.searchParams.get('version') ?? '')
      if (!ID_PATTERN.test(id) || !Number.isInteger(version)) return Promise.resolve(textError('invalid request', 400))
      const flow = store.version(id, version)
      if (flow === undefined) return Promise.resolve(textError('version not found', 404))
      return Promise.resolve(json({ flow }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.flowExport,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const id = new URL(request.url).searchParams.get('id') ?? ''
      if (!ID_PATTERN.test(id)) return Promise.resolve(textError('invalid flow id', 400))
      const flow = store.get(id)
      if (flow === undefined) return Promise.resolve(textError('flow not found', 404))
      // ASCII fallback name for the content-disposition; the real name goes in
      // the filename* RFC 5987 extension so non-ASCII (e.g. Chinese) names work.
      const encodedName = encodeURIComponent(flow.name)
      const headers = new Headers({ 'content-disposition': `attachment; filename="flow.json"; filename*=UTF-8''${encodedName}.json` })
      return Promise.resolve(new Response(JSON.stringify(flow, null, 2), { headers }))
    },
  })

  ctx.connection.fetch.register({
    path: ROUTES.flowImport,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request, flowDocumentSchema, options.maxFlowBytes)
        const flow = store.import(body as FlowDocument)
        return json({ flow, issues: validateFlow(flow, store.lookup, options.limits()) })
      } catch (error: unknown) {
        return errorResponse(error, 400)
      }
    },
  })
}
