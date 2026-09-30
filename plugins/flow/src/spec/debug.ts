/**
 * Single-node debugging: which nodes can run on their own and which inputs a
 * debug run of a node asks for. Shared by the Host engine, the editor's debug
 * panel, and the design tool so all three agree on the input list.
 *
 * @module @dsh-plugins/flow/spec/debug
 */

import type { FlowNode, JsonValue, NodeType, VarSchema } from './types.ts'
import { iterBindings } from './validate.ts'

/** Node types that only make sense inside a whole flow and cannot be debugged alone. */
export const NON_DEBUGGABLE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(['start', 'end', 'comment', 'break', 'continue', 'assign', 'loop', 'batch', 'subflow'])

/** One input of a debug run. */
export interface DebugInput {
  name: string
  schema: VarSchema
  required: boolean
  /** The configured literal value; a debug run uses it when the request omits the input. */
  literal?: JsonValue
  /** For a reference binding, the upstream `node.path` it reads in a full run. */
  ref?: string
}

/**
 * Whether a node can run on its own.
 * @param node - the node.
 * @returns true when a debug run is supported.
 */
export function isDebuggable(node: FlowNode): boolean {
  return !NON_DEBUGGABLE_TYPES.has(node.type)
}

/**
 * The inputs a debug run of a node takes: every binding, with its schema, its
 * configured literal (the default), or the upstream reference it replaces.
 * @param node - the node.
 * @returns the inputs in binding order.
 */
export function debugInputsOf(node: FlowNode): DebugInput[] {
  return iterBindings(node).map((binding) => {
    const base = { name: binding.name, schema: binding.schema, required: binding.required ?? true }
    return binding.value.kind === 'literal'
      ? { ...base, literal: binding.value.value }
      : { ...base, ref: `${binding.value.node}.${binding.value.path.join('.')}` }
  })
}
