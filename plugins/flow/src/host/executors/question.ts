/**
 * question executor: pause for a human answer (text or options). The answer
 * fires the matching option port (`next` for text, option id or `other`).
 *
 * @module @dsh-plugins/flow/host/executors/question
 */

import type { FlowNode } from '../../spec/types.ts'
import { renderTemplate } from '../../spec/template.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'
import { resolveInputs } from './resolve.ts'

type QuestionNode = Extract<FlowNode, { type: 'question' }>

/** The question executor. */
export const questionExecutor: NodeExecutor<QuestionNode> = {
  type: 'question',
  async execute(node, _inputs, ctx): Promise<ExecResult> {
    const values = resolveInputs(node, ctx.frame)
    const question = renderTemplate(node.data.question, values).text
    const answerSpec = node.data.answer
    const answer = await ctx.interaction.ask(ctx.execKey, question, answerSpec, ctx.signal)
    if (answerSpec.kind === 'text') {
      return { outputs: { answer: answer.text ?? '', optionId: null }, firedPorts: ['next'] }
    }
    const optionId = answer.optionId ?? null
    let firedPort = 'other'
    if (optionId !== null && answerSpec.options.some(option => option.id === optionId)) {
      firedPort = optionId
    } else if (optionId !== null && answerSpec.allowOther) {
      firedPort = 'other'
    } else if (optionId === null) {
      // No option selected; if allowOther, route to other with the text as the answer.
      if (answerSpec.allowOther) firedPort = 'other'
      else throw new NodeError('QUESTION_NO_ANSWER', 'no option selected')
    }
    return { outputs: { answer: answer.text ?? '', optionId }, firedPorts: [firedPort] }
  },
}
