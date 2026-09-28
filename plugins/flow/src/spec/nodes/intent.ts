/**
 * intent node spec: classify a query into named intents via an LLM.
 *
 * @module @dsh-plugins/flow/spec/nodes/intent
 */

import type { FlowNode, Issue, NodeSpec, PortSpec } from '../types.ts'
import { ID_PATTERN, NAME_PATTERN } from '../types.ts'

type IntentNode = Extract<FlowNode, { type: 'intent' }>

/** The intent node spec. */
export const intentSpec: NodeSpec<IntentNode> = {
  type: 'intent',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ inputs: [], query: '', intents: [] }),
  hasInput: () => true,
  ports: (node): PortSpec[] => [
    ...node.data.intents.map(intent => ({ id: intent.id, label: intent.label, kind: 'branch' as const })),
    { id: 'other', label: 'other', kind: 'branch' },
  ],
  outputs: () => [
    { name: 'intent', schema: { type: 'string' } },
    { name: 'intentId', schema: { type: 'string' } },
    { name: 'reason', schema: { type: 'string' } },
  ],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.intents.length === 0) {
      issues.push({ severity: 'error', code: 'BAD_NAME', message: 'intent node requires at least one intent', nodeId: node.id, field: 'intents' })
    }
    if (node.data.intents.length > 20) {
      issues.push({ severity: 'error', code: 'BAD_LIMIT', message: 'intent node supports at most 20 intents', nodeId: node.id, field: 'intents' })
    }
    const seen = new Set<string>()
    for (const intent of node.data.intents) {
      if (!ID_PATTERN.test(intent.id)) {
        issues.push({ severity: 'error', code: 'BAD_ID', message: `intent id "${intent.id}" is not valid`, nodeId: node.id, field: `intents.${intent.id}` })
      }
      if (!NAME_PATTERN.test(intent.label) && intent.label === '') {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: 'intent label must not be empty', nodeId: node.id, field: `intents.${intent.id}.label` })
      }
      if (seen.has(intent.id)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate intent id "${intent.id}"`, nodeId: node.id, field: `intents.${intent.id}` })
      }
      seen.add(intent.id)
    }
    void ctx
    return issues
  },
}
