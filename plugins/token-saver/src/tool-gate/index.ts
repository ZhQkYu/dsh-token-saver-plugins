/**
 * tool-gate: group tool availability per Agent. Groups are configured (or
 * synthesized per MCP server); an Agent keeps an enabled set; disabled-group
 * tools are removed from the Agent's visible and executable tools via
 * `agent.ctx.tools.restrict`. The model drives the gate with the `tool_gate`
 * tool, and durable state is folded from known session events so it survives
 * restarts.
 *
 * @module @dsh-plugins/token-saver/tool-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { foldToolGate, toolGateInit, toolGateStateSchema, type ToolGateState } from './state.ts'
import { reconcile, universeOf, type ReconcileEntry, type ReconcileEnv } from './reconcile.ts'
import { resolveGroups, isToolDisabled, type GroupConfig, type ResolvedGroup } from './groups.ts'
import { matchesGlob, mcpServerOf } from '../shared/glob.ts'
import { asProjectionStateSchema } from '../shared/projection.ts'

export const name = 'token-saver-tool-gate'
export const inject = ['tools', 'agents', 'systemPrompt', 'sessionProjections']

/** Tool-gate configuration. */
export interface Config {
  /** Explicit tool groups. */
  groups: GroupConfig[]
  /** Synthesize a group per MCP server not covered by an explicit group. */
  autoMcpGroups: boolean
  /** Default state for synthesized MCP groups. */
  mcpEnabledByDefault: boolean
  /** Whether subagents are gated too. */
  gateSubagents: boolean
}

/** Schemastery configuration for the tool-gate row. */
export const Config: z<Config> = z.object({
  groups: z.array(z.object({
    name: z.string(),
    description: z.string(),
    tools: z.array(z.string()),
    enabledByDefault: z.boolean(),
  })).default([]),
  autoMcpGroups: z.boolean().default(true),
  mcpEnabledByDefault: z.boolean().default(false),
  gateSubagents: z.boolean().default(true),
})

/** Model-facing gate tool description. */
const DESCRIPTION = 'Manage which tool groups are enabled for this session. '
  + 'Tools in disabled groups are NOT visible or callable. Use `list` to see groups '
  + 'and their state, then `enable`/`disable` a group; a change takes effect on the '
  + 'next step. Keep large groups (e.g. MCP servers) disabled unless you need them, '
  + 'to save context and tokens.'

/** Bound on refresh passes; a second pass only confirms the first pass's own restriction changes. */
const MAX_REFRESH_PASSES = 3

/** One rendered group row. */
interface GroupInfo {
  name: string
  description: string
  enabled: boolean
  toolCount: number
}

/** The `tool_gate` output value. */
interface GateOutput {
  groups: GroupInfo[]
  changed: boolean
}

/** Live gate state for one Agent. */
interface GateEntry extends ReconcileEntry {
  /** Groups the model or user chose; `null` follows the configured defaults. */
  explicit: Set<string> | null
}

/**
 * Apply the tool-gate plugin.
 * @param ctx - registrant context.
 * @param config - validated gate configuration.
 */
