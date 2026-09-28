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
import type { FlowDocument, JsonValue, RunSummary, VarField } from '../spec/types.ts'
import { toParameterSchemaSpec, toValueSchemaSpec } from '../spec/var-schema.ts'
import { flowInterface, flowKind } from '../spec/guided.ts'
import type { FlowStore } from './store/flow-store.ts'
import type { FlowEngine } from './engine/engine.ts'

/** The default prefix for flow tool names. */
export const FLOW_TOOL_PREFIX = 'flow_'

/** Register and sync flow-as-tool tools. */
export class FlowTools {
  private readonly disposers = new Map<string, () => void>()
  private readonly names = new Map<string, string>()

  constructor(private readonly ctx: Context, private readonly flowStore: FlowStore, private readonly engine: FlowEngine, private readonly prefix: string = FLOW_TOOL_PREFIX) {}

  /**
   * Whether `flowId` may publish under tool `name`: no other flow claims it and no
   * other registrant holds `prefix + name`.
   */
  isNameAvailable(flowId: string, name: string): boolean {
    for (const summary of this.flowStore.list()) {
      if (summary.id === flowId || summary.broken === true) continue
      if (summary.toolName === name && summary.publishedVersion !== undefined) return false
    }
    const full = `${this.prefix}${name}`
    return this.ctx.tools.get(full) === undefined || this.names.get(flowId) === full
  }

  /** Sync the tool for a flow: unregister any stale registration, then re-register per current meta. */
  sync(flowId?: string): void {
    if (flowId !== undefined) {
      this.unregister(flowId)
      const meta = this.flowStore.getMeta(flowId)
      if (meta?.tool?.enabled === true && meta.publishedVersion !== undefined) {
        this.register(flowId)
      }
      return
    }
    for (const summary of this.flowStore.list()) {
      this.sync(summary.id)
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
    if (this.ctx.tools.get(toolName) !== undefined) {
      // The publish route rejects taken names; this only happens when another plugin registered the name later.
      this.ctx.logger.warn(`flow: tool name ${toolName} is taken; flow ${flowId} is not exposed as a tool`)
      return
    }
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
        if (flowKind(flow) === 'guided') {
          if (exec.agent === undefined) throw new Error(`"${flow.name}" is a guided workflow and needs a calling Agent`)
          return await this.engine.runGuidedTool(flowId, version, args as JsonValue, exec.agent, exec.signal) as never
        }
        const { runId } = await this.engine.start({
          flowId,
          version: 'published',
          inputs: args as JsonValue,
          caller: exec.agent === undefined ? undefined : { agent: exec.agent, parent: exec.token, rootCallId: exec.rootCallId, callId: exec.callId },
          workspacePath: exec.agent?.session.header.cwd,
        })
        const onAbort = (): void => { void this.engine.cancel(runId) }
        exec.signal.addEventListener('abort', onAbort, { once: true })
        try {
          const summary = await this.engine.awaitRun(runId)
          if (summary?.status !== 'succeeded') {
            throw new Error(describeFailure(flow, summary))
          }
          return (summary.outputs ?? {}) as never
        } finally {
          exec.signal.removeEventListener('abort', onAbort)
        }
      },
    }))
    this.disposers.set(flowId, disposer)
    this.names.set(flowId, toolName)
  }

  /** Unregister the tool for a flow. */
  unregister(flowId: string): void {
    const disposer = this.disposers.get(flowId)
    if (disposer === undefined) return
    disposer()
    this.disposers.delete(flowId)
    this.names.delete(flowId)
  }

  /** Unregister every flow tool. */
  releaseAll(): void {
    for (const disposer of [...this.disposers.values()]) disposer()
    this.disposers.clear()
    this.names.clear()
  }
}

/**
 * Describe a failed run for a tool error message, naming the failing node.
 * @param flow - the flow that ran.
 * @param summary - the run's final summary.
 * @returns the message.
 */
export function describeFailure(flow: Pick<FlowDocument, 'name' | 'nodes'>, summary: RunSummary | undefined): string {
  if (summary === undefined) return `run of "${flow.name}" has no summary`
  const parts = [`run of "${flow.name}" ${summary.status}`]
  const error = summary.error
  if (error !== undefined) {
    const node = error.nodeId === undefined ? undefined : flow.nodes.find(candidate => candidate.id === error.nodeId)
    if (node !== undefined) parts.push(`at node "${node.title}"`)
    parts.push(`${error.code}: ${error.message}`)
  }
  return parts.join(' ')
}

/** The tool-facing description of a flow's inputs and outputs. */
function describeFlow(flow: FlowDocument): { parameters: VarField[]; outputFields: VarField[]; endMode: 'variables' | 'text' } {
  const { inputs, outputs } = flowInterface(flow)
  const textOnly = outputs.length === 1 && outputs[0]?.name === 'text'
  return { parameters: inputs, outputFields: textOnly ? [] : outputs, endMode: textOnly ? 'text' : 'variables' }
}
