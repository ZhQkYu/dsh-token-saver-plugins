/**
 * dsh-flow: a Coze-style deterministic workflow engine. Host side wires the
 * store, the routes, the engine, and the dynamic flow-as-tool registration.
 *
 * @module @dsh-plugins/flow/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-workspace'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Config as FlowConfig } from './config.ts'
import { FlowStore } from './store/flow-store.ts'
import { RunStore } from './store/run-store.ts'
import { registerFlowRoutes } from './routes/flows.ts'
import { registerCatalogRoutes } from './routes/catalog.ts'
import { registerRunRoutes } from './routes/runs.ts'
import { LAUNCH_SESSION_SERVICES } from './session-launch.ts'

export const name = 'dsh-flow'
export const inject = ['connection', 'tools', 'llm', 'agentDefaultModel', 'sandboxPolicy', ...LAUNCH_SESSION_SERVICES]

/** Re-export the schemastery config schema so the Loader validates the row's config. */
export { Config } from './config.ts'

import { FlowEngine, type EngineConfig } from './engine/engine.ts'
import { FlowTools } from './flow-tools.ts'

/**
 * Apply the flow plugin.
 * @param ctx - registrant context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: FlowConfig): void {
  const storageDir = config.storageDir ?? dshHomePath('flow')
  const flowStore = new FlowStore({ storageDir, maxFlowBytes: config.maxFlowBytes })
  const runStore = new RunStore({ storageDir, maxRunEventsBytes: config.maxRunEventsBytes, keepRunsPerFlow: config.keepRunsPerFlow })
  runStore.markInterrupted()

  const engineConfig: EngineConfig = {
    workspacePath: ctx.workspaceRegistry.list()[0]?.path ?? process.cwd(),
    runAgentPreset: config.runAgentPreset,
    runPermissionPreset: config.runPermissionPreset,
    archiveRunSessions: config.archiveRunSessions,
    maxConcurrentNodes: config.maxConcurrentNodes,
    maxNodeExecutionsPerRun: config.maxNodeExecutionsPerRun,
    maxLlmCallsPerRun: config.maxLlmCallsPerRun,
    maxAgentNodesPerRun: config.maxAgentNodesPerRun,
    maxRunDurationMs: config.maxRunDurationMs,
    maxNodeTimeoutMs: config.maxNodeTimeoutMs,
    maxNestingDepth: config.maxNestingDepth,
    maxRegexInputChars: config.maxRegexInputChars,
    http: config.http,
    code: config.code,
    agent: config.agent,
    maxValueBytes: config.maxValueBytes,
  }
  const engine = new FlowEngine(ctx, flowStore, runStore, engineConfig)
  const flowTools = new FlowTools(ctx, flowStore, engine, config.tools.prefix)

  const limits = {
    maxLoopIterations: config.maxLoopIterations,
    maxBatchConcurrency: config.maxBatchConcurrency,
    maxBatchItems: config.maxBatchItems,
    maxNodeTimeoutMs: config.maxNodeTimeoutMs,
    maxRetries: 5,
    maxNestingDepth: config.maxNestingDepth,
    maxRegexInputChars: config.maxRegexInputChars,
  }

  registerFlowRoutes(ctx, flowStore, {
    maxFlowBytes: config.maxFlowBytes,
    limits,
    onPublished: (flowId) => flowTools.register(flowId),
    onDeleted: (flowId) => flowTools.unregister(flowId),
  })
  registerCatalogRoutes(ctx, flowStore)
  registerRunRoutes(ctx, runStore, engine)
  flowTools.sync()
}
