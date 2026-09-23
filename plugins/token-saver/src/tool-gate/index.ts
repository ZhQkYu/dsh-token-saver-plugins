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
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { foldToolGate, toolGateInit, toolGateStateSchema, type ToolGateState } from './state.ts'
import { reconcile, type ReconcileEntry } from './reconcile.ts'
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

/**
 * Apply the tool-gate plugin.
 * @param ctx - registrant context.
 * @param config - validated gate configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.sessionProjections.register<'tokenSaverToolGate', ToolGateState>({
    key: 'tokenSaverToolGate',
    stateSchema: asProjectionStateSchema(toolGateStateSchema),
    init: () => toolGateInit(),
    apply: foldToolGate,
    stateVersion: 1,
  })

  const entries = new Map<Agent, ReconcileEntry>()
  const mcpServers = new Set<string>()
  let groups: ResolvedGroup[] = resolveGroups(config, mcpServers)
  let reentrant = false

  const defaultEnabled = (): Set<string> => new Set(groups.filter(group => group.enabledByDefault).map(group => group.name))

  const enabledFor = (agent: Agent): Set<string> => {
    const state = ctx.sessionProjections.stateOf(agent.session, 'tokenSaverToolGate')
    if (state?.enabled !== null && state?.enabled !== undefined) return new Set(state.enabled)
    return defaultEnabled()
  }

  const toolUniverse = (agent: Agent): Set<string> => {
    const universe = new Set<string>(ctx.tools.schemas(agent).map(schema => schema.name))
    const entry = entries.get(agent)
    if (entry !== undefined) for (const name of entry.hidden) universe.add(name)
    return universe
  }

  const groupToolCount = (group: ResolvedGroup, agent: Agent): number => {
    let count = 0
    for (const name of toolUniverse(agent)) {
      if (group.patterns.some(pattern => matchesGlob(pattern, name))) count++
    }
    return count
  }

  const listGroups = (agent: Agent, enabled: ReadonlySet<string>): GroupInfo[] => {
    return groups.map(group => ({
      name: group.name,
      description: group.description,
      enabled: enabled.has(group.name),
      toolCount: groupToolCount(group, agent),
    }))
  }

  const reconcileAgent = (agent: Agent): void => {
    if (config.gateSubagents === false && agent.session.header.origin === 'subagent') return
    let entry = entries.get(agent)
    if (entry === undefined) {
      entry = { enabled: enabledFor(agent), hidden: [], dispose: undefined }
      entries.set(agent, entry)
    }
    if (reentrant) return
    reentrant = true
    try {
      const live = entry
      reconcile({
        schemas: () => ctx.tools.schemas(agent),
        restrict: (deny) => agent.ctx.tools.restrict({ deny: [...deny] }),
      }, live, (name) => isToolDisabled(name, live.enabled, groups))
    } finally {
      reentrant = false
    }
  }

  const discoverMcpServers = (): void => {
    const servers = new Set<string>()
    const seenNames = new Set<string>()
    for (const agent of ctx.agents.list()) {
      for (const schema of ctx.tools.schemas(agent)) {
        if (seenNames.has(schema.name)) continue
        seenNames.add(schema.name)
        const server = mcpServerOf(schema.name)
        if (server !== undefined) servers.add(server)
      }
    }
    const changed = servers.size !== mcpServers.size || [...servers].some(server => !mcpServers.has(server))
    if (!changed) return
    mcpServers.clear()
    for (const server of servers) mcpServers.add(server)
    groups = resolveGroups(config, mcpServers)
    for (const agent of ctx.agents.list()) reconcileAgent(agent)
  }

  ctx.on('agent/created', ({ agent }) => {
    if (config.gateSubagents === false && agent.session.header.origin === 'subagent') return
    const state = ctx.sessionProjections.stateOf(agent.session, 'tokenSaverToolGate')
    let enabled: Set<string> | undefined
    if (state?.enabled !== null && state?.enabled !== undefined) {
      enabled = new Set(state.enabled)
    } else {
      const parentId = agent.session.header.parentSession
      const parent = parentId !== undefined ? ctx.agents.get(parentId) : undefined
      const parentEntry = parent !== undefined ? entries.get(parent) : undefined
      if (parentEntry !== undefined) enabled = new Set(parentEntry.enabled)
    }
    const entry: ReconcileEntry = {
      enabled: enabled ?? defaultEnabled(),
      hidden: [],
      dispose: undefined,
    }
    entries.set(agent, entry)
    agent.ctx.effect(() => () => {
      entry.dispose?.()
      entries.delete(agent)
    })
    discoverMcpServers()
    reconcileAgent(agent)
  })

  ctx.on('tools/change', () => {
    discoverMcpServers()
    for (const agent of ctx.agents.list()) reconcileAgent(agent)
  })

  // Hot-install: reconcile agents already live before this plugin loaded.
  for (const agent of ctx.agents.list()) {
    if (entries.has(agent)) continue
    const entry: ReconcileEntry = { enabled: enabledFor(agent), hidden: [], dispose: undefined }
    entries.set(agent, entry)
    agent.ctx.effect(() => () => {
      entry.dispose?.()
      entries.delete(agent)
    })
  }
  discoverMcpServers()
  for (const agent of ctx.agents.list()) reconcileAgent(agent)

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
      presentationMeta: (_args, value) => ({
        enabled: value.groups.filter(group => group.enabled).map(group => group.name),
      }),
    },
    execute: async (args, exec) => {
      if (!exec.agent) throw new Error('tool_gate requires an owning agent session')
      const entry = entries.get(exec.agent)
      if (entry === undefined) throw new Error('tool_gate: agent is not tracked')
      if (args.action === 'list') {
        return { groups: listGroups(exec.agent, entry.enabled), changed: false }
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
      const next = new Set(entry.enabled)
      for (const groupName of groupNames) {
        if (args.action === 'enable') next.add(groupName)
        else next.delete(groupName)
      }
      entry.enabled = next
      reconcileAgent(exec.agent)
      return { groups: listGroups(exec.agent, next), changed: true }
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
    for (const entry of entries.values()) entry.dispose?.()
    entries.clear()
  })
}

/** Render one line per group plus a one-line summary. */
function renderGate(value: GateOutput): string {
  const lines = value.groups.map(group => `${group.name} (${group.toolCount} tools) — ${group.enabled ? 'enabled' : 'disabled'} — ${group.description}`)
  return `Tool groups${value.changed ? ' updated' : ''}:\n${lines.join('\n')}`
}

/** Build the stable (state-free) system-prompt section text. */
function buildPrompt(groups: readonly ResolvedGroup[]): string {
  const lines = groups.map(group => `- ${group.name}: ${group.description} (${group.patterns.length} pattern(s))`)
  return 'Tool groups gate which tools are visible. Tools in disabled groups are not '
    + 'visible or callable. Use `tool_gate list` to see groups, and `tool_gate enable`/'
    + '`disable` to change them (effective next step). Keep large groups disabled unless '
    + 'you need them.\n' + lines.join('\n')
}
