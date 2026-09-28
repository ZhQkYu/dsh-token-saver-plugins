/**
 * Executor interfaces: each node type has a {@link NodeExecutor} that turns a
 * resolved input map into outputs. Executors depend only on the narrow
 * {@link FlowServices} seam, so the engine and executors are testable without
 * Cordis.
 *
 * @module @dsh-plugins/flow/host/executors
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { FlowDocument, FlowNode, FrameStep, JsonValue, TokenUsageLite } from '../../spec/types.ts'
import type { Frame, NodeStatus } from '../engine/frames.ts'
import type { RunBudget } from '../engine/budget.ts'
import type { NodeError } from '../engine/budget.ts'

/** The narrow services an executor uses, injectable with fakes in tests. */
export interface FlowServices {
  llm: {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }
  tools: {
    execute(input: { callId: unknown; name: string; arguments: Record<string, JsonValue>; agent?: unknown; parent?: unknown; rootCallId?: unknown; signal: AbortSignal }): Promise<{ isError: boolean; value: JsonValue; content: { type: string; text?: string }[]; error?: { name: string } }>
  }
  ptc?: {
    language: string
    resolve(request: unknown): unknown
    run(spec: unknown): Promise<{ value?: JsonValue; logs: string[]; error?: { kind: string; message: string } }>
  }
  subagents?: {
    start(provider: string, request: unknown): Promise<{ result: Promise<{ output: { type: string; text?: string }[]; structured?: JsonValue; stopReason: string; diagnostic?: string }>; dispose(): Promise<void> }>
  }
  fetch?(request: Request, options: { timeoutMs: number; maxResponseBytes: number }): Promise<{ status: number; headers: Record<string, string>; body: string; json: JsonValue }>
  defaultModel(): { provider: string; model: string; reasoningEffort?: string }
  /** Default subagent provider (e.g. `spawn`). */
  defaultProvider?: string
  /** Max left-value chars for a `matches` regex, to bound ReDoS. Default 100000. */
  maxRegexInputChars?: number
}

/** The agent binding for a run: a caller (tool invocation) or a run session. */
export type AgentBinding =
  | { kind: 'caller'; agent: Agent; parent: unknown; rootCallId: unknown }
  | { kind: 'run-session'; agent: Agent }

/** The interaction seam for `question` nodes. */
export interface Interaction {
  ask(execKey: string, question: string, answerSpec: unknown, signal: AbortSignal): Promise<{ text?: string; optionId?: string }>
}

/** The result of running a container scope (loop/batch). */
export interface FrameResult {
  /** node id -> outputs, for the body scope that just ran. */
  nodeOutputs: Map<string, Record<string, JsonValue>>
  /** Set when a break/continue fired inside the container body. */
  control?: 'break' | 'continue'
  /** Whether any node in the body frame failed. */
  failed: boolean
  /** The fatal error that failed the body frame, when a node failed with onError=fail. */
  error?: { code: string; message: string; nodeId?: string }
}

/** The context passed to an executor. */
export interface ExecContext {
  signal: AbortSignal
  runId: string
  execKey: string
  frame: Frame
  workspacePath: string
  budget: RunBudget
  emitDelta(text: string): void
  emitMessage(text: string): void
  agent(): Promise<AgentBinding>
  interaction: Interaction
  services: FlowServices
  runScope(container: FlowNode, inner: Record<string, JsonValue>): Promise<FrameResult>
  runSubflow(flowId: string, version: number | 'published' | 'draft', inputs: Record<string, JsonValue>): Promise<Record<string, JsonValue>>
}

/** The result of executing one node. */
export interface ExecResult {
  outputs: Record<string, JsonValue>
  firedPorts?: string[]
  usage?: TokenUsageLite
  logs?: string[]
  warnings?: string[]
}

/** An executor for one node type, keyed by its `type` discriminant. */
export interface NodeExecutor<N extends FlowNode = FlowNode> {
  type: N['type']
  requires?: readonly ('ptcRuntime' | 'subagents' | 'agent' | 'fetch')[]
  execute(node: N, inputs: Record<string, JsonValue>, ctx: ExecContext): Promise<ExecResult>
}

/** Build a {@link TokenUsageLite} from a DSH {@link TokenUsage}. */
export function toUsageLite(usage: TokenUsage | undefined): TokenUsageLite {
  if (usage === undefined) return { inputTokens: 0, outputTokens: 0 }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
}

export type { NodeError }
export type { Frame, NodeStatus, FlowDocument, FrameStep }
