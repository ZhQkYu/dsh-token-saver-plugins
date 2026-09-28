/**
 * The tool names flows can call, for the editor's tool picker and validation.
 *
 * @module @dsh-plugins/flow/host/known-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'

/**
 * Tool schemas visible globally or to any live root Agent. Preset-mounted
 * tools (e.g. `read`) exist only in Agent scopes, so the list depends on which
 * sessions are open.
 * @param ctx - the plugin context.
 * @returns one schema per tool name, sorted by name.
 */
export function knownToolSchemas(ctx: Context): ReturnType<Context['tools']['schemas']> {
  const byName = new Map<string, ReturnType<Context['tools']['schemas']>[number]>()
  for (const tool of ctx.tools.schemas()) byName.set(tool.name, tool)
  for (const agent of ctx.agents.roots()) {
    for (const tool of ctx.tools.schemas(agent)) if (!byName.has(tool.name)) byName.set(tool.name, tool)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
