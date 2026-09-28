/**
 * http node spec: an HTTP request with SSRF-guarded fetch.
 *
 * @module @dsh-plugins/flow/spec/nodes/http
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'
import { NAME_PATTERN } from '../types.ts'

type HttpNode = Extract<FlowNode, { type: 'http' }>

/** The http node spec. */
export const httpSpec: NodeSpec<HttpNode> = {
  type: 'http',
  executable: true,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ inputs: [], method: 'GET', url: '', headers: [], query: [], body: { kind: 'none' } }),
  hasInput: () => true,
  ports: () => [{ id: 'next', label: 'next', kind: 'next' }],
  outputs: () => [
    { name: 'status', schema: { type: 'integer' } },
    { name: 'headers', schema: { type: 'object' } },
    { name: 'body', schema: { type: 'string' } },
    { name: 'json', schema: { type: 'any' } },
  ],
  validate: (node, ctx): Issue[] => {
    const issues: Issue[] = []
    if (node.data.url.trim() === '') {
      issues.push({ severity: 'error', code: 'REQUIRED_INPUT', message: 'http url is required', nodeId: node.id, field: 'url' })
    }
    const seen = new Set<string>()
    for (const binding of node.data.inputs) {
      if (!NAME_PATTERN.test(binding.name)) {
        issues.push({ severity: 'error', code: 'BAD_NAME', message: `http input "${binding.name}" is not a valid name`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      if (seen.has(binding.name)) {
        issues.push({ severity: 'error', code: 'DUPLICATE_NAME', message: `duplicate http input "${binding.name}"`, nodeId: node.id, field: `inputs.${binding.name}` })
      }
      seen.add(binding.name)
    }
    void ctx
    return issues
  },
}
