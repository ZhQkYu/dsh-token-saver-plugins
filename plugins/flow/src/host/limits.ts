/**
 * Flow limits: the single set of tunable limits shared by the run routes, the
 * engine, and the executors. Drawn from the plugin {@link Config} via
 * {@link resolveLimits}.
 *
 * @module @dsh-plugins/flow/host/limits
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { MAX_NODE_RETRIES } from '../spec/types.ts'
import type { ValidateLimits } from '../spec/validate.ts'
import type { Config } from './config.ts'

/** The resolved, read-only limits a flow run obeys. */
export interface FlowLimits {
  maxConcurrentNodes: number
  maxNodeExecutionsPerRun: number
  maxLlmCallsPerRun: number
  maxAgentNodesPerRun: number
  maxRunDurationMs: number
  maxNodeTimeoutMs: number
  maxNestingDepth: number
  maxLoopIterations: number
  maxBatchItems: number
  maxBatchConcurrency: number
  maxRegexInputChars: number
  maxRetries: number
  code: { timeoutMs: number; sandboxMode: SandboxMode }
  http: { timeoutMs: number; maxResponseBytes: number; maxRedirects: number; allowPrivateNetwork: boolean; allowedHosts: string[] }
  recordValueChars: number
  maxValueBytes: number
  maxRunEventsBytes: number
  keepRunsPerFlow: number
  archiveRunSessions: boolean
  runAgentPreset?: string
  runPermissionPreset?: string
}

/** Resolve {@link Config} into the limits used by the engine and executors. */
export function resolveLimits(config: Config): FlowLimits {
  return {
    maxConcurrentNodes: config.maxConcurrentNodes,
    maxNodeExecutionsPerRun: config.maxNodeExecutionsPerRun,
    maxLlmCallsPerRun: config.maxLlmCallsPerRun,
    maxAgentNodesPerRun: config.maxAgentNodesPerRun,
    maxRunDurationMs: config.maxRunDurationMs,
    maxNodeTimeoutMs: config.maxNodeTimeoutMs,
    maxNestingDepth: config.maxNestingDepth,
    maxLoopIterations: config.maxLoopIterations,
    maxBatchItems: config.maxBatchItems,
    maxBatchConcurrency: config.maxBatchConcurrency,
    maxRegexInputChars: config.maxRegexInputChars,
    maxRetries: MAX_NODE_RETRIES,
    code: { timeoutMs: config.code.timeoutMs, sandboxMode: config.code.sandboxMode },
    http: {
      timeoutMs: config.http.timeoutMs,
      maxResponseBytes: config.http.maxResponseBytes,
      maxRedirects: config.http.maxRedirects,
      allowPrivateNetwork: config.http.allowPrivateNetwork,
      allowedHosts: config.http.allowedHosts,
    },
    recordValueChars: config.recordValueChars,
    maxValueBytes: config.maxValueBytes,
    maxRunEventsBytes: config.maxRunEventsBytes,
    keepRunsPerFlow: config.keepRunsPerFlow,
    archiveRunSessions: config.archiveRunSessions,
    ...(config.runAgentPreset === undefined ? {} : { runAgentPreset: config.runAgentPreset }),
    ...(config.runPermissionPreset === undefined ? {} : { runPermissionPreset: config.runPermissionPreset }),
  }
}

/** The subset of {@link FlowLimits} that flow validation checks, shared by the routes and the engine. */
export function validateLimitsOf(limits: Readonly<FlowLimits>): ValidateLimits {
  return {
    maxLoopIterations: limits.maxLoopIterations,
    maxBatchConcurrency: limits.maxBatchConcurrency,
    maxBatchItems: limits.maxBatchItems,
    maxNodeTimeoutMs: limits.maxNodeTimeoutMs,
    maxRetries: limits.maxRetries,
    maxNestingDepth: limits.maxNestingDepth,
    maxRegexInputChars: limits.maxRegexInputChars,
  }
}
