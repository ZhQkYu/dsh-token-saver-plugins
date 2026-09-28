/**
 * Run-agent binding: provides the Agent used by tool/agent/question nodes. For
 * a canvas run it lazily creates one idle run Session shared by every node; for
 * a tool-triggered run it returns the caller's Agent (with its parent token),
 * so approvals and PTC presentation flow through the caller.
 *
 * @module @dsh-plugins/flow/host/services/run-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { AgentBinding } from '../executors/index.ts'
import { launchSession, type LaunchedSession } from '../session-launch.ts'
import { flowSource } from '../message-source.ts'

/** Configuration for the run-agent manager. */
export interface RunAgentConfig {
  agentPreset?: string
  permissionPreset?: string
  archiveRunSessions: boolean
  workspacePath: string
  /** Title of the lazily created run session. */
  title: string
}

/** A lazily-created run session Agent, disposed (and optionally archived) at run end. */
export class RunAgentManager {
  private launched: LaunchedSession | undefined
  private pending: Promise<LaunchedSession> | undefined
  private disposed = false

  constructor(private readonly ctx: Context, private readonly config: RunAgentConfig, private readonly runId: string, private readonly signal?: AbortSignal) {}

  /** The caller binding, set for tool-triggered runs. */
  caller?: { agent: Agent; parent: ToolExecutionToken; rootCallId: ToolCallId }

  /** Callback fired once when the run session is created. */
  onSessionCreated?: (sessionId: string) => void

  /** Resolve the Agent binding for this run; concurrent callers share one session launch. */
  async binding(): Promise<AgentBinding> {
    if (this.caller !== undefined) {
      return { kind: 'caller', agent: this.caller.agent, parent: this.caller.parent, rootCallId: this.caller.rootCallId }
    }
    if (this.disposed) throw new Error(`run ${this.runId} has ended`)
    this.pending ??= launchSession(this.ctx, {
      cwd: this.config.workspacePath,
      title: this.config.title,
      source: flowSource('run', `Run flow ${this.runId}`),
      ...(this.config.agentPreset === undefined ? {} : { agentPreset: this.config.agentPreset }),
      ...(this.config.permissionPreset === undefined ? {} : { permissionPreset: this.config.permissionPreset }),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    }).then((launched) => {
      this.launched = launched
      this.onSessionCreated?.(launched.sessionId)
      return launched
    }, (error: unknown) => {
      this.pending = undefined
      throw error
    })
    const launched = await this.pending
    return { kind: 'run-session', agent: launched.handle.agent }
  }

  /** The run session id, if one was created. */
  sessionId(): string | undefined {
    return this.launched?.sessionId
  }

  /** Dispose the run session Agent (waiting for an in-flight launch) and archive it when configured. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.pending !== undefined) {
      try {
        await this.pending
      } catch (error: unknown) {
        this.ctx.logger.debug(`flow: run session launch for ${this.runId} failed before dispose: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const launched = this.launched
    if (launched === undefined) return
    try {
      await launched.handle.dispose()
    } catch (error: unknown) {
      this.ctx.logger.warn(`flow: run session dispose failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!this.config.archiveRunSessions) return
    try {
      await this.ctx.workspaceRegistry.archiveSession(launched.sessionId satisfies SessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`flow: run session archive failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
