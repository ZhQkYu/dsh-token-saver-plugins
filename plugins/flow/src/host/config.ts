/**
 * Flow plugin configuration, validated by schemastery. Every deployment-varying
 * tunable is a Config field; there are no hardcoded tunables in plugin code.
 *
 * @module @dsh-plugins/flow/host/config
 */

import z from '@deepseek-ai/schemastery'

/** Flow plugin configuration. */
export interface Config {
  storageDir?: string
  maxFlowBytes: number
  keepRunsPerFlow: number
  maxRunEventsBytes: number
  recordValueChars: number
  maxValueBytes: number
  runAgentPreset?: string
  runPermissionPreset?: string
  archiveRunSessions: boolean
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
  code: { timeoutMs: number; sandboxMode: string }
  http: { timeoutMs: number; maxResponseBytes: number; allowPrivateNetwork: boolean; allowedHosts: string[] }
  agent: { provider: string }
  tools: { prefix: string }
}

/** Schemastery configuration for the dsh-flow row. */
export const Config: z<Config> = z.object({
  storageDir: z.string(),
  maxFlowBytes: z.natural().min(1024).default(1048576),
  keepRunsPerFlow: z.natural().min(1).default(50),
  maxRunEventsBytes: z.natural().min(1024).default(8388608),
  recordValueChars: z.natural().min(200).default(20000),
  maxValueBytes: z.natural().min(1024).default(4194304),
  runAgentPreset: z.string(),
  runPermissionPreset: z.string(),
  archiveRunSessions: z.boolean().default(true),
  maxConcurrentNodes: z.natural().min(1).default(8),
  maxNodeExecutionsPerRun: z.natural().min(1).default(2000),
  maxLlmCallsPerRun: z.natural().min(1).default(200),
  maxAgentNodesPerRun: z.natural().min(1).default(20),
  maxRunDurationMs: z.natural().min(1000).default(1800000),
  maxNodeTimeoutMs: z.natural().min(1000).default(600000),
  maxNestingDepth: z.natural().min(1).default(5),
  maxLoopIterations: z.natural().min(1).default(1000),
  maxBatchItems: z.natural().min(1).default(500),
  maxBatchConcurrency: z.natural().min(1).default(10),
  maxRegexInputChars: z.natural().min(100).default(100000),
  code: z.object({
    timeoutMs: z.natural().min(1000).default(30000),
    sandboxMode: z.string().default('read-only'),
  }),
  http: z.object({
    timeoutMs: z.natural().min(1000).default(30000),
    maxResponseBytes: z.natural().min(1024).default(2097152),
    allowPrivateNetwork: z.boolean().default(false),
    allowedHosts: z.array(z.string()).default([]),
  }),
  agent: z.object({
    provider: z.string().default('spawn'),
  }),
  tools: z.object({
    prefix: z.string().default('flow_'),
  }),
})
