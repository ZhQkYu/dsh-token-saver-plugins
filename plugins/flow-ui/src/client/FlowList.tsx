/**
 * The flow list page: create, open, duplicate, and delete flows. Deleting
 * needs a second click on the same row.
 *
 * @module @dsh-plugins/flow-ui/client/FlowList
 */

import { useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FlowSummary } from './api.ts'
import type { Translate } from './locales.ts'

/** Props for {@link FlowList}. */
export interface FlowListProps {
  t: Translate
  flows: FlowSummary[]
  loading: boolean
  error: string
  onCreate(name: string): void
  onOpen(id: string): void
  onDuplicate(id: string): void
  onDelete(id: string): void
}

/** The flow list page. */
export function FlowList({ t, flows, loading, error, onCreate, onOpen, onDuplicate, onDelete }: FlowListProps): ReactNode {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [confirming, setConfirming] = useState<string | undefined>(undefined)

  const create = (): void => {
    const name = newName.trim()
    if (name === '') return
    setNewName('')
    setCreating(false)
    onCreate(name)
  }

  return (
    <div className="dsh-flow-page">
      <div className="dsh-flow-page-header">
        <span className="dsh-flow-page-title">{t('panel')}</span>
        <div className="dsflow-row">
          {creating && (
            <Input
              value={newName}
              placeholder={t('name')}
              autoFocus
              maxLength={200}
              onChange={(event) => { setNewName(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') create(); if (event.key === 'Escape') setCreating(false) }}
            />
          )}
          {creating
            ? <Button variant="primary" disabled={newName.trim() === ''} onClick={create}>{t('create')}</Button>
            : <Button variant="primary" icon={<IconPlusOutlineRegular size={16} />} onClick={() => { setCreating(true) }}>{t('newFlow')}</Button>}
        </div>
      </div>
      {error !== '' && <div className="dsflow-error">{error}</div>}
      {loading
        ? <div className="dsh-flow-empty">{t('loading')}</div>
        : flows.length === 0
          ? <div className="dsh-flow-empty">{t('empty')}</div>
          : (
            <div className="dsh-flow-list">
              {flows.map(flow => (
                <div key={flow.id} className="dsh-flow-row" data-broken={flow.broken === true} onClick={() => { if (flow.broken !== true) onOpen(flow.id) }}>
                  <div className="dsh-flow-row-main">
                    <div className="dsh-flow-row-name">{flow.name}{flow.broken === true ? ` (${t('broken')})` : ''}</div>
                    <div className="dsh-flow-row-desc">{flow.broken === true ? flow.reason : flow.description || `${flow.nodeCount} ${t('nodeCount')}`}</div>
                  </div>
                  {flow.publishedVersion !== undefined && <span className="dsflow-badge">v{flow.publishedVersion}</span>}
                  {flow.toolName !== undefined && <span className="dsflow-badge">flow_{flow.toolName}</span>}
                  {flow.broken !== true && <Button variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); onDuplicate(flow.id) }}>{t('duplicate')}</Button>}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="dsflow-danger"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (confirming === flow.id) { setConfirming(undefined); onDelete(flow.id) } else setConfirming(flow.id)
                    }}
                    onBlur={() => { if (confirming === flow.id) setConfirming(undefined) }}
                  >
                    {confirming === flow.id ? t('confirmDelete') : t('delete')}
                  </Button>
                </div>
              ))}
            </div>
          )}
    </div>
  )
}
