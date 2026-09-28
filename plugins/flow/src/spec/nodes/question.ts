/**
 * question node spec: pause for a human answer (text or options).
 *
 * @module @dsh-plugins/flow/spec/nodes/question
 */

import type { FlowNode, Issue, NodeSpec, PortSpec } from '../types.ts'
import { ID_PATTERN, NAME_PATTERN } from '../types.ts'

type QuestionNode = Extract<FlowNode, { type: 'question' }>

/** The question node spec. */
export const questionSpec: NodeSpec<QuestionNode> = {
  type: 'question',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ inputs: [], question: '', answer: { kind: 'text' } }),
  hasInput: () => true,
  ports: (node): PortSpec[] => {
    if (node.data.answer.kind === 'text') return [{ id: 'next', label: 'next', kind: 'next' }]
    return [
      ...node.data.answer.options.map(option => ({ id: option.id, label: option.label, kind: 'branch' as const })),
      ...(node.data.answer.allowOther ? [{ id: 'other', label: 'other', kind: 'branch' as const }] : []),
    ]
  },
  outputs: () => [
    { name: 'answer', schema: { type: 'string' } },
    { name: 'optionId', schema: { type: 'string' } },
  ],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.question.trim() === '') {
      issues.push({ severity: 'error', code: 'REQUIRED_INPUT', message: 'question text is required', nodeId: node.id, field: 'question' })
    }
    if (node.data.answer.kind === 'options') {
      const seen = new Set<string>()
      for (const option of node.data.answer.options) {
        if (!ID_PATTERN.test(option.id)) {
          issues.push({ severity: 'error', code: 'BAD_ID', message: `option id "${option.id}" is not valid`, nodeId: node.id, field: `answer.options.${option.id}` })
        }
        if (seen.has(option.id)) {
          issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate option id "${option.id}"`, nodeId: node.id, field: `answer.options.${option.id}` })
        }
        seen.add(option.id)
      }
    }
    const seen = new Set<string>()
    for (const binding of node.data.inputs) {
      if (!NAME_PATTERN.test(binding.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `question input "${binding.name}" is not a valid name`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      if (seen.has(binding.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate question input "${binding.name}"`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      seen.add(binding.name)
    }
    void ctx
    return issues
  },
}
