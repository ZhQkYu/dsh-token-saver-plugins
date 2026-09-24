/**
 * Browser calls to the canvas Connection routes. Paths are document-relative
 * (no leading slash) so they resolve under the app's own mount; non-2xx
 * responses reject with the Host's plain-text reason.
 *
 * @module @dsh-plugins/token-saver-ui/client/api
 */

import type { CanvasGraph, CanvasRun } from '@dsh-plugins/token-saver/protocol'

/** One graph row in the list. */
export interface GraphSummary {
  id: string
  name: string
  description: string
  nodeCount: number
}

/** One workspace the run can start in. */
export interface WorkspaceSummary {
  id: string
  title: string
  path: string
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
  graphs: () => request<{ graphs: GraphSummary[] }>('api/token-saver/canvas.graphs').then(res => res.graphs),
  graph: (id: string) => request<{ graph: CanvasGraph }>(`api/token-saver/canvas.graph?id=${encodeURIComponent(id)}`).then(res => res.graph),
  save: (graph: CanvasGraph) => post<{ graph: CanvasGraph }>('api/token-saver/canvas.graph', graph).then(res => res.graph),
  remove: (id: string) => post<{ ok: true }>('api/token-saver/canvas.delete', { id }),
  runs: (graphId: string) => request<{ runs: CanvasRun[] }>(`api/token-saver/canvas.runs?graphId=${encodeURIComponent(graphId)}`).then(res => res.runs),
  run: (graphId: string, workspaceId: string) => post<{ sessionId: string }>('api/token-saver/canvas.run', { graphId, workspaceId }).then(res => res.sessionId),
  workspaces: () => request<{ workspaces: WorkspaceSummary[] }>('api/token-saver/canvas.workspaces').then(res => res.workspaces),
}

/** Error text for display. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
