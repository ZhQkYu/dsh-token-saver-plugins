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
  const engine = new FlowEngine(ctx, flowStore, runStore, engineConfig)
  const flowTools = new FlowTools(ctx, flowStore, engine, config.tools.prefix)

  registerFlowRoutes(ctx, flowStore, {
    maxFlowBytes: config.maxFlowBytes,
    // Scoped (preset/agent) tools are absent from the global schema list, so TOOL_UNKNOWN stays a warning.
    limits: () => ({ ...validateLimitsOf(limits), toolNames: new Set(ctx.tools.schemas().map(tool => tool.name)), strictTools: false }),
    isToolNameAvailable: (flowId, name) => flowTools.isNameAvailable(flowId, name),
    beforeDelete: (flowId) => engine.cancelFlow(flowId),
    onPublished: (flowId) => flowTools.sync(flowId),
    onDeleted: (flowId) => flowTools.unregister(flowId),
  })
  registerCatalogRoutes(ctx, flowStore, config.tools.prefix, validateLimitsOf(limits))
  registerRunRoutes(ctx, runStore, engine)
  flowTools.sync()

  ctx.effect(() => () => { void engine.dispose() }, 'dsh-flow engine teardown')
}
