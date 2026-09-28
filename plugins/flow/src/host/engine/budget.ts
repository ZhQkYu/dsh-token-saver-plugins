/**
 * Run budget: shared limits across all frames and subflows of one run. Exceeding
 * a limit raises a non-retryable {@link BudgetExceededError}, a run-level fatal
 * error that the scheduler never applies an error policy to.
 *
 * @module @dsh-plugins/flow/host/engine/budget
 */

import type { TokenUsageLite } from '../../spec/types.ts'

/** NodeError-like error with a code, used by executors and the engine. */
export class NodeError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
    this.name = 'NodeError'
  }
}

/** A run-level fatal error: the run cannot continue and must abort. */
export class BudgetExceededError extends NodeError {
  constructor(message: string) {
    super('BUDGET_EXCEEDED', message, false)
    this.name = 'BudgetExceededError'
  }
}

/** The run budget configuration. */
export interface BudgetConfig {
  maxNodeExecutions: number
  maxLlmCalls: number
  maxAgentNodes: number
  maxRunDurationMs: number
}

/** A per-run budget, shared by all frames and subflows. */
export class RunBudget {
  nodeExecutions = 0
  llmCalls = 0
  agentNodes = 0
  readonly startedAt: number
  private inputTokens = 0
  private outputTokens = 0
  private cacheReadTokens = 0
  private reasoningTokens = 0

  constructor(private readonly config: BudgetConfig) {
    this.startedAt = Date.now()
  }

  /** Consume one node execution; throws when the ceiling is reached. */
  consumeNodeExecution(): void {
    this.nodeExecutions++
    if (this.nodeExecutions > this.config.maxNodeExecutions) {
      throw new BudgetExceededError(`node executions exceed ${this.config.maxNodeExecutions}`)
    }
  }

  /** Consume one LLM call; throws when the ceiling is reached. */
  consumeLlmCall(): void {
    this.llmCalls++
    if (this.llmCalls > this.config.maxLlmCalls) {
      throw new BudgetExceededError(`llm calls exceed ${this.config.maxLlmCalls}`)
    }
  }

  /** Consume one agent node; throws when the ceiling is reached. */
  consumeAgentNode(): void {
    this.agentNodes++
    if (this.agentNodes > this.config.maxAgentNodes) {
      throw new BudgetExceededError(`agent nodes exceed ${this.config.maxAgentNodes}`)
    }
  }

  /** Accumulate usage from one completed call. */
  addUsage(usage: TokenUsageLite): void {
    this.inputTokens += usage.inputTokens
    this.outputTokens += usage.outputTokens
    this.cacheReadTokens += usage.cacheReadTokens ?? 0
    this.reasoningTokens += usage.reasoningTokens ?? 0
  }

  /** The cumulative usage across all calls in the run. */
  usage(): TokenUsageLite {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.cacheReadTokens === 0 ? {} : { cacheReadTokens: this.cacheReadTokens }),
      ...(this.reasoningTokens === 0 ? {} : { reasoningTokens: this.reasoningTokens }),
    }
  }

  /** The elapsed duration in milliseconds. */
  durationMs(): number {
    return Date.now() - this.startedAt
  }
}
