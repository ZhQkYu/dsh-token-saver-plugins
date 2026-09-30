/**
 * A collapsible, syntax-colored JSON tree for run inputs and outputs. Objects
 * and arrays fold; the first two levels start open. Long strings keep their
 * line breaks, and every node has a copy-as-JSON action on the root.
 *
 * @module @dsh-plugins/flow-ui/client/run/JsonTree
 */

import { useState, type ReactNode } from 'react'
import type { JsonValue } from '@dsh-plugins/flow/spec'

/** Levels opened by default. */
const OPEN_DEPTH = 2
/** Strings longer than this render as a block instead of inline. */
const BLOCK_STRING_CHARS = 80

function Scalar({ value }: { value: JsonValue }): ReactNode {
  if (value === null) return <span className="dsflow-json__null">null</span>
  if (typeof value === 'string') {
    if (value.length > BLOCK_STRING_CHARS || value.includes('\n')) return <div className="dsflow-json__block">{value}</div>
    return <span className="dsflow-json__string">"{value}"</span>
  }
  if (typeof value === 'number') return <span className="dsflow-json__number">{value}</span>
  return <span className="dsflow-json__boolean">{String(value)}</span>
}

function summary(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.length}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).length}}`
  return ''
}

function Entry({ name, value, depth }: { name: string | undefined; value: JsonValue; depth: number }): ReactNode {
  const composite = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth < OPEN_DEPTH)
  const key = name === undefined ? null : <span className="dsflow-json__key">{name}</span>
  if (!composite) {
    return <div className="dsflow-json__row">{key}{key !== null && <span className="dsflow-json__colon">:</span>}<Scalar value={value} /></div>
  }
  const entries: [string, JsonValue][] = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value)
  return (
    <div className="dsflow-json__node">
      <button type="button" className="dsflow-json__toggle" aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <span className="dsflow-json__caret">{open ? '▾' : '▸'}</span>
        {key}
        <span className="dsflow-json__summary">{summary(value)}</span>
      </button>
      {open && (
        <div className="dsflow-json__children">
          {entries.length === 0
            ? <span className="dsflow-json__null">{Array.isArray(value) ? '[]' : '{}'}</span>
            : entries.map(([childName, child]) => <Entry key={childName} name={childName} value={child} depth={depth + 1} />)}
        </div>
      )}
    </div>
  )
}

/**
 * Render a JSON value as a collapsible tree. A top-level object shows its
 * fields directly, without a wrapper row.
 * @param props - the value and the copy button label.
 * @returns the tree.
 */
export function JsonTree({ value, copyLabel }: { value: JsonValue; copyLabel: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1200)
    }, () => undefined)
  }
  const topObject = value !== null && typeof value === 'object' && !Array.isArray(value)
  return (
    <div className="dsflow-json">
      <button type="button" className="dsflow-json__copy" onClick={copy}>{copied ? '✓' : copyLabel}</button>
      {topObject
        ? Object.entries(value).map(([name, child]) => <Entry key={name} name={name} value={child} depth={1} />)
        : <Entry name={undefined} value={value} depth={0} />}
    </div>
  )
}
