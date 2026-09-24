/**
 * Group resolution for tool-gate: validate configured groups, synthesize MCP
 * server groups, and decide whether a tool name is gated away for an Agent.
 *
 * @module @dsh-plugins/token-saver/tool-gate/groups
 */

import { matchesGlob } from '../shared/glob.ts'

/** A configured tool group. */
export interface GroupConfig {
  /** Group name; `^[a-z0-9][a-z0-9_-]{0,31}$`, unique. */
  name: string
  /** Model-facing description. */
  description: string
  /** Tool-name glob patterns (only `*` supported). */
  tools: string[]
  /** Whether the group is enabled for a fresh session. */
  enabledByDefault: boolean
}

/** A resolved group, including any synthesized MCP server group. */
export interface ResolvedGroup {
  name: string
  description: string
  patterns: string[]
  enabledByDefault: boolean
  /** The MCP server name when this group was synthesized. */
  autoMcp?: string
}

/** Group-name charset shared with the Config schema. */
export const GROUP_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

/**
 * Validate configured groups and synthesize a group per MCP server that no
 * explicit group covers. Explicit-group errors throw (they are load-time
 * configuration faults); a discovered server is skipped, never an error, when
 * an explicit group already matches one of its tools or owns its `mcp-<server>`
 * name.
 * @param config - the tool-gate config.
 * @param mcpServers - discovered MCP server names mapped to their tool names.
 * @returns the resolved, ordered group list.
 */
export function resolveGroups(
  config: { groups: GroupConfig[]; autoMcpGroups: boolean; mcpEnabledByDefault: boolean },
  mcpServers: ReadonlyMap<string, ReadonlySet<string>>,
): ResolvedGroup[] {
  const groups: ResolvedGroup[] = []
  const seen = new Set<string>()
  for (const group of config.groups) {
    if (!GROUP_NAME.test(group.name)) {
      throw new Error(`tool-gate group name ${JSON.stringify(group.name)} must match ${GROUP_NAME}`)
    }
    if (seen.has(group.name)) {
      throw new Error(`tool-gate group name ${JSON.stringify(group.name)} is duplicated`)
    }
    if (group.tools.length === 0) {
      throw new Error(`tool-gate group ${JSON.stringify(group.name)} has no tools`)
    }
    seen.add(group.name)
    groups.push({ name: group.name, description: group.description, patterns: group.tools, enabledByDefault: group.enabledByDefault })
  }
  if (config.autoMcpGroups) {
    const explicit = [...groups]
    for (const server of [...mcpServers.keys()].sort()) {
      const name = `mcp-${server}`
      const tools = mcpServers.get(server) ?? new Set<string>()
      const covered = [...tools].some(tool => explicit.some(group => group.patterns.some(pattern => matchesGlob(pattern, tool))))
      if (seen.has(name) || covered) continue
      seen.add(name)
      groups.push({
        name,
        description: `MCP server ${server}`,
        patterns: [`mcp__${server}__*`],
        enabledByDefault: config.mcpEnabledByDefault,
        autoMcp: server,
      })
    }
  }
  return groups
}

/**
 * Decide whether a tool name is gated away for an Agent. A tool that belongs to
 * no group is never gated. A tool that belongs to at least one group is gated
 * away only when every group it belongs to is disabled.
 * @param name - the tool name.
 * @param enabled - the Agent's enabled group-name set.
 * @param groups - the resolved groups.
 * @returns whether the tool should be denied.
 */
export function isToolDisabled(name: string, enabled: ReadonlySet<string>, groups: readonly ResolvedGroup[]): boolean {
  let belongs = false
  let anyEnabled = false
  for (const group of groups) {
    if (group.patterns.some(pattern => matchesGlob(pattern, name))) {
      belongs = true
      if (enabled.has(group.name)) anyEnabled = true
    }
  }
  return belongs && !anyEnabled
}
