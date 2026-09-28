/**
 * condition node spec: multi-branch selector with AND/OR and operator tests.
 *
 * @module @dsh-plugins/flow/spec/nodes/condition
 */

import type { FlowNode, Issue, NodeSpec, PortSpec } from '../types.ts'
import { CONDITION_OPS, ID_PATTERN } from '../types.ts'

type ConditionNode = Extract<FlowNode, { type: 'condition' }>

/** The condition node spec. */
export const conditionSpec: NodeSpec<ConditionNode> = {
  type: 'condition',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ branches: [] }),
  hasInput: () => true,
  ports: (node): PortSpec[] => [
    ...node.data.branches.map(branch => ({ id: branch.id, label: branch.label, kind: 'branch' as const })),
    { id: 'else', label: 'else', kind: 'branch' },
  ],
  outputs: () => [{ name: 'branch', schema: { type: 'string' } }],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.branches.length === 0) {
      issues.push({ severity: 'error', code: 'BAD_NAME', message: 'condition node requires at least one branch', nodeId: node.id, field: 'branches' })
    }
    if (node.data.branches.length > 8) {
      issues.push({ severity: 'error', code: 'BAD_LIMIT', message: 'condition node supports at most 8 branches', nodeId: node.id, field: 'branches' })
    }
    const seen = new Set<string>()
    for (const [index, branch] of node.data.branches.entries()) {
      if (!ID_PATTERN.test(branch.id)) {
        issues.push({ severity: 'error', code: 'BAD_ID', message: `branch id "${branch.id}" is not valid`, nodeId: node.id, field: `branches.${index}.id` })
      }
      if (seen.has(branch.id)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate branch id "${branch.id}"`, nodeId: node.id, field: `branches.${index}.id` })
      }
      seen.add(branch.id)
      if (branch.label.trim() === '') {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `branch ${index + 1} label must not be empty`, nodeId: node.id, field: `branches.${index}.label` })
      }
      if (branch.conditions.length === 0) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `branch "${branch.id}" has no conditions`, nodeId: node.id, field: `branches.${index}.conditions` })
      }
      for (const [condIndex, condition] of branch.conditions.entries()) {
        if (!(CONDITION_OPS as readonly string[]).includes(condition.op)) {
          issues.push({ severity: 'error', code: 'BAD_NAME', message: `unknown operator "${condition.op}"`, nodeId: node.id, field: `branches.${index}.conditions.${condIndex}.op` })
        }
      }
    }
    void ctx
    return issues
  },
}
