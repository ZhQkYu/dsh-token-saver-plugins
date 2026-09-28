/**
 * Delegate a task to a child Agent through the `subagents` service and map
 * its reply onto outputs: `text`, or the requested structured fields. The
 * child is always disposed. Shared by `agent` nodes and guided subflows.
 *
 * @module @dsh-plugins/flow/host/executors/delegate
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue, ModelSelection, VarField } from '../../spec/types.ts'
import { coerce } from '../../spec/coerce.ts'
import { toObjectJsonSchema } from '../../spec/var-schema.ts'
import { NodeError } from '../engine/budget.ts'
import type { FlowServices } from './index.ts'

/** One delegated task. */
export interface DelegateRequest {
  provider: string
  label: string
  prompt: string
  parent: Agent
  signal: AbortSignal
  /** Structured result fields; absent returns `{ text }`. */
  fields?: VarField[]
  model?: ModelSelection
  /** Only these tools; absent leaves the child's tools unfiltered. */
  toolAllow?: string[]
  persona?: string
}

/**
 * Run a task in a child Agent.
 * @param subagents - the subagents service.
 * @param request - the task.
 * @returns `{ text }`, or one output per requested field.
 */
export async function delegate(subagents: NonNullable<FlowServices['subagents']>, request: DelegateRequest): Promise<Record<string, JsonValue>> {
  const { fields } = request
  const run = await subagents.start(request.provider, {
    label: request.label,
    prompt: [{ type: 'text', text: request.prompt }],
    parent: request.parent,
    signal: request.signal,
    ...(request.model === undefined ? {} : { agentOptions: { provider: request.model.provider, model: request.model.model } }),
    ...(fields === undefined ? {} : { outputSchema: toObjectJsonSchema(fields) }),
    ...(request.toolAllow === undefined ? {} : { toolFilter: { allow: request.toolAllow } }),
    ...(request.persona === undefined ? {} : { persona: request.persona }),
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') throw new NodeError('AGENT_STOPPED', result.diagnostic ?? result.stopReason)
    if (fields === undefined) {
      return { text: result.output.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') }
    }
    const structured = result.structured
    if (structured === undefined || structured === null || typeof structured !== 'object') {
      throw new NodeError('AGENT_OUTPUT', 'agent did not return structured output')
    }
    const outputs: Record<string, JsonValue> = {}
    for (const field of fields) {
      const coerced = coerce((structured as Record<string, unknown>)[field.name] ?? null, field.schema)
      if (!coerced.ok) throw new NodeError('AGENT_OUTPUT', `output field "${field.name}": ${coerced.reason}`)
      outputs[field.name] = coerced.value
    }
    return outputs
  } finally {
    await run.dispose()
  }
}
