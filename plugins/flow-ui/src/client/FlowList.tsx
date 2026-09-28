/**
 * The flow list page: shows saved flows, creates new ones, opens, and deletes
 * them. State is owned by FlowPage; this is a controlled view.
 *
 * @module @dsh-plugins/flow-ui/client/FlowList
 */

import { useState } from 'react'
import { Button, IconPlusOutlineRegular, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, errorText, type FlowSummary } from './api.ts'

/** Props for {@link FlowList}. */
export interface FlowListProps {
  t: (key: string) => string
  flows: FlowSummary[]
  loading: boolean
  error: string
  onCreate(name: string): void
  onOpen(id: string): void
}

/** The flow list page. */
export function FlowList({ t, flows, loading, error, onCreate, onOpen }: FlowListProps): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [localError, setLocalError] = useState('')

  const create = (): void => {
    const name = newName.trim() || `flow-${Date.now().toString(36)}`
    setNewName('')
    setCreating(false)
    onCreate(name)
  }

  const remove = (id: string): void => {
    api.remove(id)
      .then(() => onOpen(''))
      .catch((reason: unknown) => setLocalError(errorText(reason)))
  }

  return (
    <div className="dsh-flow-page">
      <div className="dsh-flow-page-header">
        <span className="dsh-flow-page-title">{t('panel')}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {creating && (
            <Input
              value={newName}
              placeholder={t('name')}
              autoFocus
              onChange={(event) => setNewName((event.target as HTMLInputElement).value)}
              onKeyDown={(event) => { if (event.key === 'Enter') create() }}
            />
          )}
          {creating && <Button onClick={create}>{t('create')}</Button>}
          <Button
            onClick={() => { setCreating(true) }}
            icon={<Tooltip label={t('newFlow')}><span><IconPlusOutlineRegular size={16} /></span></Tooltip>}
          >
            {t('newFlow')}
          </Button>
        </div>
      </div>
      {(error !== '' || localError !== '') && <div style={{ color: 'var(--vscode-errorForeground, #f48771)' }}>{error || localError}</div>}
      {loading
        ? <div className="dsh-flow-empty">{t('loading')}</div>
        : flows.length === 0
          ? <div className="dsh-flow-empty">{t('empty')}</div>
          : (
            <div className="dsh-flow-list">
              {flows.map(flow => (
                <div key={flow.id} className="dsh-flow-row" onClick={() => onOpen(flow.id)}>
                  <div style={{ flex: 1 }}>
                    <div className="dsh-flow-row-name">{flow.broken ? `${flow.name} (${t('broken')})` : flow.name}</div>
                    <div className="dsh-flow-row-desc">{flow.description || `${flow.nodeCount} nodes`}</div>
                  </div>
                  {flow.toolName !== undefined && <span>{flow.toolName}</span>}
                  <Button variant="ghost" onClick={e => { e.stopPropagation(); remove(flow.id) }}>{t('delete')}</Button>
                </div>
              ))}
            </div>
          )}
    </div>
  )
}
