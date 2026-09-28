/**
 * json node spec: parse (JSON string to value) or stringify (value to text).
 *
 * @module @dsh-plugins/flow/spec/nodes/json
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'
import { validateFields } from './llm.ts'

type JsonNode = Extract<FlowNode, { type: 'json' }>

/** The json node spec. */
export const jsonSpec: NodeSpec<JsonNode> = {
  type: 'json',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ op: 'parse', input: { kind: 'literal', value: '' } }),
  hasInput: () => true,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: (node) => node.data.op === 'parse'
    ? (node.data.outputs ?? [{ name: 'value', schema: { type: 'any' } }])
    : [{ name: 'text', schema: { type: 'string' } }],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.op === 'parse' && node.data.outputs !== undefined) validateFields(node.data.outputs, node.id, issues)
    void ctx
    return issues
  },
}
