/**
 * Pure, import-free protocol shared by the Host package and the browser UI
 * bundle. Contains only types and constants: the flow data model (typed
 * variables, value sources, node specs), the run event model, and the
 * Connection fetch route paths. Keeping this module dependency-free lets the
 * UI bundle re-export it without pulling any Host-only code.
 *
 * @module @dsh-plugins/flow/spec/types
 */

/** The schema version of a {@link FlowDocument}. */
export const FLOW_SCHEMA_VERSION = 1 as const

/** Variable name: used in templates and code, so it must be a valid identifier. */
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Flow, node, and run id (no path traversal). */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** The schema-level maximum retries a node error policy may request. */
export const MAX_NODE_RETRIES = 5

/** Heartbeat interval for the `run.events` NDJSON stream, in milliseconds. */
export const RUN_EVENTS_PING_MS = 15_000

/** The part of a flow tool name after the configured prefix (`flow_<name>`). */
export const FLOW_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,40}$/

/** A JSON-compatible value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** The variable type set, aligned with the DSH `defineTool` parameter types. */
export type VarType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'any'

/** A variable's type and optional structural constraints. */
export interface VarSchema {
  type: VarType
  /** `array` element type; absent means `any`. */
  items?: VarSchema
  /** `object` known fields; absent means any object. */
  properties?: VarField[]
  description?: string
}

/** One named field of an `object` schema. */
export interface VarField {
  name: string
  schema: VarSchema
  required?: boolean
  description?: string
}

/** A value: a literal, or a reference to a node output or a container inner variable. */
export type ValueSource =
  | { kind: 'literal'; value: JsonValue }
  | {
      /**
       * `source: 'output'` reads a node output, `path[0]` is the output name
       * and the rest are object field names; `source: 'inner'` is only valid
       * inside a container (loop/batch) and reads `item`/`index`/loop vars.
       */
      kind: 'ref'
      node: string
      source: 'output' | 'inner'
      path: [string, ...string[]]
    }

/** One bound input of a node: a local name the template/code uses, with its value source. */
export interface InputBinding {
  name: string
  schema: VarSchema
  value: ValueSource
  /** Absent means `true`; a null/missing value fails the node. */
  required?: boolean
}

/** Node error policy (Coze SettingOnError). */
export interface ErrorPolicy {
  timeoutMs?: number
  retries?: number
  onError: 'fail' | 'default' | 'branch'
  /** `onError: 'default'` output, validated against the node output schema. */
  defaultOutputs?: Record<string, JsonValue>
}

/** A model selection (provider + model + optional reasoning effort). */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Every node type, in palette order; the last few are control flow. */
export const NODE_TYPES = [
  'start', 'end', 'llm', 'intent', 'agent', 'condition', 'code', 'http', 'tool',
  'text', 'json', 'aggregate', 'loop', 'batch', 'break', 'continue', 'assign',
  'subflow', 'question', 'message', 'comment',
] as const
export type NodeType = (typeof NODE_TYPES)[number]

/**
 * What a flow document is: `flow` runs in the engine with typed data flow;
 * `guided` is a step list a model follows (in a conversation, or as one agent
 * step inside another flow).
 */
export const FLOW_KINDS = ['flow', 'guided'] as const
export type FlowKind = (typeof FLOW_KINDS)[number]

/** The node types a guided flow may contain; the rest need the engine's typed data flow. */
export const GUIDED_NODE_TYPES: readonly NodeType[] = [
  'start', 'end', 'agent', 'tool', 'condition', 'loop', 'break', 'continue', 'subflow', 'question', 'message', 'comment',
]

/** Start node data: declared input fields with optional defaults. */
export interface StartData {
  fields: (VarField & { default?: JsonValue })[]
}

/** End node data: how the run result is produced. */
export interface EndData {
  mode: 'variables' | 'text'
  inputs: InputBinding[]
  template?: string
}

/** LLM node data. */
export interface LlmData {
  model?: ModelSelection
  inputs: InputBinding[]
  system: string
  prompt: string
  temperature?: number
  maxTokens?: number
  output: { format: 'text' } | { format: 'json'; fields: VarField[] }
}

/** Intent node data. */
export interface IntentData {
  model?: ModelSelection
  inputs: InputBinding[]
  query: string
  intents: { id: string; label: string; description?: string }[]
  instruction?: string
}

/** Agent node data. */
export interface AgentData {
  inputs: InputBinding[]
  prompt: string
  persona?: string
  model?: ModelSelection
  tools?: { allow?: string[] }
  outputs?: VarField[]
  provider?: string
}

