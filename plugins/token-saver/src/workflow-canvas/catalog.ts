/**
 * Tool catalog for the canvas: the tools a session of the given agent preset
 * would see, read through a preset revision lease without creating an Agent.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tools'
import type { CatalogTool } from '../protocol.ts'

/** Tools that orchestrate the canvas itself rather than a step's work. */
const EXCLUDED = new Set(['canvas_workflow', 'run_code'])
const MAX_DESCRIPTION_CHARS = 160

/**
 * Shorten a model-facing description to its first sentence.
 * @param description - the full tool description.
 * @returns at most {@link MAX_DESCRIPTION_CHARS} characters.
 */
export function firstSentence(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  const end = flat.search(/\.(?:\s|$)|。/)
  const sentence = end === -1 ? flat : flat.slice(0, end + 1)
  return sentence.length <= MAX_DESCRIPTION_CHARS ? sentence : `${sentence.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
}

/**
 * List the global tools plus those the agent preset contributes, sorted by name.
 * @param ctx - context with the tool registry and the agent-preset registry.
 * @param preset - agent preset id; the deployment default when absent.
 * @returns the catalog rows.
 */
export async function listCatalogTools(ctx: Context, preset?: string): Promise<CatalogTool[]> {
  const byName = new Map<string, string>()
  for (const schema of ctx.tools.schemas()) byName.set(schema.name, schema.description)
  await using lease = await ctx.agentPresets.acquireScope(preset)
  for (const schema of ctx.tools.schemas(lease.key)) byName.set(schema.name, schema.description)
  return [...byName]
    .filter(([name]) => !EXCLUDED.has(name))
    .map(([name, description]) => ({ name, description: firstSentence(description) }))
    .sort((left, right) => left.name.localeCompare(right.name))
}
