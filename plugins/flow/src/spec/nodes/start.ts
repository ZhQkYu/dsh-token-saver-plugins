/**
 * start node spec: declares the run input fields.
 *
 * @module @dsh-plugins/flow/spec/nodes/start
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'

type StartNode = Extract<FlowNode, { type: 'start' }>

/** The start node spec. */
export const startSpec: NodeSpec<StartNode> = {
  type: 'start',
  executable: true,
  container: false,
  allowedParents: ['root'],
  defaults: () => ({ fields: [] }),
  hasInput: () => false,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: (node) => node.data.fields.map(field => ({ name: field.name, schema: field.schema, ...(field.required === undefined ? {} : { required: field.required }) })),
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    const seen = new Set<string>()
    for (const field of node.data.fields) {
      if (!NAME_PATTERN.test(field.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `start field "${field.name}" is not a valid name`, nodeId: node.id, field: `fields.${field.name}` })
      }
      if (seen.has(field.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate start field "${field.name}"`, nodeId: node.id, field: `fields.${field.name}` })
      }
      seen.add(field.name)
    }
    void ctx
    return issues
  },
}