/** Condition operator set, aligned with Coze and extended with `matches`. */
export const CONDITION_OPS = [
  'eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'not_contains',
  'contains_key', 'not_contains_key', 'empty', 'not_empty', 'is_true', 'is_false',
  'len_gt', 'len_ge', 'len_lt', 'len_le', 'matches',
] as const
export type ConditionOp = (typeof CONDITION_OPS)[number]

/** One condition branch of a `condition` node. */
export interface ConditionBranch {
  id: string
  label: string
  logic: 'and' | 'or'
  conditions: { left: ValueSource; op: ConditionOp; right?: ValueSource }[]
}

/** Condition node data. */
export interface ConditionData {
  branches: ConditionBranch[]
}

/** Code node data. */
export interface CodeData {
  language: 'typescript'
  inputs: InputBinding[]
  code: string
  outputs: VarField[]
  timeoutMs?: number
}

/** HTTP node data. */
export interface HttpData {
  inputs: InputBinding[]
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  url: string
  headers: { name: string; value: string }[]
  query: { name: string; value: string }[]
  body: { kind: 'none' } | { kind: 'json' | 'text'; template: string } | { kind: 'form'; fields: { name: string; value: string }[] }
  timeoutMs?: number
  /** Declared fields of the parsed JSON response; shapes the `json` output for downstream pickers. */
  outputs?: VarField[]
}

/** Tool node data. */
export interface ToolData {
  tool: string
  args: InputBinding[]
  /**
   * Extra variables that literal string args may reference as `{{name}}`
   * templates; they are not sent to the tool.
   */
  inputs?: InputBinding[]
  /** Declared fields of the tool's structured `value`; shapes it for downstream pickers. */
  outputs?: VarField[]
}

/** Text node data. */
export type TextData =
  | { op: 'concat'; inputs: InputBinding[]; template: string }
  | { op: 'split'; input: ValueSource; delimiters: string[] }

/** JSON node data. */
export type JsonData =
  | { op: 'parse'; input: ValueSource; outputs?: VarField[] }
  | { op: 'stringify'; input: ValueSource; pretty?: boolean }

/** Aggregate node data. */
export interface AggregateData {
  groups: { name: string; schema: VarSchema; candidates: ValueSource[] }[]
}

/** Loop node data. */
export interface LoopData {
  mode: 'array' | 'count' | 'infinite'
  array?: ValueSource
  count?: ValueSource
  maxIterations: number
  variables: { name: string; schema: VarSchema; initial: ValueSource }[]
  outputs: { name: string; value: ValueSource }[]
  /** Guided flows: the natural-language condition that ends the loop early. */
  until?: string
}

/** Batch node data. */
export interface BatchData {
  array: ValueSource
  concurrency: number
  maxItems: number
  outputs: { name: string; value: ValueSource }[]
}

/** Assign node data. */
export interface AssignData {
  assignments: { variable: string; value: ValueSource }[]
}

/** Subflow node data. */
export interface SubflowData {
  flowId: string
  version: 'published' | 'draft'
  inputs: InputBinding[]
}

/** Question node data. */
export interface QuestionData {
  inputs: InputBinding[]
  question: string
  answer: { kind: 'text' } | { kind: 'options'; options: { id: string; label: string }[]; allowOther: boolean }
  timeoutMs?: number
}

/** Message node data. */
export interface MessageData {
  inputs: InputBinding[]
  template: string
}

/** Comment node data. */
export interface CommentData {
  text: string
}

/** Base fields shared by every node. */
export interface NodeBase<T extends NodeType, D> {
  id: string
  type: T
  title: string
  description?: string
  position: { x: number; y: number }
  parentId?: string
  size?: { width: number; height: number }
  onError?: ErrorPolicy
  data: D
}

/** A node in a {@link FlowDocument}. */
export type FlowNode =
  | NodeBase<'start', StartData>
  | NodeBase<'end', EndData>
  | NodeBase<'llm', LlmData>
  | NodeBase<'intent', IntentData>
  | NodeBase<'agent', AgentData>
  | NodeBase<'condition', ConditionData>
  | NodeBase<'code', CodeData>
  | NodeBase<'http', HttpData>
  | NodeBase<'tool', ToolData>
  | NodeBase<'text', TextData>
  | NodeBase<'json', JsonData>
  | NodeBase<'aggregate', AggregateData>
  | NodeBase<'loop', LoopData>
  | NodeBase<'batch', BatchData>
  | NodeBase<'break', Record<string, never>>
  | NodeBase<'continue', Record<string, never>>
  | NodeBase<'assign', AssignData>
  | NodeBase<'subflow', SubflowData>
  | NodeBase<'question', QuestionData>
  | NodeBase<'message', MessageData>
  | NodeBase<'comment', CommentData>

