/**
 * The publish dialog: version note and the opt-in "offer as a tool" settings.
 * Publishing never enables the tool by default; the tool name is checked
 * against the spec pattern before the request is sent.
 *
 * @module @dsh-plugins/flow-ui/client/editor/PublishDialog
 */

import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { FLOW_TOOL_NAME_PATTERN } from '@dsh-plugins/flow/spec'
import type { FlowMeta } from '../api.ts'
import type { Translate } from '../locales.ts'

/** What the dialog submits. */
export interface PublishRequest {
  note: string
  tool?: { enabled: boolean; name: string; description: string }
}

/** Props for {@link PublishDialog}. */
export interface PublishDialogProps {
  t: Translate
  meta: FlowMeta | null
  busy: boolean
  error: string
  onSubmit(request: PublishRequest): void
  onCancel(): void
}

/** The publish dialog. */
export function PublishDialog({ t, meta, busy, error, onSubmit, onCancel }: PublishDialogProps): ReactNode {
  const [note, setNote] = useState('')
  const [asTool, setAsTool] = useState(meta?.tool?.enabled === true)
  const [name, setName] = useState(meta?.tool?.name ?? '')
  const [description, setDescription] = useState(meta?.tool?.description ?? '')
  const nameValid = FLOW_TOOL_NAME_PATTERN.test(name)
  const submit = (): void => {
    onSubmit({
      note,
      // Sending the previous name with enabled=false keeps it reserved while turning the tool off.
      ...(asTool || meta?.tool !== undefined ? { tool: { enabled: asTool, name: asTool ? name : meta?.tool?.name ?? name, description } } : {}),
    })
  }
  return (
    <div className="dsflow-dialog" role="dialog" aria-label={t('publishTitle')}>
      <div className="dsflow-dialog__panel">
        <div className="dsflow-dialog__title">{t('publishTitle')}</div>
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('publishNote')}</span>
          <input className="dsflow-input" value={note} maxLength={2000} onChange={event => { setNote(event.target.value) }} />
        </label>
        <label className="dsflow-check">
          <input type="checkbox" checked={asTool} onChange={event => { setAsTool(event.target.checked) }} />
          {t('asTool')}
        </label>
        {asTool && (
          <>
            <label className="dsflow-field">
              <span className="dsflow-field__label">{t('toolName')}</span>
              <input className="dsflow-input" aria-invalid={!nameValid} value={name} maxLength={41} onChange={event => { setName(event.target.value) }} />
              <span className={nameValid ? 'dsflow-muted' : 'dsflow-error'}>{t('toolNameHint')}</span>
            </label>
            <label className="dsflow-field">
              <span className="dsflow-field__label">{t('toolDescription')}</span>
              <textarea className="dsflow-textarea dsflow-textarea--short" value={description} maxLength={2000} onChange={event => { setDescription(event.target.value) }} />
            </label>
          </>
        )}
        {error !== '' && <div className="dsflow-error">{error}</div>}
        <div className="dsflow-dialog__actions">
          <Button variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || (asTool && !nameValid)} onClick={submit}>{t('publish')}</Button>
        </div>
      </div>
    </div>
  )
}
