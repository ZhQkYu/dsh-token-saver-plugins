/**
 * message node spec: emit a message during a run.
 *
 * @module @dsh-plugins/flow/spec/nodes/message
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'

type MessageNode = Extract<FlowNode, { type: 'message' }>

/** The message node spec. */
export const messageSpec: NodeSpec<MessageNode> = {
  type: 'message',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ inputs: [], template: '' }),
  hasInput: () => true,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: () => [{ name: 'text', schema: { type: 'string' } }],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.template.trim() === '') {
      issues.push({ severity: 'error', code: 'REQUIRED_INPUT', message: 'message template is required', nodeId: node.id, field: 'template' })
    }
    const seen = new Set<string>()
    for (const binding of node.data.inputs) {
      if (!NAME_PATTERN.test(binding.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `message input "${binding.name}" is not a valid name`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      if (seen.has(binding.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate message input "${binding.name}"`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      seen.add(binding.name)
    }
    void ctx
    return issues
  },
}
