/**
 * code node spec: run user TypeScript in a sandboxed process.
 *
 * @module @dsh-plugins/flow/spec/nodes/code
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'
import { validateFields } from './llm.ts'

type CodeNode = Extract<FlowNode, { type: 'code' }>

/** The code node spec. */
export const codeSpec: NodeSpec<CodeNode> = {
  type: 'code',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ language: 'typescript', inputs: [], code: DEFAULT_CODE, outputs: [] }),
  hasInput: () => true,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: (node) => node.data.outputs,
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.code.trim() === '') {
      issues.push({ severity: 'error', code: 'REQUIRED_INPUT', message: 'code is required', nodeId: node.id, field: 'code' })
    }
    const seen = new Set<string>()
    for (const binding of node.data.inputs) {
      if (!NAME_PATTERN.test(binding.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `code input "${binding.name}" is not a valid name`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      if (seen.has(binding.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate code input "${binding.name}"`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      seen.add(binding.name)
    }
    validateFields(node.data.outputs, node.id, issues)
    void ctx
    return issues
  },
}

/** The default code template. */
export const DEFAULT_CODE = 'async function main({ params }: { params: Record<string, any> }) {\n  return { result: params.input }\n}'
