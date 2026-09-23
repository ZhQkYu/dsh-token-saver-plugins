/**
 * Pure, import-free protocol shared by the Host package and the browser UI bundle.
 * Contains only types and constants: the canvas data model, run statuses, and the
 * Connection fetch route paths. Keeping this module dependency-free lets the UI
 * bundle re-export it without pulling any Host-only code.
 *
 * @module @dsh-plugins/token-saver/protocol
 */

/** A node in a canvas workflow graph. */
export type NodeKind = 'input' | 'task' | 'web-ai' | 'subagent' | 'tool' | 'review' | 'output'

/** One node in a {@link CanvasGraph}. */
export interface CanvasNode {
  id: string
  kind: NodeKind
  title: string
  instruction: string
  config: {
    provider?: string
    tool?: string
    model?: string
  }
  position: { x: number; y: number }
}

/** A directed edge between two {@link CanvasNode}s. */
export interface CanvasEdge {
  id: string
  source: string
  target: string
  label?: string
}

/** A saved workflow graph. */
export interface CanvasGraph {
  version: 1
  id: string
  name: string
  description: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  updatedAt: number
}

/** Lifecycle state of one node within a {@link CanvasRun}. */
export type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

/** Per-node progress for one run. */
export interface CanvasRunNode {
  status: NodeStatus
  summary?: string
  updatedAt: number
}

/** A run of a {@link CanvasGraph}. */
export interface CanvasRun {
  runId: string
  graphId: string
  sessionId?: string
  startedAt: number
  updatedAt: number
  nodes: Record<string, CanvasRunNode>
}

/** One compiled step produced by {@link compileGraph}. */
export interface CompiledStep {
  nodeId: string
  kind: NodeKind
  title: string
  instruction: string
  dependsOn: string[]
  hint: string
}

/** The compiled step list for a graph, in dependency order. */
export interface CompiledGraph {
  steps: CompiledStep[]
}

/** Connection fetch route paths registered under the token-saver namespace. */
export const ROUTES = {
  graphs: '/api/token-saver/canvas.graphs',
  graph: '/api/token-saver/canvas.graph',
  remove: '/api/token-saver/canvas.delete',
  runs: '/api/token-saver/canvas.runs',
  run: '/api/token-saver/canvas.run',
  workspaces: '/api/token-saver/canvas.workspaces',
} as const

/** The route segment charset enforced by the Connection fence. */
export const ROUTE_SEGMENT = /^[A-Za-z0-9_$.-]+$/

/** Identifier charset for graphs and nodes (no path traversal). */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
