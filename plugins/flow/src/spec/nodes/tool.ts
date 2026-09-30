/**
 * tool node spec: call a DSH-registered tool directly.
 *
 * @module @dsh-plugins/flow/spec/nodes/tool
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'

type ToolNode = Extract<FlowNode, { type: 'tool' }>

/** The tool node spec. */
export const toolSpec: NodeSpec<ToolNode> = {
  type: 'tool',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ tool: '', args: [] }),
  hasInput: () => true,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: (node) => [
    { name: 'text', schema: { type: 'string' } },
    { name: 'value', schema: node.data.outputs === undefined || node.data.outputs.length === 0 ? { type: 'any' } : { type: 'object', properties: node.data.outputs } },
  ],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.tool.trim() === '') {
      issues.push({ severity: 'error', code: 'REQUIRED_INPUT', message: 'tool name is required', nodeId: node.id, field: 'tool' })
    }
    const seen = new Set<string>()
    for (const binding of [...node.data.args, ...(node.data.inputs ?? [])]) {
      if (!NAME_PATTERN.test(binding.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `tool arg "${binding.name}" is not a valid name`, nodeId: node.id, field: `args.${binding.name}` })
      }
      if (seen.has(binding.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate tool arg "${binding.name}"`, nodeId: node.id, field: `args.${binding.name}` })
      }
      seen.add(binding.name)
    }
    void ctx
    return issues
  },
}