/** A directed edge between two {@link FlowNode}s. */
export interface FlowEdge {
  id: string
  source: string
  /** Port id: 'next' | branch id | 'else' | 'error' | 'body' | option/intent id | 'other'. */
  sourceHandle: string
  target: string
}

/** A saved workflow. */
export interface FlowDocument {
  schemaVersion: 1
  id: string
  name: string
  description: string
  /** Absent means `flow`. */
  kind?: FlowKind
  /** React Flow requires a container to precede its children. */
  nodes: FlowNode[]
  edges: FlowEdge[]
  revision: number
  updatedAt: number
}

/** A port specification. */
export interface PortSpec {
  id: string
  label: string
  kind: 'next' | 'branch' | 'error' | 'body'
}

/** The host-provided lookup for subflow input/output derivation. `'published'` resolves to the latest published version. */
export interface FlowLookup {
  (flowId: string, version: number | 'published' | 'draft'): FlowLookupResult | undefined
}

/** What a {@link FlowLookup} knows about one flow version. */
export interface FlowLookupResult {
  inputs: VarField[]
  outputs: VarField[]
  /** Subflows the version itself references, for recursion and depth checks. */
  subflows?: { flowId: string; version: 'published' | 'draft' }[]
  /** Absent means `flow`. */
  kind?: FlowKind
}

/** Validation context handed to node-level validators. */
export interface ValidateContext {
  doc: FlowDocument
  lookup: FlowLookup
}

/** A non-UI node specification, shared by Host validation and UI forms. */
export interface NodeSpec<N extends FlowNode = FlowNode> {
  type: N['type']
  executable: boolean
  container: boolean
  allowedParents?: readonly ('root' | 'loop' | 'batch')[]
  defaults(): N['data']
  hasInput(node: N): boolean
  ports(node: N): PortSpec[]
  outputs(node: N, lookup: FlowLookup): VarField[]
  innerVars?(node: N, doc: FlowDocument): VarField[]
  validate(node: N, ctx: ValidateContext): Issue[]
}

/** A validation issue code, used by the UI for localization. */
export type IssueCode =
  | 'START_COUNT' | 'END_COUNT' | 'DUPLICATE_ID' | 'BAD_ID' | 'BAD_NAME' | 'DUPLICATE_NAME'
  | 'UNKNOWN_PORT' | 'CROSS_SCOPE_EDGE' | 'CYCLE' | 'BAD_PARENT' | 'UNREACHABLE' | 'END_UNREACHABLE'
  | 'DANGLING_REF' | 'NOT_ANCESTOR' | 'TYPE_MISMATCH' | 'REQUIRED_INPUT' | 'TEMPLATE_UNKNOWN_VAR'
  | 'BAD_REGEX' | 'BAD_LIMIT' | 'SUBFLOW_MISSING' | 'SUBFLOW_RECURSION' | 'SUBFLOW_DEPTH'
  | 'TOOL_UNKNOWN' | 'SERVICE_UNAVAILABLE' | 'LOOP_BODY_EMPTY' | 'GUIDED_UNSUPPORTED'

/** A validation issue. */
export interface Issue {
  severity: 'error' | 'warning'
  code: IssueCode
  message: string
  nodeId?: string
  edgeId?: string
  field?: string
}

/** The kind of an execution frame step. */
export interface FrameStep {
  node: string
  index?: number
}

