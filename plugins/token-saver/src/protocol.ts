/**
 * Pure, import-free protocol shared by the Host package and the browser UI bundle.
 * Contains only types and constants: the canvas data model, run statuses, and the
 * Connection fetch route paths. Keeping this module dependency-free lets the UI
 * bundle re-export it without pulling any Host-only code.
 *
 * @module @dsh-plugins/token-saver/protocol
 */

/** Every node kind, in palette order. */
export const NODE_KINDS = ['input', 'task', 'web-ai', 'subagent', 'tool', 'review', 'output'] as const

/** A node in a canvas workflow graph. */
export type NodeKind = (typeof NODE_KINDS)[number]

/** One node in a {@link CanvasGraph}. */
export interface CanvasNode {
  id: string
  kind: NodeKind
  title: string
  instruction: string
  config: {
    provider?: string | undefined
    tool?: string | undefined
    model?: string | undefined
  }
  position: { x: number; y: number }
}

/** A directed edge between two {@link CanvasNode}s. */
export interface CanvasEdge {
  id: string
  source: string
  target: string
  label?: string | undefined
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

/** Every node status. */
export const NODE_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const

/** Lifecycle state of one node within a {@link CanvasRun}. */
export type NodeStatus = (typeof NODE_STATUSES)[number]

/** Per-node progress for one run. */
export interface CanvasRunNode {
  status: NodeStatus
  summary?: string | undefined
  updatedAt: number
}

/** A run of a {@link CanvasGraph}. */
export interface CanvasRun {
  runId: string
  graphId: string
  sessionId?: string | undefined
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

/** Connection fetch route paths registered under the token-saver namespace. */
export const ROUTES = {
  graphs: '/api/token-saver/canvas.graphs',
  graph: '/api/token-saver/canvas.graph',
  remove: '/api/token-saver/canvas.delete',
  runs: '/api/token-saver/canvas.runs',
  run: '/api/token-saver/canvas.run',
  workspaces: '/api/token-saver/canvas.workspaces',
} as const

/** Identifier charset for graphs and nodes (no path traversal). */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
