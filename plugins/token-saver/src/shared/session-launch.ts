/**
 * Launch a new workspace-backed root Session, modelled on the webhook package's
 * `createWebhookSession` ordering. Used by session-handoff and workflow-canvas
 * to spawn a fresh conversation from plugin context.
 *
 * The resulting Agent is owned by the plugin `ctx`; if the plugin is later
 * unloaded its live Agent handle is released (the Session is already persisted
 * and can be reopened in the Web client). See the README Known Limitations.
 *
 * @module @dsh-plugins/token-saver/shared/session-launch
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage, errorChain, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'

/** Services {@link launchSession} reads; every caller's plugin `inject` must include them. */
export const LAUNCH_SESSION_SERVICES = [
  'agents', 'agentPresets', 'agentDefaultModel', 'workspaceRegistry', 'sessionTitle', 'permissionPresets',
] as const

/** Inputs for {@link launchSession}. */
export interface LaunchSessionRequest {
  /** Workspace directory the new Session is created in. */
  cwd: string
  /** New Session title. */
  title: string
  /** First user message text, which starts the run; absent leaves the Agent idle. */
  prompt?: string
  /** Message attribution for the first message. */
  source: UserMessage['source']
  /** Agent preset to mount; when absent the deployment default is resolved. */
  agentPreset?: string
  /** Permission preset to set; when absent the deployment default is left in place. */
  permissionPreset?: string
  /** Model selection; when absent the deployment default selection is used. */
  model?: ModelSelection
  /** Cancellation signal for the creation transaction. */
  signal?: AbortSignal
}

/**
 * Apply the creation-time selection until the first durable request header
 * exists, mirroring the webhook package.
 * @param agentCtx - the new Agent's context.
 * @param selection - the model selection to install.
 */
function installInitialModelSelection(agentCtx: Context, selection: ModelSelection): void {
  agentCtx.on('agent/request', async ({ agent }, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (agent.session.requestHeader() !== undefined
      || resolved.provider !== selection.provider
      || resolved.model !== selection.model) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
  })
}

/** A launched Session and the Agent handle the launching `ctx` holds for it. */
export interface LaunchedSession {
  sessionId: SessionId
  /** Disposing it releases this plugin's reference; the Session stays persisted. */
  handle: AgentHandle
}

/**
 * Create, attach, title, configure, and optionally prompt one ordinary root Session.
 * On any failure the created Session is detached and the Agent disposed before
 * rethrowing, leaving no partial state.
 * @param ctx - runtime context that owns the resulting Agent.
 * @param request - creation inputs.
 * @returns the new Session id and its Agent handle.
 */
export async function launchSession(ctx: Context, request: LaunchSessionRequest): Promise<LaunchedSession> {
  const signal = request.signal ?? new AbortController().signal
  const preset = await ctx.agentPresets.resolve(request.agentPreset)
  await using presetScope = await ctx.agentPresets.acquireScope(preset.id)
  void presetScope
  signal.throwIfAborted()

  const workspace = await ctx.workspaceRegistry.create(request.cwd)
  signal.throwIfAborted()
  const sessionId = brandString<SessionId>(`ts-${randomUUID()}`)
  const selection = request.model ?? ctx.agentDefaultModel.currentSelection()
  const handle = await ctx.agents.create({
    sessionId,
    signal,
    meta: { cwd: workspace.path, agentPreset: preset.id },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, preset.id)
      installInitialModelSelection(agentCtx, selection)
    },
  })

  let attached = false
  try {
    signal.throwIfAborted()
    await workspace.attachSession(sessionId)
    attached = true
    signal.throwIfAborted()
    if (request.permissionPreset !== undefined) {
      ctx.permissionPresets.resolve(request.permissionPreset)
      ctx.permissionPresets.set(handle.agent.session, request.permissionPreset)
    }
    ctx.sessionTitle.rename(handle.agent.session, request.title)
    if (request.prompt !== undefined) {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: request.prompt }],
        source: request.source,
      }))
    }
  } catch (error: unknown) {
    if (attached) {
      try {
        await workspace.detachSession(sessionId)
      } catch (rollbackError: unknown) {
        ctx.logger.warn(`token-saver: workspace detach rollback failed: ${errorChain(rollbackError)}`)
      }
    }
    try {
      await handle.dispose()
    } catch (rollbackError: unknown) {
      ctx.logger.warn(`token-saver: agent disposal rollback failed: ${errorChain(rollbackError)}`)
    }
    throw error
  }
  return { sessionId, handle }
}
