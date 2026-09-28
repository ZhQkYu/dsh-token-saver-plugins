/**
 * The node inspector: what the node does, its problems, its title, the
 * point-and-click settings form, failure handling, and a collapsed JSON view
 * for advanced edits. Every edit produces a new node that the editor writes
 * back into the document.
 *
 * @module @dsh-plugins/flow-ui/client/editor/forms
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FlowNode, Issue } from '@dsh-plugins/flow/spec'
import type { LocaleKey, Translate } from '../locales.ts'
import { issueField, issueText } from './issues.ts'
import { ErrorPolicyForm, NodeForm, type FormContext } from './node-forms.tsx'

/** Props for {@link NodeInspector}. */
export interface NodeInspectorProps {
  node: FlowNode
  ctx: FormContext
  issues: readonly Issue[]
  onChange(next: FlowNode): void
  onDelete(): void
}

/** The inspector for the selected node. */
export function NodeInspector({ node, ctx, issues, onChange, onDelete }: NodeInspectorProps): ReactNode {
  const { t } = ctx
  return (
    <div className="dsflow-form">
      <div className="dsflow-inspector__head">
        <span className="dsflow-type-badge" data-node-type={node.type}>{t(`nodeType.${node.type}` as LocaleKey)}</span>
        <input className="dsflow-input dsflow-inspector__title" aria-label={t('title')} value={node.title} maxLength={200} onChange={(event) => { onChange({ ...node, title: event.target.value }) }} />
      </div>
      <div className="dsflow-hint">{t(`nodeHelp.${node.type}` as LocaleKey)}</div>
      {issues.length > 0 && (
        <ul className="dsflow-issues">
          {issues.map((issue, index) => (
            <li key={index} data-severity={issue.severity} title={issue.message}>
              {issueText(issue, t)}{issueField(issue, t) === '' ? '' : ` · ${issueField(issue, t)}`}
            </li>
          ))}
        </ul>
      )}
      <NodeForm node={node} ctx={ctx} onChange={onChange} />
      <ErrorPolicyForm node={node} t={t} onChange={onChange} />
      <details className="dsflow-advanced">
        <summary>{t('moreSettings')}</summary>
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('description')}</span>
          <input className="dsflow-input" value={node.description ?? ''} maxLength={2000} onChange={(event) => { onChange({ ...node, description: event.target.value }) }} />
        </label>
        <DataEditor node={node} t={t} onChange={onChange} />
      </details>
      <Button variant="ghost" className="dsflow-danger" onClick={onDelete}>{t('deleteNode')}</Button>
    </div>
  )
}

/** The node settings as JSON: edited as local text and applied explicitly, so intermediate invalid JSON never reverts the input. */
function DataEditor({ node, t, onChange }: { node: FlowNode; t: Translate; onChange(next: FlowNode): void }): ReactNode {
  const serialized = useMemo(() => JSON.stringify({ data: node.data, ...(node.onError === undefined ? {} : { onError: node.onError }) }, null, 2), [node.data, node.onError])
  const [text, setText] = useState(serialized)
  const [error, setError] = useState('')
  useEffect(() => { setText(serialized); setError('') }, [node.id, serialized])
  const apply = (): void => {
    try {
      const parsed = JSON.parse(text) as { data?: unknown; onError?: unknown }
      if (parsed === null || typeof parsed !== 'object' || parsed.data === undefined || typeof parsed.data !== 'object') throw new Error('expected { "data": { … } }')
      const { onError: _dropped, ...rest } = node
      const next = { ...rest, data: parsed.data, ...(parsed.onError === undefined ? {} : { onError: parsed.onError }) } as FlowNode
      onChange(next)
      setError('')
    } catch (caught: unknown) {
      setError(`${t('invalidJson')}${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }
  return (
    <div className="dsflow-field">
      <span className="dsflow-field__label">{t('nodeData')}</span>
      <textarea
        className="dsflow-textarea dsflow-textarea--mono"
        value={text}
        spellCheck={false}
        onChange={(event) => { setText(event.target.value) }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); apply() }
        }}
      />
      {error !== '' && <div className="dsflow-error">{error}</div>}
      <Button variant="outline" size="sm" disabled={text === serialized} onClick={apply}>{t('apply')}</Button>
    </div>
  )
}
