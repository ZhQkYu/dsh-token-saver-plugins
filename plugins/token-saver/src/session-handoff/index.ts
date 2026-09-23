/**
 * session-handoff: give a session a durable project memory file and a
 * `session_handoff` tool that writes a handoff document, optionally rewrites the
 * memory, and spawns a fresh session in the same workspace to continue. Also
 * nudges the model to hand off once its context grows past a threshold.
 *
 * @module @dsh-plugins/token-saver/session-handoff
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { readMemory, writeMemory, resolveWithin } from './memory.ts'
import { writeHandoff } from './handoff.ts'
import { launchSession } from '../shared/session-launch.ts'
import { tokenSaverSource } from '../shared/message-source.ts'
import { asProjectionStateSchema } from '../shared/projection.ts'

export const name = 'token-saver-session-handoff'
export const inject = ['tools', 'agents', 'sessionProjections', 'sessionTitle', 'permissionPresets', 'agentPresets', 'agentDefaultModel', 'workspaceRegistry']

/** Session-handoff configuration. */
export interface Config {
  /** Relative memory file path within the session cwd. */
  memoryFile: string
  /** Byte cap for the memory file read into context. */
  memoryMaxBytes: number
  /** Relative handoff-directory path within the session cwd. */
  handoffDir: string
  /** Input-token threshold that triggers the automatic handoff nudge (0 disables). */
  suggestAtInputTokens: number
  /** Whether to archive the old session once it goes idle. */
  archiveOldSession: boolean
  /** Title suffix for the continuation session. */
  titleSuffix: string
}

/** Schemastery configuration for the session-handoff row. */
export const Config: z<Config> = z.object({
  memoryFile: z.string().default('.dsh/memory.md'),
  memoryMaxBytes: z.natural().min(1).default(16384),
  handoffDir: z.string().default('.dsh/handoffs'),
  suggestAtInputTokens: z.natural().default(60000),
  archiveOldSession: z.boolean().default(true),
  titleSuffix: z.string().default(' (cont.)'),
})

/** Durable projection: whether the handoff nudge was already shown. */
interface HandoffSuggestedState {
  suggested: boolean
}

const handoffSuggestedSchema: ZodType<HandoffSuggestedState> = zod.object({
  suggested: zod.boolean(),
})

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    tokenSaverHandoffSuggested: HandoffSuggestedState
  }
}

/** Model-facing handoff tool description. */
const DESCRIPTION = 'Write a handoff document and start a fresh session to continue the task. '
  + 'Pass a summary of what was done, key decisions, files, and next steps. The new session '
  + 'starts with this document and continues the work. Use it when the current context is '
  + 'getting long or you are about to switch to a long-running task. This session should stop '
  + 'after the handoff and report to the user briefly.'

/** The handoff tool output value. */
interface HandoffOutput {
  newSessionId: string
  handoffFile: string
  memoryUpdated: boolean
  archive: 'scheduled' | 'disabled'
}

/** True when the session is a subagent (never hand off from one). */
function isSubagent(session: Session): boolean {
  return session.header.origin === 'subagent'
}

