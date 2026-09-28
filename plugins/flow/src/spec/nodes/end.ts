/**
 * end node spec: produces the run result (variables or text).
 *
 * @module @dsh-plugins/flow/spec/nodes/end
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'

type EndNode = Extract<FlowNode, { type: 'end' }>

/** The end node spec. */
export const endSpec: NodeSpec<EndNode> = {
  type: 'end',
  executable: true,
  container: false,
  allowedParents: ['root'],
  defaults: () => ({ mode: 'variables', inputs: [] }),
  hasInput: () => true,
  ports: () => [],
  outputs: () => [],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.mode === 'text' && (node.data.template === undefined || node.data.template === '')) {
      issues.push({ severity: 'error', code: 'REQUIRED_INPUT', message: 'end text mode requires a template', nodeId: node.id, field: 'template' })
    }
    const seen = new Set<string>()
    for (const binding of node.data.inputs) {
      if (!NAME_PATTERN.test(binding.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `end input "${binding.name}" is not a valid name`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      if (seen.has(binding.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate end input "${binding.name}"`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      seen.add(binding.name)
    }
    void ctx
    return issues
  },
}