export function apply(ctx: Context, config: Config): void {
  let groups: ResolvedGroup[] = resolveGroups(config, new Map())

  ctx.sessionProjections.register<'tokenSaverToolGate', ToolGateState>({
    key: 'tokenSaverToolGate',
    stateSchema: asProjectionStateSchema(toolGateStateSchema),
    init: () => toolGateInit(),
    apply: foldToolGate,
    stateVersion: 1,
  })

  const entries = new Map<Agent, GateEntry>()
  let busy = false
  let again = false
  // Unregistering tool_gate during disposal emits `tools/change`; a refresh then would re-hide tools with no owner left to lift them.
  let disposed = false

  const warn = (message: string, error: unknown): void => {
    ctx.logger.warn(`token-saver tool-gate: ${message}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const gated = (agent: Agent): boolean => config.gateSubagents || agent.session.header.origin !== 'subagent'

  const envFor = (agent: Agent): ReconcileEnv => ({
    schemas: () => ctx.tools.schemas(agent),
    restrict: deny => agent.ctx.tools.restrict({ deny: [...deny] }),
  })

  const effectiveEnabled = (entry: GateEntry): ReadonlySet<string> =>
    entry.explicit ?? new Set(groups.filter(group => group.enabledByDefault).map(group => group.name))

  const initialExplicit = (agent: Agent): Set<string> | null => {
    const enabled = ctx.sessionProjections.stateOf(agent.session, 'tokenSaverToolGate')?.enabled
    if (enabled !== null && enabled !== undefined) return new Set(enabled)
    const parentId = agent.session.header.parentSession
    const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
    const inherited = parent === undefined ? undefined : entries.get(parent)?.explicit
    return inherited === undefined || inherited === null ? null : new Set(inherited)
  }

  const track = (agent: Agent): GateEntry | undefined => {
    if (disposed || !gated(agent)) return undefined
    const existing = entries.get(agent)
    if (existing !== undefined) return existing
    const entry: GateEntry = { explicit: initialExplicit(agent), hidden: [], unrestrictable: new Set() }
    entries.set(agent, entry)
    agent.ctx.effect(() => () => {
      entry.dispose?.()
      entry.dispose = undefined
      entries.delete(agent)
    })
    return entry
  }

  const liveAgents = (): Agent[] => [...new Set([...entries.keys(), ...ctx.agents.list()])]

  // Hidden names are absent from `schemas`, so discovery must include them or a gated server would vanish.
  const rediscover = (): void => {
    const names = new Set(ctx.tools.schemas().map(schema => schema.name))
    for (const agent of liveAgents()) {
      for (const toolName of universeOf(envFor(agent), entries.get(agent))) names.add(toolName)
    }
    const servers = new Map<string, Set<string>>()
    for (const toolName of names) {
      const server = mcpServerOf(toolName)
      if (server === undefined) continue
      const tools = servers.get(server) ?? new Set<string>()
      tools.add(toolName)
      servers.set(server, tools)
    }
    groups = resolveGroups(config, servers)
  }

  const refreshAgent = (agent: Agent): void => {
    try {
      const entry = track(agent)
      if (entry === undefined) return
      const enabled = effectiveEnabled(entry)
      reconcile(envFor(agent), entry, toolName => isToolDisabled(toolName, enabled, groups), (toolName, error) => {
        warn(`cannot hide ${toolName} for session ${agent.id}`, error)
      })
    } catch (error: unknown) {
      warn(`reconcile failed for session ${agent.id}`, error)
    }
  }

  // Never throws: it runs inside `agent/created`, whose listener failures roll back Agent creation.
  const refresh = (): void => {
    if (disposed) return
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      for (let pass = 0; pass < MAX_REFRESH_PASSES; pass++) {
        again = false
        rediscover()
        for (const agent of liveAgents()) refreshAgent(agent)
        if (!again) break
      }
    } catch (error: unknown) {
      warn('group discovery failed', error)
    } finally {
      busy = false
    }
  }

  const listGroups = (agent: Agent, entry: GateEntry, enabled: ReadonlySet<string>): GroupInfo[] => {
    const universe = universeOf(envFor(agent), entry)
    return groups.map(group => ({
      name: group.name,
      description: group.description,
      enabled: enabled.has(group.name),
      toolCount: [...universe].filter(toolName => group.patterns.some(pattern => matchesGlob(pattern, toolName))).length,
    }))
  }

  ctx.on('agent/created', ({ agent }) => {
    try {
      track(agent)
    } catch (error: unknown) {
      warn(`cannot track session ${agent.id}`, error)
    }
    refresh()
  })
  ctx.on('tools/change', refresh)

  ctx.tools.register(defineTool({
    name: 'tool_gate',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'enable', 'disable'],
        description: 'list (no change) | enable | disable.',
      },
      groups: {
        type: 'array',
        description: 'Group names to enable or disable (required for enable/disable).',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groups: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                toolCount: { type: 'integer', required: true },
              },
            },
          },
          changed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGate(value) }],
      // A `list` records nothing, so a session that never changed the gate keeps following the defaults.
      presentationMeta: (args, value) => args.action === 'list'
        ? {}
        : { enabled: value.groups.filter(group => group.enabled).map(group => group.name) },
    },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('tool_gate requires an owning agent session')
      const entry = track(agent)
      if (entry === undefined) throw new Error('tool_gate: tool groups are not gated for subagents in this deployment')
      const current = effectiveEnabled(entry)
      if (args.action === 'list') {
        return { groups: listGroups(agent, entry, current), changed: false }
      }
      const groupNames = args.groups ?? []
      if (groupNames.length === 0) {
        throw new Error('tool_gate enable/disable requires a non-empty groups list')
      }
      const known = new Set(groups.map(group => group.name))
      for (const groupName of groupNames) {
        if (!known.has(groupName)) {
          throw new Error(`tool_gate: unknown group ${JSON.stringify(groupName)}; known: ${[...known].join(', ')}`)
        }
      }
      const next = new Set(current)
      for (const groupName of groupNames) {
        if (args.action === 'enable') next.add(groupName)
        else next.delete(groupName)
      }
      const changed = next.size !== current.size || [...next].some(groupName => !current.has(groupName))
      entry.explicit = next
      refresh()
      return { groups: listGroups(agent, entry, next), changed }
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'Update tool groups', kind: 'other', rawInput: args.groups }),
  }))

  ctx.systemPrompt.section({
    name: 'token-saver-tool-gate',
    order: 1850,
    text: () => buildPrompt(groups),
  })

  ctx.effect(() => () => {
    disposed = true
    for (const entry of entries.values()) {
      entry.dispose?.()
      entry.dispose = undefined
    }
    entries.clear()
  })

  // Hot-install: gate Agents that were already live before this row loaded.
  refresh()
}

/** Render one line per group plus a one-line summary. */
function renderGate(value: GateOutput): string {
  const lines = value.groups.map(group => `${group.name} (${group.toolCount} tools) — ${group.enabled ? 'enabled' : 'disabled'} — ${group.description}`)
  return `Tool groups${value.changed ? ' updated' : ''}:\n${lines.join('\n')}`
}

/** Build the stable (state-free) system-prompt section text. */
function buildPrompt(groups: readonly ResolvedGroup[]): string {
  const lines = groups.map(group => `- ${group.name}: ${group.description}`)
  return 'Tool groups gate which tools are visible. Tools in disabled groups are not '
    + 'visible or callable. Use `tool_gate list` to see groups, and `tool_gate enable`/'
    + '`disable` to change them (effective next step). Keep large groups disabled unless '
    + 'you need them.\n' + lines.join('\n')
}
