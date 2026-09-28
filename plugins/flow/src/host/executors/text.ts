/**
 * text executor: concat (template) or split (delimiters). Pure functions.
 *
 * @module @dsh-plugins/flow/host/executors/text
 */

import type { FlowNode } from '../../spec/types.ts'
import { renderTemplate } from '../../spec/template.ts'
import { resolveRef } from '../engine/frames.ts'
import type { ExecResult, NodeExecutor } from './index.ts'

type TextNode = Extract<FlowNode, { type: 'text' }>

/** The text executor. */
export const textExecutor: NodeExecutor<TextNode> = {
  type: 'text',
  async execute(node, inputs, ctx): Promise<ExecResult> {
    if (node.data.op === 'concat') {
      const values = inputs
      const rendered = renderTemplate(node.data.template, values)
      return { outputs: { text: rendered.text }, ...(rendered.warnings.length > 0 ? { warnings: rendered.warnings } : {}) }
    }
    const raw = resolveRef(ctx.frame, node.data.input)
    const text = typeof raw === 'string' ? raw : raw === null ? '' : JSON.stringify(raw)
    return { outputs: { parts: splitByDelimiters(text, node.data.delimiters) } }
  },
}

function splitByDelimiters(text: string, delimiters: string[]): string[] {
  const escaped = delimiters.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(escaped.join('|'), 'g')
  return text.split(regex)
}
