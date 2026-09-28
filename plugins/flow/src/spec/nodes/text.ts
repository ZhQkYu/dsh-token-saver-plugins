/**
 * text node spec: concatenate (template) or split (delimiters).
 *
 * @module @dsh-plugins/flow/spec/nodes/text
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'

type TextNode = Extract<FlowNode, { type: 'text' }>

/** The text node spec. */
export const textSpec: NodeSpec<TextNode> = {
  type: 'text',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ op: 'concat', inputs: [], template: '' }),
  hasInput: () => true,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: (node) => node.data.op === 'concat'
    ? [{ name: 'text', schema: { type: 'string' } }]
    : [{ name: 'parts', schema: { type: 'array', items: { type: 'string' } } }],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.op === 'concat' && node.data.template.trim() === '') {
      issues.push({ severity: 'error', code: 'REQUIRED_INPUT', message: 'text concat requires a template', nodeId: node.id, field: 'template' })
    }
    const seen = new Set<string>()
    for (const binding of 'inputs' in node.data && node.data.inputs ? node.data.inputs : []) {
      if (!NAME_PATTERN.test(binding.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `text input "${binding.name}" is not a valid name`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      if (seen.has(binding.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate text input "${binding.name}"`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      seen.add(binding.name)
    }
    void ctx
    return issues
  },
}
