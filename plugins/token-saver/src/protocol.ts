/**
 * Pure, import-free protocol shared by the Host package and the browser UI bundle.
 * Contains only types and constants: the canvas data model, run statuses, and the
 * Connection fetch route paths. Keeping this module dependency-free lets the UI
 * bundle re-export it without pulling any Host-only code.
 *
 * @module @dsh-plugins/token-saver/protocol
 */

/** Every node kind, in palette order; the last three are control flow. */
export const NODE_KINDS = ['input', 'task', 'web-ai', 'subagent', 'tool', 'review', 'output', 'condition', 'loop', 'subflow'] as const

/** A node in a canvas workflow graph. */
export type NodeKind = (typeof NODE_KINDS)[number]

/**
 * How a graph runs: `guided` hands the step list to one model, which follows it;
 * `strict` runs the graph in the workflow engine, with a fresh model per step.
 */
export const GRAPH_MODES = ['guided', 'strict'] as const

/** One of {@link GRAPH_MODES}. */
export type GraphMode = (typeof GRAPH_MODES)[number]

/** Who decides a condition branch or a loop exit: a model call, or a text rule over the input. */
export const DECIDE_MODES = ['model', 'rule'] as const

/** One of {@link DECIDE_MODES}. */
export type DecideMode = (typeof DECIDE_MODES)[number]

/** Text tests a rule applies to the node input. */
export const RULE_OPS = ['contains', 'equals', 'regex'] as const

/** A text test; `equals` compares trimmed text, `regex` is case-insensitive. */
export interface RuleMatch {
  op: (typeof RULE_OPS)[number]
  value: string
}

/** One outgoing branch of a `condition` node; its id is the edge `sourceHandle`. */
export interface CanvasBranch {
  id: string
  label: string
  /** The test used when the node decides by rule. */
  rule?: RuleMatch | undefined
}

/** The branch handle every condition node has, taken when no branch applies. */
export const ELSE_BRANCH = 'else'

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
    /** `condition` and `loop`: how the branch or the exit is decided. */
    decide?: DecideMode | undefined
    /** `condition`: the named branches, in handle order. */
    branches?: CanvasBranch[] | undefined
    /** `subflow`: the workflow to run; `loop`: the loop body. */
    graphId?: string | undefined
    /** `loop`: the round limit. */
    maxIterations?: number | undefined
    /** `loop` with `decide: 'rule'`: the test on a round's output that ends the loop. */
    exitRule?: RuleMatch | undefined
  }
  position: { x: number; y: number }
}

/** A directed edge between two {@link CanvasNode}s. */
export interface CanvasEdge {
  id: string
  source: string
  target: string
  label?: string | undefined
  /** The source `condition` node's branch id; absent for every other source. */
  sourceHandle?: string | undefined
}

/** A saved workflow graph. */
export interface CanvasGraph {
  version: 1
  id: string
  name: string
  description: string
  /** Absent means `guided`. */
  mode?: GraphMode | undefined
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
  /** `condition`: the branch id taken. */
  branch?: string | undefined
  /** `loop`: the round in progress or last finished. */
  iteration?: number | undefined
  updatedAt: number
}

/** Every whole-run state a strict run reports; `interrupted` means the server stopped mid-run. */
export const RUN_STATES = ['running', 'done', 'failed', 'cancelled', 'interrupted'] as const

/** One of {@link RUN_STATES}. */
export type RunState = (typeof RUN_STATES)[number]

/** A run of a {@link CanvasGraph}. */
export interface CanvasRun {
  runId: string
  graphId: string
  sessionId?: string | undefined
  /** Absent means `guided`. */
  mode?: GraphMode | undefined
  /** Strict runs only; guided progress lives in the node statuses. */
  state?: RunState | undefined
  /** Strict runs: the outputs of the graph's final nodes. */
  output?: string | undefined
  error?: string | undefined
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

/** One tool a `tool` node can name, as the canvas catalog lists it. */
export interface CatalogTool {
  name: string
  /** First sentence of the model-facing description. */
  description: string
}

/** One web AI provider a `web-ai` node can name. */
export interface CatalogProvider {
  id: string
  displayName: string
  strengths: string
  /** Whether web_ai_ask currently accepts this provider. */
  enabled: boolean
}

/** Connection fetch route paths registered under the token-saver namespace. */
export const ROUTES = {
  graphs: '/api/token-saver/canvas.graphs',
  graph: '/api/token-saver/canvas.graph',
  remove: '/api/token-saver/canvas.delete',
  runs: '/api/token-saver/canvas.runs',
  run: '/api/token-saver/canvas.run',
  cancel: '/api/token-saver/canvas.cancel',
  workspaces: '/api/token-saver/canvas.workspaces',
  tools: '/api/token-saver/canvas.tools',
  webAiProviders: '/api/token-saver/web-ai.providers',
} as const

/** Identifier charset for graphs and nodes (no path traversal). */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
