/**
 * One-line summaries shown on canvas node cards, so a flow reads without
 * opening every node.
 *
 * @module @dsh-plugins/flow-ui/client/editor/summary
 */

import type { FlowNode } from '@dsh-plugins/flow/spec'
import type { LocaleKey, Translate } from '../locales.ts'

const EXCERPT_CHARS = 42

function excerpt(text: string | undefined): string {
  const line = (text ?? '').split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS)}…` : line
}

function names(t: Translate, key: LocaleKey, list: readonly string[]): string {
  return list.length === 0 ? '' : `${t(key)}: ${list.join(', ')}`
}

/**
 * The summary lines for a node card; empty strings are dropped.
 * @param node - the node.
 * @param t - the translator.
 * @param flowName - resolves a subflow id to its name.
 * @returns up to two short lines.
 */
export function nodeSummary(node: FlowNode, t: Translate, flowName: (flowId: string) => string | undefined): string[] {
  const lines = ((): string[] => {
    switch (node.type) {
      case 'start': return [names(t, 'summary.inputs', node.data.fields.map(field => field.name)) || t('summary.noInputs')]
      case 'end': return node.data.mode === 'text' ? [excerpt(node.data.template)] : [names(t, 'summary.outputs', node.data.inputs.map(binding => binding.name)) || t('summary.noOutputs')]
      case 'llm': return [excerpt(node.data.prompt) || t('summary.noPrompt'), node.data.output.format === 'json' ? names(t, 'summary.outputs', node.data.output.fields.map(field => field.name)) : '']
      case 'intent': return [excerpt(node.data.query) || t('summary.noPrompt')]
      case 'agent': return [excerpt(node.data.prompt) || t('summary.noPrompt')]
      case 'code': return [names(t, 'summary.outputs', node.data.outputs.map(field => field.name))]
      case 'http': return [`${node.data.method} ${excerpt(node.data.url)}`]
      case 'tool': return [node.data.tool || t('summary.noTool')]
      case 'text': return [node.data.op === 'concat' ? excerpt(node.data.template) : t('text.split')]
      case 'json': return [t(node.data.op === 'parse' ? 'json.parse' : 'json.stringify')]
      case 'aggregate': return [names(t, 'summary.outputs', node.data.groups.map(group => group.name))]
      case 'loop': return [t(`loop.mode.${node.data.mode}` as LocaleKey)]
      case 'batch': return [`${t('batch.concurrency')}: ${node.data.concurrency}`]
      case 'assign': return [node.data.assignments.map(assignment => assignment.variable).join(', ')]
      case 'subflow': return [(node.data.flowId === '' ? undefined : flowName(node.data.flowId)) ?? t('summary.noFlow')]
      case 'question': return [excerpt(node.data.question) || t('summary.noPrompt')]
      case 'message': return [excerpt(node.data.template) || t('summary.noPrompt')]
      case 'condition': case 'break': case 'continue': case 'comment': return []
    }
  })()
  return lines.filter(line => line.trim() !== '')
}
