/**
 * Tool-name glob matching and MCP server-name derivation.
 *
 * Only `*` is supported as a wildcard (matches zero or more characters). A
 * pattern with no wildcard matches exactly. Tool names carry no path separators,
 * so a per-character glob is sufficient and deterministic.
 *
 * @module @dsh-plugins/token-saver/shared/glob
 */

/**
 * Match a tool name against a glob pattern. A pattern is either a literal name
 * or contains `*` wildcards (each matching zero or more characters). No other
 * glob metacharacters are honoured.
 * @param pattern - the group's glob pattern (e.g. `web_fetch`, `mcp__github__*`).
 * @param name - the tool name to test.
 * @returns whether `name` matches `pattern`.
 */
export function matchesGlob(pattern: string, name: string): boolean {
  const parts = pattern.split('*')
  if (parts.length === 1) return pattern === name
  const head = parts[0] ?? ''
  const tail = parts[parts.length - 1] ?? ''
  if (name.length < head.length + tail.length || !name.startsWith(head) || !name.endsWith(tail)) return false
  let cursor = head.length
  const end = name.length - tail.length
  for (const middle of parts.slice(1, -1)) {
    const found = name.indexOf(middle, cursor)
    if (found === -1 || found + middle.length > end) return false
    cursor = found + middle.length
  }
  return true
}

/**
 * Derive the MCP server name from a tool name of the form `mcp__<server>__<tool>`.
 * @param name - the tool name.
 * @returns the MCP server name, or `undefined` if the name is not an MCP tool.
 */
export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  // The server is the first segment between the `mcp__` prefix and the first `__`.
  const rest = name.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep === -1) return rest
  return rest.slice(0, sep)
}
