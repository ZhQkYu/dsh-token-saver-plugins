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
import { ToolCatalog } from './known-tools.ts'
import { registerRunRoutes } from './routes/runs.ts'
import { registerWorkflowTool } from './workflow-tool.ts'
import type { DesignToolDeps } from './design-tool.ts'
import type {} from './design-plugin.ts'
import { LAUNCH_SESSION_SERVICES } from './session-launch.ts'
import { resolveLimits, validateLimitsOf } from './limits.ts'

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

  const limits = resolveLimits(config)
  const engineConfig: EngineConfig = {
    ...limits,
    agent: config.agent,
    tools: config.tools,
  }
  const toolCatalog = new ToolCatalog(ctx, config.runAgentPreset)
  void toolCatalog.refresh()
  const engine = new FlowEngine(ctx, flowStore, runStore, engineConfig, toolCatalog)
  const flowTools = new FlowTools(ctx, flowStore, engine, config.tools.prefix)

  registerFlowRoutes(ctx, flowStore, {
    maxFlowBytes: config.maxFlowBytes,
    // Tools of presets without a live Agent stay unknown, so TOOL_UNKNOWN stays a warning.
    limits: () => ({ ...validateLimitsOf(limits), toolNames: toolCatalog.names(), strictTools: false }),
    isToolNameAvailable: (flowId, name) => flowTools.isNameAvailable(flowId, name),
    beforeDelete: (flowId) => engine.cancelFlow(flowId),
    onPublished: (flowId) => flowTools.sync(flowId),
    onDeleted: (flowId) => flowTools.unregister(flowId),
  })
  registerCatalogRoutes(ctx, flowStore, config.tools.prefix, validateLimitsOf(limits), toolCatalog)
  registerRunRoutes(ctx, runStore, engine)
  registerWorkflowTool(ctx, flowStore, engine)
  flowTools.sync()
  ctx.provide('flowDesign', {
    flowStore,
    runStore,
    engine,
    toolCatalog,
    toolPrefix: config.tools.prefix,
    limits: () => ({ ...validateLimitsOf(limits), toolNames: toolCatalog.names(), strictTools: false }),
  } satisfies DesignToolDeps)

  ctx.effect(() => () => { void engine.dispose() }, 'dsh-flow engine teardown')
}
