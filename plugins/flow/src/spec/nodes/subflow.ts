/**
 * subflow node spec: run another flow (published or draft) as a sub-step.
 *
 * @module @dsh-plugins/flow/spec/nodes/subflow
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'
import { ID_PATTERN, NAME_PATTERN } from '../types.ts'

type SubflowNode = Extract<FlowNode, { type: 'subflow' }>

/** The subflow node spec. */
export const subflowSpec: NodeSpec<SubflowNode> = {
  type: 'subflow',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ flowId: '', version: 'published', inputs: [] }),
  hasInput: () => true,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: (node, lookup) => {
    const resolved = lookup(node.data.flowId, node.data.version)
    return resolved?.outputs ?? []
  },
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (!ID_PATTERN.test(node.data.flowId)) {
      issues.push({ severity: 'error', code: 'SUBFLOW_MISSING', message: `subflow id "${node.data.flowId}" is not valid`, nodeId: node.id, field: 'flowId' })
    } else if (ctx.lookup(node.data.flowId, node.data.version) === undefined) {
      issues.push({ severity: 'error', code: 'SUBFLOW_MISSING', message: `subflow "${node.data.flowId}" is not available as ${node.data.version}`, nodeId: node.id, field: 'flowId' })
    }
    const seen = new Set<string>()
    for (const binding of node.data.inputs) {
      if (!NAME_PATTERN.test(binding.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `subflow input "${binding.name}" is not a valid name`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      if (seen.has(binding.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate subflow input "${binding.name}"`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      seen.add(binding.name)
    }
    return issues
  },
}