/** A slim token usage record persisted in run events. */
export interface TokenUsageLite {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

/** How a `question` node asks for its answer. */
export type AnswerSpec =
  | { kind: 'text' }
  | { kind: 'options'; options: { id: string; label: string }[]; allowOther: boolean }

/** One run event. */
export type RunEvent = { seq: number; time: number } & (
  | { type: 'run.started'; runId: string; flowId: string; version: number | 'draft'; inputs: JsonValue }
  | { type: 'node.started'; execKey: string; nodeId: string; path: FrameStep[]; attempt: number; inputs: JsonValue }
  | { type: 'node.delta'; execKey: string; text: string }
  | {
      type: 'node.finished'
      execKey: string
      nodeId: string
      path: FrameStep[]
      attempt: number
      status: 'succeeded' | 'failed' | 'skipped' | 'cancelled'
      outputs?: JsonValue
      firedPorts?: string[]
      error?: { code: string; message: string }
      usage?: TokenUsageLite
      durationMs?: number
      logs?: string[]
      warnings?: string[]
      /** The rendered model-facing text for an LLM node (system/prompt), after truncation. */
      rendered?: { system?: string; prompt?: string }
    }
  | { type: 'run.waiting'; execKey: string; question: string; answer: AnswerSpec }
  | { type: 'run.resumed'; execKey: string }
  | { type: 'run.message'; execKey: string; text: string }
  | {
      type: 'run.finished'
      status: 'succeeded' | 'failed' | 'cancelled'
      outputs?: JsonValue
      error?: { code: string; message: string; nodeId?: string }
      usage: TokenUsageLite
      durationMs: number
    }
)

/** Trigger metadata for a {@link RunSummary}. */
export type RunTrigger =
  | { kind: 'canvas' }
  | { kind: 'tool'; sessionId: string; callId: string }
  | { kind: 'debug'; nodeId: string }
  /** A guided flow followed by a model; `sessionId` is set once a session picks the run up. */
  | { kind: 'guided'; sessionId?: string }

/** Lifecycle state of a whole run. */
export type RunStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

/** A run summary, written at start and updated at the end. */
export interface RunSummary {
  runId: string
  flowId: string
  flowName: string
  version: number | 'draft'
  trigger: RunTrigger
  status: RunStatus
  inputs: JsonValue
  outputs?: JsonValue
  error?: { code: string; message: string; nodeId?: string }
  sessionId?: string
  startedAt: number
  finishedAt?: number
  usage: TokenUsageLite
  nodeExecutions: number
  /** The workspace directory the run executed against; absent in summaries written before it was recorded. */
  workspacePath?: string
  /** Set when persisted events were truncated past the byte limit. */
  eventsTruncated?: boolean
}

/** A folded node status from the run-view. */
export interface RunViewNode {
  execKey: string
  nodeId: string
  path: FrameStep[]
  attempt: number
  /** Total attempts across all retries for this execKey. */
  attempts?: number
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
  inputs?: JsonValue
  outputs?: JsonValue
  firedPorts?: string[]
  error?: { code: string; message: string }
  usage?: TokenUsageLite
  durationMs?: number
  logs?: string[]
  warnings?: string[]
  /** The rendered model-facing text for an LLM node. */
  rendered?: { system?: string; prompt?: string }
}

/** The folded view of one run, shared by the Host `run.get` route and the UI. */
export interface RunView {
  runId: string
  status: RunStatus
  nodes: RunViewNode[]
  outputs?: JsonValue
  error?: { code: string; message: string; nodeId?: string }
  usage: TokenUsageLite
  durationMs: number
  messages: { execKey: string; text: string }[]
}

/** Connection fetch route paths registered under the flow namespace. */
export const ROUTES = {
  flows: '/api/dsh-flow/flows',
  flow: '/api/dsh-flow/flow',
  flowCreate: '/api/dsh-flow/flow.create',
  flowSave: '/api/dsh-flow/flow.save',
  flowDelete: '/api/dsh-flow/flow.delete',
  flowDuplicate: '/api/dsh-flow/flow.duplicate',
  flowValidate: '/api/dsh-flow/flow.validate',
  flowPublish: '/api/dsh-flow/flow.publish',
  flowVersions: '/api/dsh-flow/flow.versions',
  flowVersion: '/api/dsh-flow/flow.version',
  flowExport: '/api/dsh-flow/flow.export',
  flowImport: '/api/dsh-flow/flow.import',
  runStart: '/api/dsh-flow/run.start',
  runEvents: '/api/dsh-flow/run.events',
  runGet: '/api/dsh-flow/run.get',
  runCancel: '/api/dsh-flow/run.cancel',
  runAnswer: '/api/dsh-flow/run.answer',
  runs: '/api/dsh-flow/runs',
  nodeDebug: '/api/dsh-flow/node.debug',
  catalogModels: '/api/dsh-flow/catalog.models',
  catalogTools: '/api/dsh-flow/catalog.tools',
  catalogFlows: '/api/dsh-flow/catalog.flows',
  catalogWorkspaces: '/api/dsh-flow/catalog.workspaces',
  catalogLimits: '/api/dsh-flow/catalog.limits',
} as const
