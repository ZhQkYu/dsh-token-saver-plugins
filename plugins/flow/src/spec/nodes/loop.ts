/**
 * loop node spec: a container that iterates its body, exposing inner variables.
 *
 * @module @dsh-plugins/flow/spec/nodes/loop
 */

import type { FlowDocument, FlowNode, Issue, NodeSpec, PortSpec, VarField } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'

/** An output field of a loop or batch node. */
function collectedOutput(output: { name: string }): VarField {
  return { name: output.name, schema: { type: 'array', items: { type: 'any' } } }
}

type LoopNode = Extract<FlowNode, { type: 'loop' }>

/** The loop node spec. */
export const loopSpec: NodeSpec<LoopNode> = {
  type: 'loop',
  executable: true,
  container: true,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ mode: 'array', maxIterations: 10, variables: [], outputs: [] }),
  hasInput: () => true,
  ports: (): PortSpec[] => [
    { id: 'next', label: 'next', kind: 'next' },
    { id: 'body', label: 'body', kind: 'body' },
  ],
  outputs: (node): VarField[] => [
    ...node.data.outputs.map(collectedOutput),
    ...node.data.variables.map(variable => ({ name: variable.name, schema: variable.schema })),
  ],
  innerVars: (node, _doc: FlowDocument): VarField[] => [
    { name: 'item', schema: { type: 'any' } },
    { name: 'index', schema: { type: 'integer' } },
    ...node.data.variables.map(variable => ({ name: variable.name, schema: variable.schema })),
  ],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    const seen = new Set<string>()
    for (const variable of node.data.variables) {
      if (!NAME_PATTERN.test(variable.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `loop variable "${variable.name}" is not a valid name`, nodeId: node.id, field: `variables.${variable.name}` })
      }
      if (seen.has(variable.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate loop variable "${variable.name}"`, nodeId: node.id, field: `variables.${variable.name}` })
      }
      seen.add(variable.name)
    }
    const seenOutputs = new Set<string>()
    for (const output of node.data.outputs) {
      if (!NAME_PATTERN.test(output.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `loop output "${output.name}" is not a valid name`, nodeId: node.id, field: `outputs.${output.name}` })
      }
      if (seenOutputs.has(output.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate loop output "${output.name}"`, nodeId: node.id, field: `outputs.${output.name}` })
      }
      seenOutputs.add(output.name)
    }
    void ctx
    return issues
  },
}
