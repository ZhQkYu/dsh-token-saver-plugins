/**
 * Searchable tool list for `tool` nodes: filter by name or description and
 * click a row to pick it. When the catalog is unavailable the field falls
 * back to free text so a graph stays editable.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogTool } from '@dsh-plugins/token-saver/protocol'
import type { LocaleKey } from './locales.ts'

/**
 * Render the tool picker.
 * @param props.tools - the catalog, `null` while loading, `undefined` when it failed.
 * @param props.value - the current tool name.
 * @param props.onPick - called with the picked tool name.
 * @param props.t - translator.
 * @returns the picker element.
 */
export function ToolPicker(props: {
  tools: readonly CatalogTool[] | null | undefined
  value: string
  onPick: (name: string) => void
  t: (key: LocaleKey) => string
}): ReactNode {
  const { tools, value, onPick, t } = props
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    if (tools === null || tools === undefined) return []
    const needle = query.trim().toLowerCase()
    if (needle === '') return tools
    return tools.filter(tool => tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle))
  }, [tools, query])

  if (tools === undefined) {
    return (
      <>
        <input id="ts-node-tool" value={value} placeholder={t('toolNamePlaceholder')} onChange={event => { onPick(event.target.value) }} />
        <div className="ts-field-hint">{t('toolsUnavailable')}</div>
      </>
    )
  }
  const current = tools?.find(tool => tool.name === value)
  return (
    <div className="ts-tool-picker">
      <Input
        id="ts-node-tool"
        icon={<IconSearchOutlineRegular size={14} />}
        value={query}
        placeholder={t('searchTools')}
        onChange={event => { setQuery(event.target.value) }}
      />
      <div className="ts-tool-list" role="listbox" aria-label={t('tool')}>
        {tools === null && <div className="ts-field-hint">{t('loading')}</div>}
        {tools !== null && matches.length === 0 && <div className="ts-field-hint">{t('noToolMatch')}</div>}
        {matches.map(tool => (
          <button
            key={tool.name}
            type="button"
            role="option"
            aria-selected={tool.name === value}
            className="ts-tool-row"
            onClick={() => { onPick(tool.name) }}
          >
            <span className="ts-tool-name">{tool.name}</span>
            <span className="ts-tool-description">{tool.description}</span>
          </button>
        ))}
      </div>
      {value !== '' && current === undefined && tools !== null && (
        <div className="ts-field-hint" data-warning="true">{t('toolMissing')}</div>
      )}
    </div>
  )
}
