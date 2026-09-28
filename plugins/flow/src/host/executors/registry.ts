/**
 * The executor registry: one executor per executable node type, keyed by the
 * node's `type` discriminant.
 *
 * @module @dsh-plugins/flow/host/executors/registry
 */

import type { FlowNode, NodeType } from '../../spec/types.ts'
import type { NodeExecutor } from './index.ts'
import { aggregateExecutor } from './aggregate.ts'
import { agentExecutor } from './agent.ts'
import { batchExecutor } from './batch.ts'
import { codeExecutor } from './code.ts'
import { conditionExecutor } from './condition.ts'
import { assignExecutor, breakExecutor, continueExecutor } from './control.ts'
import { httpExecutor } from './http.ts'
import { intentExecutor } from './intent.ts'
import { jsonExecutor } from './json.ts'
import { llmExecutor } from './llm.ts'
import { loopExecutor } from './loop.ts'
import { messageExecutor } from './message.ts'
import { questionExecutor } from './question.ts'
import { subflowExecutor } from './subflow.ts'
import { textExecutor } from './text.ts'
import { toolExecutor } from './tool.ts'

/** The executor registry, keyed by node type. */
export const EXECUTORS: Record<string, NodeExecutor> = {
  llm: llmExecutor,
  intent: intentExecutor,
  agent: agentExecutor,
  condition: conditionExecutor,
  code: codeExecutor,
  http: httpExecutor,
  tool: toolExecutor,
  text: textExecutor,
  json: jsonExecutor,
  aggregate: aggregateExecutor,
  loop: loopExecutor,
  batch: batchExecutor,
  break: breakExecutor,
  continue: continueExecutor,
  assign: assignExecutor,
  subflow: subflowExecutor,
  question: questionExecutor,
  message: messageExecutor,
}

/** Build a node-type -> executor map for a flow. */
export function buildExecutors(): Record<string, NodeExecutor> {
  return { ...EXECUTORS }
}

/** Whether a node type has an executor. */
export function hasExecutor(type: NodeType): boolean {
  return EXECUTORS[type] !== undefined
}

/** Look up an executor for a node. */
export function executorFor(node: FlowNode): NodeExecutor | undefined {
  return EXECUTORS[node.type]
}
