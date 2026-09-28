/**
 * batch node spec: a container that runs its body in parallel over an array.
 *
 * @module @dsh-plugins/flow/spec/nodes/batch
 */

import type { FlowDocument, FlowNode, Issue, NodeSpec, PortSpec, VarField } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'

type BatchNode = Extract<FlowNode, { type: 'batch' }>

/** An output field of a batch node. */
function collectedOutput(output: { name: string }): VarField {
  return { name: output.name, schema: { type: 'array', items: { type: 'any' } } }
}

/** The batch node spec. */
export const batchSpec: NodeSpec<BatchNode> = {
  type: 'batch',
  executable: true,
  container: true,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ array: { kind: 'literal', value: [] }, concurrency: 4, maxItems: 100, outputs: [] }),
  hasInput: () => true,
  ports: (): PortSpec[] => [
    { id: 'next', label: 'next', kind: 'next' },
    { id: 'body', label: 'body', kind: 'body' },
  ],
  outputs: (node): VarField[] => node.data.outputs.map(collectedOutput),
  innerVars: (_node: BatchNode, _doc: FlowDocument): VarField[] => [
    { name: 'item', schema: { type: 'any' } },
    { name: 'index', schema: { type: 'integer' } },
  ],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    const seen = new Set<string>()
    for (const output of node.data.outputs) {
      if (!NAME_PATTERN.test(output.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `batch output "${output.name}" is not a valid name`, nodeId: node.id, field: `outputs.${output.name}` })
      }
      if (seen.has(output.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate batch output "${output.name}"`, nodeId: node.id, field: `outputs.${output.name}` })
      }
      seen.add(output.name)
    }
    void ctx
    return issues
  },
}
