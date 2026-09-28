/**
 * Localized issue text: the issue code's message, or a more specific hint
 * for codes the validator reuses across different problems.
 *
 * @module @dsh-plugins/flow-ui/client/editor/issues
 */

import type { Issue } from '@dsh-plugins/flow/spec'
import type { LocaleKey, Translate } from '../locales.ts'

const FIELD_NAMES: ReadonlySet<string> = new Set([
  'prompt', 'system', 'query', 'url', 'template', 'question', 'code', 'tool', 'flowId',
  'inputs', 'args', 'fields', 'outputs', 'branches', 'intents', 'groups', 'variables', 'assignments', 'array', 'count',
])

/**
 * The localized text for an issue.
 * @param issue - the validation issue.
 * @param t - the translator.
 * @returns the message.
 */
export function issueText(issue: Issue, t: Translate): string {
  const field = issue.field ?? ''
  if (issue.code === 'BAD_NAME') {
    if (field === 'branches') return t('issueHint.needBranch')
    if (field === 'intents') return t('issueHint.needIntent')
    if (field.endsWith('.conditions')) return t('issueHint.needCondition')
    if (field.endsWith('.candidates')) return t('issueHint.needCandidate')
    if (field.endsWith('.label')) return t('issueHint.needLabel')
  }
  return t(`issue.${issue.code}` as LocaleKey)
}

/**
 * The localized location of an issue within its node, e.g. `提示词` or `输入 topic`.
 * @param issue - the validation issue.
 * @param t - the translator.
 * @returns the location, or `''` when the issue has none.
 */
export function issueField(issue: Issue, t: Translate): string {
  if (issue.field === undefined) return ''
  const [head = '', ...rest] = issue.field.split('.')
  if (!FIELD_NAMES.has(head)) return issue.field
  return [t(`fieldName.${head}` as LocaleKey), ...rest.filter(part => !/^\d+$/.test(part))].join(' ')
}
