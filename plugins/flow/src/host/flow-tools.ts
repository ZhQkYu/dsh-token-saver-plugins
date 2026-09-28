/**
 * flow-tools: expose published flows as DSH tools (`flow_<name>`). Each tool's
 * parameters come from the start node fields and its output schema from the
 * end node. Running the tool starts a flow run that inherits the caller's
 * Agent, so approvals and PTC presentation flow through the caller.
 *
 * @module @dsh-plugins/flow/host/flow-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-client-connection'
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { FlowDocument, JsonValue, VarField } from '../spec/types.ts'
import { toParameterSchemaSpec, toValueSchemaSpec } from '../spec/var-schema.ts'
import type { FlowStore } from './store/flow-store.ts'
import type { FlowEngine } from './engine/engine.ts'

/** The default prefix for flow tool names. */
export const FLOW_TOOL_PREFIX = 'flow_'

/** Register and sync flow-as-tool tools. */
export class FlowTools {
  private readonly disposers = new Map<string, () => void>()

  constructor(private readonly ctx: Context, private readonly flowStore: FlowStore, private readonly engine: FlowEngine, private readonly prefix: string = FLOW_TOOL_PREFIX) {}

  /** Sync tools for all flows that are published and enabled as tools. */
  sync(): void {
    for (const summary of this.flowStore.list()) {
      const meta = this.flowStore.getMeta(summary.id)
      if (meta?.tool?.enabled === true && meta.publishedVersion !== undefined) {
        this.register(summary.id)
      }
    }
  }

  /** Register the tool for a flow, or no-op if already registered. */
  register(flowId: string): void {
    if (this.disposers.has(flowId)) return
    const meta = this.flowStore.getMeta(flowId)
    if (meta?.tool?.enabled !== true) return
    const version = meta.publishedVersion
    if (version === undefined) return
    const flow = this.flowStore.version(flowId, version)
    if (flow === undefined) return
    const toolName = `${this.prefix}${meta.tool.name}`
    if (this.ctx.tools.get(toolName) !== undefined) return
    const { parameters, outputFields, endMode } = describeFlow(flow)
    const parametersSchema: ParameterSchemaSpec = {}
    for (const field of parameters) {
      parametersSchema[field.name] = toParameterSchemaSpec(field.schema, field.required === true) as never
    }
    const properties: ParameterSchemaSpec = {}
    for (const field of outputFields) {
      properties[field.name] = toValueSchemaSpec(field.schema) as never
    }
    const outputSchema: ValueSchemaSpec = endMode === 'text'
      ? { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true }
      : { type: 'object', properties, additionalProperties: true }

    const disposer = this.ctx.tools.register(defineTool({
      name: toolName,
      description: meta.tool.description || `Run the "${flow.name}" flow.`,
      parameters: parametersSchema,
      output: {
        schema: outputSchema,
        render: (_args, value) => {
          const record = value as Record<string, JsonValue>
          if (endMode === 'text') return [{ type: 'text', text: String(record['text'] ?? '') }]
          return [{ type: 'text', text: JSON.stringify(record, null, 2) }]
        },
      },
      timeoutMs: this.engine.timeoutMs(),
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const result = await this.engine.start({
          flowId,
          version: 'published',
          inputs: args as JsonValue,
          caller: exec.agent === undefined ? undefined : { agent: exec.agent, parent: exec.token, rootCallId: exec.rootCallId },
        })
        const summary = await this.engine.awaitRun(result.runId)
        const outputs = (summary.outputs ?? {}) as Record<string, JsonValue>
        return outputs as never
      },
    }))
    this.disposers.set(flowId, disposer)
  }

  /** Unregister the tool for a flow. */
  unregister(flowId: string): void {
    const disposer = this.disposers.get(flowId)
    if (disposer === undefined) return
    disposer()
    this.disposers.delete(flowId)
  }

  /** Unregister a tool by name, used when the name collides. */
  releaseAll(): void {
    for (const disposer of [...this.disposers.values()]) disposer()
    this.disposers.clear()
  }
}

/** The tool-facing description of a flow's inputs and outputs. */
function describeFlow(flow: FlowDocument): { parameters: VarField[]; outputFields: VarField[]; endMode: 'variables' | 'text' } {
  const start = flow.nodes.find(node => node.type === 'start')
  const end = flow.nodes.find(node => node.type === 'end')
  const parameters = start?.type === 'start'
    ? start.data.fields.map(f => ({ name: f.name, schema: f.schema, required: f.required }))
    : []
  if (end?.type === 'end' && end.data.mode === 'text') {
    return { parameters, outputFields: [], endMode: 'text' }
  }
  const outputFields = end?.type === 'end'
    ? end.data.inputs.map(binding => ({ name: binding.name, schema: binding.schema }))
    : []
  return { parameters, outputFields, endMode: 'variables' }
}
