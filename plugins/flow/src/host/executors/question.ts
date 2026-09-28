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

type QuestionNode = Extract<FlowNode, { type: 'question' }>

/** The question executor. */
export const questionExecutor: NodeExecutor<QuestionNode> = {
  type: 'question',
  async execute(node, inputs, ctx): Promise<ExecResult> {
    const values = inputs
    const question = renderTemplate(node.data.question, values).text
    const answerSpec = node.data.answer
    // Only a node-level timeout bounds the wait; otherwise the run's own duration limit does.
    const timeoutMs = node.data.timeoutMs === undefined ? undefined : Math.min(node.data.timeoutMs, ctx.limits.maxNodeTimeoutMs)
    const timeoutSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
    const waitSignal = timeoutSignal === undefined ? ctx.signal : AbortSignal.any([ctx.signal, timeoutSignal])
    let answer: { text?: string; optionId?: string }
    try {
      answer = await ctx.interaction.ask(ctx.execKey, question, answerSpec, waitSignal)
    } catch (error: unknown) {
      if (timeoutSignal?.aborted === true && !ctx.signal.aborted) {
        throw new NodeError('QUESTION_TIMEOUT', `question was not answered within ${timeoutMs}ms`, false)
      }
      throw error
    }
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
      if (answerSpec.allowOther) firedPort = 'other'
      else throw new NodeError('QUESTION_NO_ANSWER', 'no option selected')
    }
    return { outputs: { answer: answer.text ?? '', optionId }, firedPorts: [firedPort] }
  },
}
