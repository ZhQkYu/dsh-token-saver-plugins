/**
 * agent node spec: delegate a task to a child Agent with tools.
 *
 * @module @dsh-plugins/flow/spec/nodes/agent
 */

import type { FlowNode, Issue, NodeSpec, VarField } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'
import { validateFields } from './llm.ts'

type AgentNode = Extract<FlowNode, { type: 'agent' }>

/** The agent node spec. */
export const agentSpec: NodeSpec<AgentNode> = {
  type: 'agent',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ inputs: [], prompt: '' }),
  hasInput: () => true,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: (node): VarField[] => node.data.outputs === undefined
    ? [{ name: 'text', schema: { type: 'string' } }]
    : node.data.outputs,
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.prompt.trim() === '') {
      issues.push({ severity: 'error', code: 'REQUIRED_INPUT', message: 'agent prompt is required', nodeId: node.id, field: 'prompt' })
    }
    const seen = new Set<string>()
    for (const binding of node.data.inputs) {
      if (!NAME_PATTERN.test(binding.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `agent input "${binding.name}" is not a valid name`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      if (seen.has(binding.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate agent input "${binding.name}"`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      seen.add(binding.name)
    }
    if (node.data.outputs !== undefined) validateFields(node.data.outputs, node.id, issues)
    void ctx
    return issues
  },
}
