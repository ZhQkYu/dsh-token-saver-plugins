/**
 * Browser calls to the flow Connection routes. Paths are document-relative
 * (no leading slash) so they resolve under the app's own mount. Non-2xx
 * responses reject with an {@link ApiError} carrying the Host's validation
 * issues or typed error when the body has them.
 *
 * @module @dsh-plugins/flow-ui/client/api
 */

import type { FlowDocument, FlowKind, FlowLookupResult, Issue, JsonValue, RunEvent, RunSummary, ValidateLimits, VarField } from '@dsh-plugins/flow/spec'

/** One flow row in the list. */
export interface FlowSummary {
  id: string
  name: string
  description: string
  kind: FlowKind
  updatedAt: number
  publishedVersion?: number
  toolName?: string
  nodeCount: number
  broken?: boolean
  reason?: string
}

/** A flow's publish metadata. */
export interface FlowMeta {
  publishedVersion?: number
  tool?: { enabled: boolean; name: string; description: string }
}

/** One catalog entry for subflow pickers and local validation. */
export interface CatalogFlow {
  id: string
  name: string
  kind: FlowKind
  published?: FlowLookupResult & { version: number }
  draft: FlowLookupResult
}

/** One workspace the Host knows. */
export interface WorkspaceSummary {
  id: string
  title: string
  path: string
}

/** One tool the Host exposes to flows. */
export interface ToolSummary {
  name: string
  description: string
  parameters: unknown
  /** JSON Schema of the tool's structured `value`, or null when undeclared. */
  output?: unknown
}

/** The models the Host can call, by provider. */
export interface ModelCatalog {
  default: { provider: string; model: string }
  groups: { id: string; name: string; models: { id: string; name: string }[] }[]
}

/** A rejected request, with the Host's structured body when present. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly issues?: Issue[], readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (response.ok) return await response.json() as T
  const text = await response.text()
  let body: { issues?: Issue[]; error?: { code?: string; message?: string } } | undefined
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    body = undefined
  }
  const message = body?.error?.message ?? (body?.issues !== undefined ? body.issues.map(issue => issue.message).join('; ') : text) ?? `HTTP ${response.status}`
  throw new ApiError(response.status, message || `HTTP ${response.status}`, body?.issues, body?.error?.code)
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

/** The flow Host API. */
export const api = {
  flows: () => request<{ flows: FlowSummary[] }>('api/dsh-flow/flows').then(res => res.flows),
  get: (id: string) => request<{ flow: FlowDocument; meta: FlowMeta | null }>(`api/dsh-flow/flow?id=${encodeURIComponent(id)}`),
  create: (name: string, description: string, kind: FlowKind) => post<{ flow: FlowDocument }>('api/dsh-flow/flow.create', { name, description, kind }).then(res => res.flow),
  save: (flow: FlowDocument, baseRevision: number) => post<{ flow: FlowDocument }>('api/dsh-flow/flow.save', { flow, baseRevision }).then(res => res.flow),
  remove: (id: string) => post<{ ok: true }>('api/dsh-flow/flow.delete', { id }),
  duplicate: (id: string) => post<{ flow: FlowDocument }>('api/dsh-flow/flow.duplicate', { id }).then(res => res.flow),
  publish: (id: string, baseRevision: number, note: string, tool: { enabled: boolean; name: string; description?: string } | undefined) =>
    post<{ meta: FlowMeta }>('api/dsh-flow/flow.publish', { id, baseRevision, note, ...(tool === undefined ? {} : { tool }) }).then(res => res.meta),
  startRun: (flowId: string, inputs: JsonValue, workspaceId: string) =>
    post<{ runId: string; sessionId?: string }>('api/dsh-flow/run.start', { flowId, version: 'draft', inputs, workspaceId }),
  cancelRun: (runId: string) => post<{ ok: true }>('api/dsh-flow/run.cancel', { runId }),
  debugNode: (flow: FlowDocument, nodeId: string, inputs: JsonValue, workspaceId: string) => post<{ runId: string }>('api/dsh-flow/node.debug', { flow, nodeId, inputs, workspaceId }),
  answer: (runId: string, execKey: string, answer: { text?: string; optionId?: string }) => post<{ ok: true }>('api/dsh-flow/run.answer', { runId, execKey, answer }),
  getRun: (runId: string) => request<{ summary: RunSummary; events: RunEvent[] }>(`api/dsh-flow/run.get?runId=${encodeURIComponent(runId)}`),
  workspaces: () => request<{ workspaces: WorkspaceSummary[] }>('api/dsh-flow/catalog.workspaces').then(res => res.workspaces),
  catalogFlows: () => request<{ flows: CatalogFlow[] }>('api/dsh-flow/catalog.flows').then(res => res.flows),
  limits: () => request<{ limits: ValidateLimits }>('api/dsh-flow/catalog.limits').then(res => res.limits),
  tools: () => request<{ tools: ToolSummary[] }>('api/dsh-flow/catalog.tools').then(res => res.tools),
  models: () => request<ModelCatalog>('api/dsh-flow/catalog.models'),
}

/** Error text for display. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The start fields of a flow, for the run inputs form. */
export function startFieldsOf(flow: FlowDocument): (VarField & { default?: JsonValue })[] {
  const start = flow.nodes.find(node => node.type === 'start')
  return start?.type === 'start' ? start.data.fields : []
}
