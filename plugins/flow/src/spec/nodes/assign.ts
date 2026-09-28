/**
 * assign node spec: write to loop variables inside a loop body.
 *
 * @module @dsh-plugins/flow/spec/nodes/assign
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'

type AssignNode = Extract<FlowNode, { type: 'assign' }>

/** The assign node spec. */
export const assignSpec: NodeSpec<AssignNode> = {
  type: 'assign',
  executable: true,
  container: false,
  allowedParents: ['loop'],
  defaults: () => ({ assignments: [] }),
  hasInput: () => true,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: () => [],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    const seen = new Set<string>()
    for (const assignment of node.data.assignments) {
      if (!NAME_PATTERN.test(assignment.variable)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `assign variable "${assignment.variable}" is not a valid name`, nodeId: node.id, field: `assignments.${assignment.variable}` })
      }
      if (seen.has(assignment.variable)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate assign variable "${assignment.variable}"`, nodeId: node.id, field: `assignments.${assignment.variable}` })
      }
      seen.add(assignment.variable)
    }
    void ctx
    return issues
  },
}
