/**
 * Browser calls to the flow Connection routes. Paths are document-relative
 * (no leading slash) so they resolve under the app's own mount; non-2xx
 * responses reject with the Host's plain-text reason.
 *
 * @module @dsh-plugins/flow-ui/client/api
 */

/** One flow row in the list. */
export interface FlowSummary {
  id: string
  name: string
  description: string
  updatedAt: number
  publishedVersion?: number
  toolName?: string
  nodeCount: number
  broken?: boolean
  reason?: string
}

/** A flow document. */
export type FlowDocument = import('@dsh-plugins/flow/spec').FlowDocument

/** A validation issue. */
export type Issue = import('@dsh-plugins/flow/spec').Issue

/** A run summary. */
export interface RunSummary {
  runId: string
  flowId: string
  status: string
  inputs: unknown
  outputs?: unknown
  error?: { code: string; message: string; nodeId?: string }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
  return await response.json() as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

export const api = {
  flows: () => request<{ flows: FlowSummary[] }>('api/dsh-flow/flows').then(res => res.flows),
  get: (id: string) => request<{ flow: FlowDocument; meta: { publishedVersion?: number } | null }>(`api/dsh-flow/flow?id=${encodeURIComponent(id)}`),
  create: (name: string, description: string) => post<{ flow: { id: string } }>('api/dsh-flow/flow.create', { name, description }).then(res => res.flow),
  save: (flow: FlowDocument, baseRevision: number) => post<{ flow: FlowDocument }>('api/dsh-flow/flow.save', { flow, baseRevision }).then(res => res.flow),
  remove: (id: string) => post<{ ok: true }>('api/dsh-flow/flow.delete', { id }),
  duplicate: (id: string) => post<{ flow: { id: string } }>('api/dsh-flow/flow.duplicate', { id }).then(res => res.flow),
  validate: (flow: FlowDocument) => post<{ issues: Issue[] }>('api/dsh-flow/flow.validate', flow).then(res => res.issues),
  publish: (id: string, baseRevision: number, note: string, tool?: { enabled: boolean; name: string; description?: string }) =>
    post<{ meta: { publishedVersion: number } }>('api/dsh-flow/flow.publish', { id, baseRevision, note, ...(tool === undefined ? {} : { tool }) }).then(res => res.meta),
  startRun: (flowId: string, version: number | 'draft', inputs: unknown) =>
    post<{ runId: string }>('api/dsh-flow/run.start', { flowId, version, inputs }).then(res => res.runId),
  cancelRun: (runId: string) => post<{ ok: true }>('api/dsh-flow/run.cancel', { runId }),
  getRun: (runId: string) => request<{ summary: RunSummary }>(`api/dsh-flow/run.get?runId=${encodeURIComponent(runId)}`),
}

/** Error text for display. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
