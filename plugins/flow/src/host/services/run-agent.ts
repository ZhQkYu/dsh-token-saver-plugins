/**
 * Run-agent binding: provides the Agent used by tool/agent/question nodes. For
 * a canvas run it lazily creates an idle run Session; for a tool-triggered run
 * it returns the caller's Agent (with its parent token), so approvals and PTC
 * presentation flow through the caller.
 *
 * @module @dsh-plugins/flow/host/services/run-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentBinding } from '../executors/index.ts'
import { launchSession } from '../session-launch.ts'
import { flowSource } from '../message-source.ts'

/** Configuration for the run-agent manager. */
export interface RunAgentConfig {
  agentPreset?: string
  permissionPreset?: string
  archiveRunSessions: boolean
  workspacePath: string
}

/** A lazily-created run session Agent, disposed at run end. */
export class RunAgentManager {
  private handle: { sessionId: string; handle: { dispose(): Promise<void> } } | undefined
  private agent: Agent | undefined

  constructor(private readonly ctx: Context, private readonly config: RunAgentConfig, private readonly runId: string) {}

  /** The caller binding, set for tool-triggered runs. */
  caller?: { agent: Agent; parent: unknown; rootCallId: unknown }

  /** Resolve the Agent binding for this run. */
  async binding(): Promise<AgentBinding> {
    if (this.caller !== undefined) {
      return { kind: 'caller', agent: this.caller.agent, parent: this.caller.parent, rootCallId: this.caller.rootCallId }
    }
    const agent = await this.getOrCreateAgent()
    return { kind: 'run-session', agent }
  }

  private async getOrCreateAgent(): Promise<Agent> {
    if (this.agent !== undefined) return this.agent
    const created = await launchSession(this.ctx, {
      cwd: this.config.workspacePath,
      title: `[Flow] ${this.runId}`,
      source: flowSource('run', `Run flow ${this.runId}`),
      ...(this.config.agentPreset === undefined ? {} : { agentPreset: this.config.agentPreset }),
      ...(this.config.permissionPreset === undefined ? {} : { permissionPreset: this.config.permissionPreset }),
    })
    this.handle = created
    this.agent = created.handle.agent
    return created.handle.agent
  }

  /** The run session id, if one was created. */
  sessionId(): string | undefined {
    return this.handle?.sessionId
  }

  /** Dispose the run session Agent (if created). */
  async dispose(): Promise<void> {
    if (this.handle === undefined) return
    try {
      await this.handle.handle.dispose()
    } catch {
      // Best effort.
    }
  }
}