/**
 * Apply the session-handoff plugin.
 * @param ctx - registrant context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Validate the config paths resolve within any cwd at load time, loudly.
  try {
    resolveWithin('/placeholder', config.memoryFile)
    resolveWithin('/placeholder', config.handoffDir)
  } catch (error: unknown) {
    throw new Error(`token-saver session-handoff: ${error instanceof Error ? error.message : String(error)}`)
  }

  ctx.sessionProjections.register<'tokenSaverHandoffSuggested', HandoffSuggestedState>({
    key: 'tokenSaverHandoffSuggested',
    stateSchema: asProjectionStateSchema(handoffSuggestedSchema),
    init: () => ({ suggested: false }),
    apply: (state, event) => {
      if (event.type === 'user/message'
        && event.data.source.kind === 'token-saver'
        && event.data.source.feature === 'handoff-suggest'
        && !state.suggested) {
        return { suggested: true }
      }
      return state
    },
    stateVersion: 1,
  })

  ctx.systemPrompt.context({
    name: 'token-saver-memory',
    order: 900,
    text: (assemble) => {
      const agent = assemble.agent
      if (agent === undefined || isSubagent(agent.session)) return ''
      const cwd = agent.session.header.cwd
      if (cwd === undefined) return ''
      const content = readMemory(cwd, config.memoryFile, config.memoryMaxBytes, ctx.logger)
      if (content === '') return ''
      return `Project memory file (${config.memoryFile}). Keep it current with durable facts, decisions, and open tasks:\n\n${content}`
    },
  })

  ctx.tools.register(defineTool({
    name: 'session_handoff',
    description: DESCRIPTION,
    parameters: {
      summary: {
        type: 'string',
        required: true,
        description: 'The handoff document (Markdown): goal, completed work, key decisions, key files, next steps.',
      },
      memory: {
        type: 'string',
        description: 'Optional full replacement of the project memory file.',
      },
      title: {
        type: 'string',
        description: 'Optional title for the new session.',
      },
      nextPrompt: {
        type: 'string',
        description: 'Optional first instruction appended after the handoff document.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          newSessionId: { type: 'string', required: true },
          handoffFile: { type: 'string', required: true },
          memoryUpdated: { type: 'boolean', required: true },
          archive: { type: 'string', required: true, enum: ['scheduled', 'disabled'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Handed off to session ${value.newSessionId}. This session should stop executing and report to the user.`,
      }],
    },
    execute: async (args, exec) => {
      if (!exec.agent) throw new Error('session_handoff requires an owning agent session')
      const agent = exec.agent
      if (isSubagent(agent.session)) throw new Error('session_handoff is not available for subagents')
      const cwd = agent.session.header.cwd
      if (cwd === undefined) throw new Error('session_handoff requires a session cwd')
      const summary = args.summary.trim()
      if (summary.length === 0) throw new Error('session_handoff summary must be a non-empty string')

      const handoffFile = writeHandoff(cwd, config.handoffDir, agent.session.id, summary)

      let memoryUpdated = false
      if (args.memory !== undefined) {
        writeMemory(cwd, config.memoryFile, args.memory)
        memoryUpdated = true
      }

      const oldHeader = agent.session.header
      const oldTitle = ctx.sessionTitle.get(agent.session)?.title
      const title = args.title?.trim() || (oldTitle !== undefined ? `${oldTitle}${config.titleSuffix}` : `Continued session${config.titleSuffix}`)

      const requestHeader = agent.session.requestHeader()
      const model = requestHeader !== undefined
        ? { provider: requestHeader.config.provider, model: requestHeader.config.model, ...(requestHeader.config.reasoningEffort === undefined ? {} : { reasoningEffort: requestHeader.config.reasoningEffort }) }
        : undefined

      const prompt = `${summary}${args.nextPrompt?.trim() ? `\n\n${args.nextPrompt.trim()}` : ''}`
      const newSessionId = await launchSession(ctx, {
        cwd,
        title,
        prompt,
        source: tokenSaverSource('handoff', boundContextSummary(`Continued from session ${agent.session.id}`), { fromSession: agent.session.id }),
        ...(oldHeader.agentPreset === undefined ? {} : { agentPreset: oldHeader.agentPreset }),
        ...(model === undefined ? {} : { model }),
      })

      let archive: HandoffOutput['archive'] = 'disabled'
      if (config.archiveOldSession) {
        archive = 'scheduled'
        const oldAgent = agent
        const disposeListener = oldAgent.ctx.on('agent/status', ({ status }) => {
          if (status !== 'idle') return
          void (async () => {
            try {
              await ctx.workspaceRegistry.archiveSession(oldAgent.session.id)
            } catch (error: unknown) {
              ctx.logger.warn(`token-saver: archive retry pending: ${error instanceof Error ? error.message : String(error)}`)
              return
            }
            disposeListener()
          })()
        })
      }

      return { newSessionId, handoffFile, memoryUpdated, archive }
    },
    presentCall: () => ({ card: 'generic', title: 'Hand off to a new session', kind: 'other' }),
  }))

  if (config.suggestAtInputTokens > 0) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      if (isSubagent(session)) return
      const usage = event.data.usage
      if (usage === undefined || usage.inputTokens < config.suggestAtInputTokens) return
      const state = ctx.sessionProjections.stateOf(session, 'tokenSaverHandoffSuggested')
      if (state?.suggested === true) return
      const agent = ctx.agents.get(session.id)
      if (agent === undefined) return
      const summary = boundContextSummary(`Context is ~${usage.inputTokens} tokens`)
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: `Context is ~${usage.inputTokens} tokens. If the task will continue for long, call session_handoff to move to a fresh session with a handoff summary.` }],
        source: tokenSaverSource('handoff-suggest', summary),
      }))
    })
  }
}
