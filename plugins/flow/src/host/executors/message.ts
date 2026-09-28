/**
 * message executor: render a template and emit a `run.message` event.
 *
 * @module @dsh-plugins/flow/host/executors/message
 */

import type { FlowNode } from '../../spec/types.ts'
import { renderTemplate } from '../../spec/template.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type MessageNode = Extract<FlowNode, { type: 'message' }>

/** The message executor. */
export const messageExecutor: NodeExecutor<MessageNode> = {
  type: 'message',
  async execute(node, inputs, ctx): Promise<ExecResult> {
    const values = inputs
    const rendered = renderTemplate(node.data.template, values)
    ctx.emitMessage(rendered.text)
    return { outputs: { text: rendered.text }, ...(rendered.warnings.length > 0 ? { warnings: rendered.warnings } : {}) }
  },
}
