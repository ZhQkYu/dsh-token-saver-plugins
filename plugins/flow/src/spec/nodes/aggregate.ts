/**
 * aggregate node spec: pick the first non-null candidate per group.
 *
 * @module @dsh-plugins/flow/spec/nodes/aggregate
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'

type AggregateNode = Extract<FlowNode, { type: 'aggregate' }>

/** The aggregate node spec. */
export const aggregateSpec: NodeSpec<AggregateNode> = {
  type: 'aggregate',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ groups: [] }),
  hasInput: () => true,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: (node) => node.data.groups.map(group => ({ name: group.name, schema: group.schema })),
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    const seen = new Set<string>()
    for (const group of node.data.groups) {
      if (!NAME_PATTERN.test(group.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `aggregate group "${group.name}" is not a valid name`, nodeId: node.id, field: `groups.${group.name}` })
      }
      if (seen.has(group.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate aggregate group "${group.name}"`, nodeId: node.id, field: `groups.${group.name}` })
      }
      if (group.candidates.length === 0) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `aggregate group "${group.name}" has no candidates`, nodeId: node.id, field: `groups.${group.name}.candidates` })
      }
      seen.add(group.name)
    }
    void ctx
    return issues
  },
}
