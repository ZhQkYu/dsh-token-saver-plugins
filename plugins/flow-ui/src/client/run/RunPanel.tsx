/**
 * The test-run panel: workspace and input form, start/stop, live status from
 * the folded event stream, run outputs, messages, and the answer box for a
 * waiting `question` node. The folded view is reported to the editor so the
 * canvas can overlay node status and taken edges.
 *
 * @module @dsh-plugins/flow-ui/client/run/RunPanel
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AnswerSpec, FlowDocument, JsonValue, RunEvent, RunView, VarField } from '@dsh-plugins/flow/spec'
import { foldRunEvents } from '@dsh-plugins/flow/spec'
import { api, errorText, startFieldsOf, ApiError, type WorkspaceSummary } from '../api.ts'
import { followRun } from './run-stream.ts'
import type { LocaleKey, Translate } from '../locales.ts'

const WORKSPACE_KEY = 'dsh-flow.workspace'

/** Props for {@link RunPanel}. */
export interface RunPanelProps {
  doc: FlowDocument
  t: Translate
  /** Flush pending edits before the Host runs the saved draft. */
  beforeRun(): Promise<boolean>
  onView(view: RunView | undefined): void
  onIssues(issues: import('@dsh-plugins/flow/spec').Issue[]): void
}

/** The run panel. */
export function RunPanel({ doc, t, beforeRun, onView, onIssues }: RunPanelProps): ReactNode {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [workspaceId, setWorkspaceId] = useState(() => localStorage.getItem(WORKSPACE_KEY) ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [runId, setRunId] = useState<string | undefined>(undefined)
  const [view, setView] = useState<RunView | undefined>(undefined)
  const [pending, setPending] = useState<{ execKey: string; question: string; answer: AnswerSpec } | undefined>(undefined)
  const [answerText, setAnswerText] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const follow = useRef<AbortController | null>(null)

  useEffect(() => {
    api.workspaces().then((list) => {
      setWorkspaces(list)
      setWorkspaceId(current => list.some(workspace => workspace.id === current) ? current : list[0]?.id ?? '')
    }).catch((error: unknown) => { setNotice(errorText(error)) })
    return () => { follow.current?.abort() }
  }, [])
  useEffect(() => { if (workspaceId !== '') localStorage.setItem(WORKSPACE_KEY, workspaceId) }, [workspaceId])

  const fields = startFieldsOf(doc)
  const running = view !== undefined && (view.status === 'running' || view.status === 'waiting')

  const start = async (): Promise<void> => {
    setNotice('')
    let inputs: Record<string, JsonValue>
    try {
      inputs = parseInputs(fields, values)
    } catch (error: unknown) {
      setNotice(errorText(error))
      return
    }
    setBusy(true)
    try {
      if (!await beforeRun()) return
      const id = await api.startRun(doc.id, inputs, workspaceId)
      follow.current?.abort()
      const controller = new AbortController()
      follow.current = controller
      const events: RunEvent[] = []
      setRunId(id)
      setPending(undefined)
      const publish = (): void => {
        const folded = foldRunEvents(events)
        setView(folded)
        onView(folded)
      }
      publish()
      void followRun(id, (event) => {
        events.push(event)
        if (event.type === 'run.waiting') setPending({ execKey: event.execKey, question: event.question, answer: event.answer })
        if (event.type === 'run.resumed') setPending(current => current?.execKey === event.execKey ? undefined : current)
        if (event.type === 'run.finished') setPending(undefined)
        publish()
      }, controller.signal, { onReconnecting: () => { setNotice(t('reconnecting')) } }).then(() => { setNotice('') }, (error: unknown) => { setNotice(errorText(error)) })
    } catch (error: unknown) {
      if (error instanceof ApiError && error.issues !== undefined) {
        onIssues(error.issues)
        setNotice(`${t('validationFailed')} ${error.issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('; ')}`)
      } else {
        setNotice(errorText(error))
      }
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (runId === undefined) return
    try {
      await api.cancelRun(runId)
    } catch (error: unknown) {
      setNotice(errorText(error))
    }
  }

  const submitAnswer = async (answer: { text?: string; optionId?: string }): Promise<void> => {
    if (runId === undefined || pending === undefined) return
    try {
      await api.answer(runId, pending.execKey, answer)
      setAnswerText('')
    } catch (error: unknown) {
      setNotice(errorText(error))
    }
  }

  const usage = view?.usage
  return (
    <div className="dsflow-run">
      <div className="dsflow-run__bar">
        <span className="dsflow-run__title">{t('run')}</span>
        {workspaces.length === 0
          ? <span className="dsflow-muted">{t('noWorkspace')}</span>
          : (
            <select className="dsflow-input dsflow-input--narrow" aria-label={t('workspace')} value={workspaceId} onChange={event => { setWorkspaceId(event.target.value) }}>
              {workspaces.map(workspace => <option key={workspace.id} value={workspace.id} title={workspace.path}>{workspace.title}</option>)}
            </select>
          )}
        <Button variant="primary" size="sm" disabled={busy || running || workspaceId === ''} onClick={() => { void start() }}>{t('run')}</Button>
        {running && <Button variant="outline" size="sm" onClick={() => { void stop() }}>{t('stop')}</Button>}
        {view !== undefined && <span className="dsflow-run__status" data-status={view.status}>{t(`status.${view.status}` as LocaleKey)}</span>}
        {usage !== undefined && usage.inputTokens + usage.outputTokens > 0 && <span className="dsflow-muted">{usage.inputTokens + usage.outputTokens} {t('tokens')}</span>}
        {notice !== '' && <span className="dsflow-error">{notice}</span>}
      </div>
      {fields.length > 0 && (
        <div className="dsflow-run__inputs">
          <span className="dsflow-field__label">{t('runInputs')}</span>
          {fields.map(field => (
            <label key={field.name} className="dsflow-run__input">
              <span>{field.name}{field.required === true ? ' *' : ''}<span className="dsflow-muted"> {field.schema.type}{isJsonType(field) ? ` · ${t('jsonHint')}` : ''}</span></span>
              {field.schema.type === 'boolean'
                ? <input type="checkbox" checked={values[field.name] === 'true'} onChange={event => { setValues({ ...values, [field.name]: String(event.target.checked) }) }} />
                : (
                  <textarea
                    className={`dsflow-textarea dsflow-textarea--short${isJsonType(field) ? ' dsflow-textarea--mono' : ''}`}
                    value={values[field.name] ?? defaultText(field)}
                    onChange={event => { setValues({ ...values, [field.name]: event.target.value }) }}
                  />
                )}
            </label>
          ))}
        </div>
      )}
      {pending !== undefined && (
        <div className="dsflow-run__question">
          <span className="dsflow-field__label">{t('question')}</span>
          <div>{pending.question}</div>
          {pending.answer.kind === 'options' && (
            <div className="dsflow-run__options">
              {pending.answer.options.map(option => <Button key={option.id} variant="outline" size="sm" onClick={() => { void submitAnswer({ optionId: option.id, text: option.label }) }}>{option.label}</Button>)}
            </div>
          )}
          {(pending.answer.kind === 'text' || pending.answer.allowOther) && (
            <div className="dsflow-binding__row">
              <input className="dsflow-input" placeholder={pending.answer.kind === 'text' ? t('answer') : t('other')} value={answerText} onChange={event => { setAnswerText(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') void submitAnswer({ text: answerText }) }} />
              <Button variant="primary" size="sm" onClick={() => { void submitAnswer({ text: answerText }) }}>{t('submit')}</Button>
            </div>
          )}
        </div>
      )}
      {view !== undefined && (
        <div className="dsflow-run__result">
          {view.error !== undefined && <div className="dsflow-error">{t('runError')}: {view.error.code} {view.error.message}</div>}
          {view.messages.length > 0 && (
            <div>
              <span className="dsflow-field__label">{t('messages')}</span>
              {view.messages.map((message, index) => <div key={index} className="dsflow-run__message">{message.text}</div>)}
            </div>
          )}
          {view.outputs !== undefined && (
            <div>
              <span className="dsflow-field__label">{t('outputs')}</span>
              <pre className="dsflow-pre">{JSON.stringify(view.outputs, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function isJsonType(field: VarField): boolean {
  return field.schema.type === 'object' || field.schema.type === 'array' || field.schema.type === 'any'
}

function defaultText(field: VarField & { default?: JsonValue }): string {
  if (field.default === undefined) return ''
  return typeof field.default === 'string' ? field.default : JSON.stringify(field.default)
}

/** Parse the input form into run inputs; empty optional fields are omitted so the Host applies defaults. */
function parseInputs(fields: readonly (VarField & { default?: JsonValue })[], values: Record<string, string>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const field of fields) {
    const raw = values[field.name] ?? defaultText(field)
    if (raw === '' && field.schema.type !== 'boolean') continue
    switch (field.schema.type) {
      case 'string': out[field.name] = raw; break
      case 'number': case 'integer': out[field.name] = Number(raw); break
      case 'boolean': out[field.name] = raw === 'true'; break
      default:
        try {
          out[field.name] = JSON.parse(raw) as JsonValue
        } catch {
          throw new Error(`${field.name}: invalid JSON`)
        }
    }
  }
  return out
}
