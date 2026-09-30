/**
 * The tools flows can call, for the editor's tool picker and `TOOL_UNKNOWN`
 * validation: global tools, the run preset's tools (read through a scope lease
 * without creating an Agent), and tools visible to live root Agents.
 *
 * @module @dsh-plugins/flow/host/known-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tools'

type ToolSchema = ReturnType<Context['tools']['schemas']>[number]

/** A tool list that combines the global, preset, and live-Agent views. */
export class ToolCatalog {
  private presetTools: ToolSchema[] = []
  private presetOutputs = new Map<string, unknown>()

  constructor(private readonly ctx: Context, private readonly preset: string | undefined) {}

  /** Re-read the preset's tools; a failure keeps the previous list and is logged. */
  async refresh(): Promise<void> {
    try {
      await using lease = await this.ctx.agentPresets.acquireScope(this.preset)
      this.presetTools = this.ctx.tools.schemas(lease.key)
      this.presetOutputs = new Map(this.presetTools.map(tool => [tool.name, this.ctx.tools.get(tool.name, lease.key)?.output.schema]))
    } catch (error: unknown) {
      this.ctx.logger.debug(`flow: preset tool list unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The JSON Schema of a tool's structured `value`, when it declares one.
   * @param name - the tool name.
   * @returns the output schema, or undefined.
   */
  outputSchema(name: string): unknown {
    const global = this.ctx.tools.get(name)?.output.schema
    if (global !== undefined) return global
    if (this.presetOutputs.has(name)) return this.presetOutputs.get(name)
    for (const agent of this.ctx.agents.roots()) {
      const schema = this.ctx.tools.get(name, agent)?.output.schema
      if (schema !== undefined) return schema
    }
    return undefined
  }

  /**
   * The known tools, one schema per name.
   * @returns the schemas sorted by name.
   */
  schemas(): ToolSchema[] {
    const byName = new Map<string, ToolSchema>()
    const add = (tools: readonly ToolSchema[]): void => { for (const tool of tools) if (!byName.has(tool.name)) byName.set(tool.name, tool) }
    add(this.ctx.tools.schemas())
    add(this.presetTools)
    for (const agent of this.ctx.agents.roots()) add(this.ctx.tools.schemas(agent))
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * The known tool names.
   * @returns the names.
   */
  names(): Set<string> {
    return new Set(this.schemas().map(tool => tool.name))
  }
}
