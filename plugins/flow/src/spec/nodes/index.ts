/**
 * The node spec registry: one spec per node type, keyed by type. UI forms and
 * Host validation both read from here so defaults, ports, outputs, and
 * validation rules never diverge.
 *
 * @module @dsh-plugins/flow/spec/nodes
 */

import type { FlowNode, NodeSpec, NodeType } from '../types.ts'
import { aggregateSpec } from './aggregate.ts'
import { agentSpec } from './agent.ts'
import { assignSpec } from './assign.ts'
import { batchSpec } from './batch.ts'
import { breakSpec, continueSpec } from './break-continue.ts'
import { codeSpec } from './code.ts'
import { commentSpec } from './comment.ts'
import { conditionSpec } from './condition.ts'
import { endSpec } from './end.ts'
import { httpSpec } from './http.ts'
import { intentSpec } from './intent.ts'
import { jsonSpec } from './json.ts'
import { llmSpec } from './llm.ts'
import { loopSpec } from './loop.ts'
import { messageSpec } from './message.ts'
import { questionSpec } from './question.ts'
import { startSpec } from './start.ts'
import { subflowSpec } from './subflow.ts'
import { textSpec } from './text.ts'
import { toolSpec } from './tool.ts'

/**
 * Augment a node spec so `onError=branch` adds an `error` output port and any
 * non-`fail` policy adds an `errorMessage` output variable, matching the
 * SettingOnError contract. This keeps every node spec's own ports/outputs
 * author-facing while the error surface stays uniform.
 */
function augment<N extends FlowNode>(spec: NodeSpec<N>): NodeSpec<N> {
  const basePorts = spec.ports
  const baseOutputs = spec.outputs
  return {
    ...spec,
    ports: (node) => {
      const ports = basePorts(node)
      if (node.onError?.onError === 'branch' && !ports.some(port => port.id === 'error')) {
        return [...ports, { id: 'error', label: 'error', kind: 'error' }]
      }
      return ports
    },
    outputs: (node, lookup) => {
      const outputs = baseOutputs(node, lookup)
      if (node.onError !== undefined && node.onError.onError !== 'fail' && !outputs.some(field => field.name === 'errorMessage')) {
        return [...outputs, { name: 'errorMessage', schema: { type: 'string' } }]
      }
      return outputs
    },
  }
}

/** The node spec registry. */
export const NODE_SPECS: { [T in NodeType]: NodeSpec<Extract<FlowNode, { type: T }>> } = {
  start: startSpec,
  end: endSpec,
  llm: llmSpec,
  intent: intentSpec,
  agent: agentSpec,
  condition: conditionSpec,
  code: codeSpec,
  http: httpSpec,
  tool: toolSpec,
  text: textSpec,
  json: jsonSpec,
  aggregate: aggregateSpec,
  loop: loopSpec,
  batch: batchSpec,
  break: breakSpec,
  continue: continueSpec,
  assign: assignSpec,
  subflow: subflowSpec,
  question: questionSpec,
  message: messageSpec,
  comment: commentSpec,
}

/** Look up a node spec by node type. */
export function specOf(node: FlowNode): NodeSpec<FlowNode> {
  return augment(NODE_SPECS[node.type] as NodeSpec<FlowNode>)
}
