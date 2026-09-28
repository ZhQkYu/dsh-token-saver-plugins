/**
 * Run budget: shared limits across all frames and subflows of one run. Exceeding
 * a limit raises a non-retryable `NodeError('BUDGET_EXCEEDED')`.
 *
 * @module @dsh-plugins/flow/host/engine/budget
 */

/** NodeError-like error with a code, used by executors and the engine. */
export class NodeError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
    this.name = 'NodeError'
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

  constructor(private readonly config: BudgetConfig) {
    this.startedAt = Date.now()
  }

  /** Consume one node execution; throws when the ceiling is reached. */
  consumeNodeExecution(): void {
    this.nodeExecutions++
    if (this.nodeExecutions > this.config.maxNodeExecutions) {
      throw new NodeError('BUDGET_EXCEEDED', `node executions exceed ${this.config.maxNodeExecutions}`)
    }
  }

  /** Consume one LLM call; throws when the ceiling is reached. */
  consumeLlmCall(): void {
    this.llmCalls++
    if (this.llmCalls > this.config.maxLlmCalls) {
      throw new NodeError('BUDGET_EXCEEDED', `llm calls exceed ${this.config.maxLlmCalls}`)
    }
  }

  /** Consume one agent node; throws when the ceiling is reached. */
  consumeAgentNode(): void {
    this.agentNodes++
    if (this.agentNodes > this.config.maxAgentNodes) {
      throw new NodeError('BUDGET_EXCEEDED', `agent nodes exceed ${this.config.maxAgentNodes}`)
    }
  }

  /** Whether the run has exceeded its total duration. */
  isExpired(): boolean {
    return Date.now() - this.startedAt > this.config.maxRunDurationMs
  }

  /** The elapsed duration in milliseconds. */
  durationMs(): number {
    return Date.now() - this.startedAt
  }
}
