/**
 * Single-node debugging: edit sample inputs for the selected node, run only
 * that node on the Host, and show its inputs, outputs, and errors. Inputs
 * default to the node's configured literals, then to the values the node
 * received in the last run, so re-running a failing step takes one click.
 *
 * @module @dsh-plugins/flow-ui/client/run/NodeDebugPanel
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FlowDocument, FlowNode, JsonValue, RunEvent, RunView } from '@dsh-plugins/flow/spec'
import { debugInputsOf, describeVarSchema, foldRunEvents } from '@dsh-plugins/flow/spec'
import { api, errorText, ApiError } from '../api.ts'
import { followRun } from './run-stream.ts'
import { NodeRunDetail } from './NodeRunDetail.tsx'
import type { LocaleKey, Translate } from '../locales.ts'

/** Props for {@link NodeDebugPanel}. */
export interface NodeDebugPanelProps {
  doc: FlowDocument
  node: FlowNode
  t: Translate
  /** The workspace the run panel selected. */
  workspaceId: string
  /** The node's inputs from the last full run, used as the starting sample. */
  lastInputs?: Record<string, JsonValue>
}

function toText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/**
 * Parse one input box by the binding type: strings stay text, everything else is JSON.
 * @returns the value, or undefined for an empty box.
 */
function parseValue(type: string, raw: string): JsonValue | undefined {
  if (raw.trim() === '') return undefined
  if (type === 'string') return raw
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    if (type === 'any') return raw
    throw new Error('invalid JSON')
  }
}

/** The debug panel for one node. */
export function NodeDebugPanel({ doc, node, t, workspaceId, lastInputs }: NodeDebugPanelProps): ReactNode {
  const inputs = debugInputsOf(node)
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(inputs.map(input => [input.name, toText(lastInputs?.[input.name] ?? input.literal)])))
  const [view, setView] = useState<RunView | undefined>(undefined)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const follow = useRef<AbortController | null>(null)
  useEffect(() => () => { follow.current?.abort() }, [])

  const run = async (): Promise<void> => {
    setNotice('')
    const payload: Record<string, JsonValue> = {}
    for (const input of inputs) {
      try {
        const value = parseValue(input.schema.type, values[input.name] ?? '')
        if (value !== undefined) payload[input.name] = value
      } catch (error: unknown) {
        setNotice(`${input.name}: ${errorText(error)}`)
        return
      }
    }
    setBusy(true)
    try {
      const { runId } = await api.debugNode(doc, node.id, payload, workspaceId)
      follow.current?.abort()
      const controller = new AbortController()
      follow.current = controller
      const events: RunEvent[] = []
      await followRun(runId, (event) => { events.push(event); setView(foldRunEvents(events)) }, controller.signal)
    } catch (error: unknown) {
      setNotice(error instanceof ApiError && error.issues !== undefined ? error.issues.map(issue => issue.message).join('; ') : errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const result = view?.nodes.find(candidate => candidate.nodeId === node.id)
  return (
    <div className="dsflow-trace">
      <div className="dsflow-hint">{t('debug.hint')}</div>
      {inputs.length === 0 && <div className="dsflow-muted">{t('debug.noInputs')}</div>}
      {inputs.map(input => (
        <label key={input.name} className="dsflow-run__input">
          <span>
            {input.name}{input.required ? ' *' : ''}
            <span className="dsflow-muted"> {describeVarSchema(input.schema)}{input.ref === undefined ? '' : ` · ${t('debug.from')} ${input.ref}`}</span>
          </span>
          <textarea
            className={`dsflow-textarea dsflow-textarea--short${input.schema.type === 'string' ? '' : ' dsflow-textarea--mono'}`}
            value={values[input.name] ?? ''}
            placeholder={input.schema.type === 'string' ? '' : t('jsonHint')}
            onChange={(event) => { setValues({ ...values, [input.name]: event.target.value }) }}
          />
        </label>
      ))}
      <div className="dsflow-bind__row">
        <Button variant="primary" size="sm" disabled={busy || workspaceId === ''} onClick={() => { void run() }}>{busy ? t('debug.running') : t('debug.run')}</Button>
        {lastInputs !== undefined && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setValues(Object.fromEntries(inputs.map(input => [input.name, toText(lastInputs[input.name] ?? input.literal)]))) }}>{t('debug.useLast')}</Button>}
        {view !== undefined && <span className="dsflow-run__status" data-status={view.status}>{t(`status.${view.status}` as LocaleKey)}</span>}
        {view !== undefined && view.durationMs > 0 && <span className="dsflow-muted">{view.durationMs} ms</span>}
      </div>
      {workspaceId === '' && <div className="dsflow-muted">{t('noWorkspace')}</div>}
      {notice !== '' && <div className="dsflow-error">{notice}</div>}
      {view?.error !== undefined && result?.error === undefined && <div className="dsflow-error" title={view.error.code}>{view.error.code}: {view.error.message}</div>}
      {result !== undefined && <div className="dsflow-trace__item" data-status={result.status}><NodeRunDetail node={result} t={t} /></div>}
    </div>
  )
}
