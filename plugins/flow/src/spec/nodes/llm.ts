/**
 * llm node spec: a model call with text or JSON output.
 *
 * @module @dsh-plugins/flow/spec/nodes/llm
 */

import type { FlowNode, Issue, NodeSpec, VarField } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'

type LlmNode = Extract<FlowNode, { type: 'llm' }>

/** The llm node spec. */
export const llmSpec: NodeSpec<LlmNode> = {
  type: 'llm',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ inputs: [], system: '', prompt: '', output: { format: 'text' } }),
  hasInput: () => true,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: (node) => node.data.output.format === 'json'
    ? node.data.output.fields
    : [{ name: 'text', schema: { type: 'string' } }],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.prompt.trim() === '') {
      issues.push({ severity: 'error', code: 'REQUIRED_INPUT', message: 'llm prompt is required', nodeId: node.id, field: 'prompt' })
    }
    const seen = new Set<string>()
    for (const binding of node.data.inputs) {
      if (!NAME_PATTERN.test(binding.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `llm input "${binding.name}" is not a valid name`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      if (seen.has(binding.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate llm input "${binding.name}"`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      seen.add(binding.name)
    }
    if (node.data.output.format === 'json') validateFields(node.data.output.fields, node.id, issues)
    void ctx
    return issues
  },
}

/** Validate a set of VarFields: names must be valid and unique. */
export function validateFields(fields: readonly VarField[], nodeId: string, issues: Issue[]): void {
  const seen = new Set<string>()
  for (const field of fields) {
    if (!NAME_PATTERN.test(field.name)) {
      issues.push({ severity: 'error', code: 'BAD_NAME', message: `output field "${field.name}" is not a valid name`, nodeId, field: `outputs.${field.name}` })
    }
    if (seen.has(field.name)) {
      issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate output field "${field.name}"`, nodeId, field: `outputs.${field.name}` })
    }
    seen.add(field.name)
  }
}
