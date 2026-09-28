/**
 * code executor: run user TypeScript in a sandboxed Node process via
 * `ptcRuntime`. Input data is passed only through the `flow.params` binding;
 * never spliced into the source.
 *
 * @module @dsh-plugins/flow/host/executors/code
 */

import type { FlowNode, JsonValue } from '../../spec/types.ts'
import { coerce } from '../../spec/coerce.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type CodeNode = Extract<FlowNode, { type: 'code' }>

/** The default code template. */
export const DEFAULT_CODE = 'async function main({ params }: { params: Record<string, any> }) {\n  return { result: params.input }\n}'

/** The code executor. */
export const codeExecutor: NodeExecutor<CodeNode> = {
  type: 'code',
  requires: ['ptcRuntime'],
  async execute(node, inputs, ctx): Promise<ExecResult> {
    const runtime = ctx.services.ptc
    if (runtime === undefined) throw new NodeError('SERVICE_UNAVAILABLE', 'code node requires the ptcRuntime service')
    if (runtime.language !== 'typescript') {
      throw new NodeError('CODE_RUNTIME', `unsupported runtime language ${runtime.language}`)
    }
    const program = `${node.data.code}\n;return await main({ params: await flow.params({}) })`
    const policy = ctx.services.sandboxPolicy?.resolve({ mode: ctx.limits.code.sandboxMode }) ?? {}
    let spec: unknown
    try {
      spec = runtime.resolve({
        program,
        bindings: [{ global: 'flow', functions: { params: async () => inputs } }],
        cwd: ctx.workspacePath,
        timeoutMs: Math.min(node.data.timeoutMs ?? ctx.limits.code.timeoutMs, ctx.limits.maxNodeTimeoutMs),
        sandboxPolicy: { ...policy, workspaceRoot: ctx.workspacePath },
        signal: ctx.signal,
      })
    } catch (error: unknown) {
      throw new NodeError('CODE_RUNTIME', error instanceof Error ? error.message : String(error))
    }
    let result: { value?: JsonValue; logs: string[]; error?: { kind: string; message: string } }
    try {
      result = await runtime.run(spec)
    } catch (error: unknown) {
      throw new NodeError('CODE_RUNTIME', error instanceof Error ? error.message : String(error))
    }
    if (result.error !== undefined) {
      const kind = result.error.kind.toUpperCase().replace(/-/g, '_')
      if (result.error.kind === 'abort') {
        // Aborted by the node signal: classify as cancellation at the scheduler.
        throw new NodeError('CODE_ABORT', result.error.message, false)
      }
      throw new NodeError(`CODE_${kind}`, result.error.message, result.error.kind === 'worker-exit')
    }
    if (result.value === undefined || result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) {
      throw new NodeError('CODE_OUTPUT', 'code must return an object')
    }
    const outputs: Record<string, JsonValue> = {}
    for (const field of node.data.outputs) {
      const value = (result.value as Record<string, unknown>)[field.name]
      const coerced = coerce(value ?? null, field.schema)
      if (!coerced.ok) throw new NodeError('CODE_OUTPUT', `output field "${field.name}": ${coerced.reason}`)
      outputs[field.name] = coerced.value
    }
    return { outputs, ...(result.logs.length > 0 ? { logs: result.logs } : {}) }
  },
}
