/**
 * end executor: produce the run result. `variables` mode passes the resolved
 * inputs through unchanged (name is the output name); `text` mode renders the
 * template against the inputs and emits `{ text }` with template warnings.
 *
 * @module @dsh-plugins/flow/host/executors/end
 */

import type { FlowNode } from '../../spec/types.ts'
import { renderTemplate } from '../../spec/template.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type EndNode = Extract<FlowNode, { type: 'end' }>

/** The end executor. */
export const endExecutor: NodeExecutor<EndNode> = {
  type: 'end',
  async execute(node, inputs, _ctx): Promise<ExecResult> {
    if (node.data.mode === 'text') {
      const rendered = renderTemplate(node.data.template ?? '', inputs)
      return { outputs: { text: rendered.text }, ...(rendered.warnings.length > 0 ? { warnings: rendered.warnings } : {}) }
    }
    // variables mode: the input names are the output names.
    return { outputs: inputs }
  },
}
