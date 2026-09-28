/**
 * The node inspector: title, description, input bindings (value or upstream
 * reference picked from the variables in scope), and the node settings as
 * JSON. Every edit produces a new node that the editor writes back into the
 * document.
 *
 * @module @dsh-plugins/flow-ui/client/editor/forms
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FlowDocument, FlowLookup, FlowNode, InputBinding, JsonValue, ValueSource, VarSchema, VarType } from '@dsh-plugins/flow/spec'
import { NAME_PATTERN, availableVariables, describeVarSchema, uniqueName } from '@dsh-plugins/flow/spec'
import type { Translate } from '../locales.ts'

const VAR_TYPES: readonly VarType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'any']

/** Props for {@link NodeInspector}. */
export interface NodeInspectorProps {
  doc: FlowDocument
  node: FlowNode
  lookup: FlowLookup
  t: Translate
  onChange(next: FlowNode): void
  onDelete(): void
}

/** The inspector for the selected node. */
export function NodeInspector({ doc, node, lookup, t, onChange, onDelete }: NodeInspectorProps): ReactNode {
  const bindings = bindingsOf(node)
  return (
    <div className="dsflow-form">
      <label className="dsflow-field">
        <span className="dsflow-field__label">{t('title')}</span>
        <input className="dsflow-input" value={node.title} maxLength={200} onChange={event => { onChange({ ...node, title: event.target.value }) }} />
      </label>
      <label className="dsflow-field">
        <span className="dsflow-field__label">{t('description')}</span>
        <input className="dsflow-input" value={node.description ?? ''} maxLength={2000} onChange={event => { onChange({ ...node, description: event.target.value }) }} />
      </label>
      {bindings !== undefined && (
        <BindingsEditor
          doc={doc}
          node={node}
          lookup={lookup}
          t={t}
          bindings={bindings}
          onChange={next => { onChange(withBindings(node, next)) }}
        />
      )}
      <DataEditor node={node} t={t} onChange={onChange} />
      <Button variant="ghost" className="dsflow-danger" onClick={onDelete}>{t('delete')}</Button>
    </div>
  )
}

/** The binding list of nodes that declare named inputs; `undefined` for nodes that do not. */
function bindingsOf(node: FlowNode): InputBinding[] | undefined {
  switch (node.type) {
    case 'end': case 'llm': case 'intent': case 'agent': case 'code': case 'http': case 'subflow': case 'question': case 'message':
      return node.data.inputs
    case 'tool': return node.data.args
    case 'text': return node.data.op === 'concat' ? node.data.inputs : undefined
    default: return undefined
  }
}

function withBindings(node: FlowNode, bindings: InputBinding[]): FlowNode {
  switch (node.type) {
    case 'end': return { ...node, data: { ...node.data, inputs: bindings } }
    case 'llm': return { ...node, data: { ...node.data, inputs: bindings } }
    case 'intent': return { ...node, data: { ...node.data, inputs: bindings } }
    case 'agent': return { ...node, data: { ...node.data, inputs: bindings } }
    case 'code': return { ...node, data: { ...node.data, inputs: bindings } }
    case 'http': return { ...node, data: { ...node.data, inputs: bindings } }
    case 'subflow': return { ...node, data: { ...node.data, inputs: bindings } }
    case 'question': return { ...node, data: { ...node.data, inputs: bindings } }
    case 'message': return { ...node, data: { ...node.data, inputs: bindings } }
    case 'tool': return { ...node, data: { ...node.data, args: bindings } }
    case 'text': return node.data.op === 'concat' ? { ...node, data: { ...node.data, inputs: bindings } } : node
    default: return node
  }
}

/** One selectable upstream variable. */
interface VariableOption {
  key: string
  label: string
  source: Extract<ValueSource, { kind: 'ref' }>
  schema: VarSchema
}

function variableOptions(doc: FlowDocument, nodeId: string, lookup: FlowLookup): VariableOption[] {
  const options: VariableOption[] = []
  for (const group of availableVariables(doc, nodeId, lookup)) {
    for (const entry of group.nodes) {
      for (const field of entry.outputs) {
        options.push({
          key: `output:${entry.nodeId}:${field.name}`,
          label: `${entry.nodeTitle} › ${field.name} (${describeVarSchema(field.schema)})`,
          source: { kind: 'ref', node: entry.nodeId, source: 'output', path: [field.name] },
          schema: field.schema,
        })
      }
    }
    if (group.inner !== undefined) {
      const containerTitle = doc.nodes.find(node => node.id === group.inner?.containerId)?.title ?? group.inner.containerId
      for (const field of group.inner.fields) {
        options.push({
          key: `inner:${group.inner.containerId}:${field.name}`,
          label: `${containerTitle} › ${field.name} (${describeVarSchema(field.schema)})`,
          source: { kind: 'ref', node: group.inner.containerId, source: 'inner', path: [field.name] },
          schema: field.schema,
        })
      }
    }
  }
  return options
}

function sourceKey(source: ValueSource): string {
  return source.kind === 'literal' ? '' : `${source.source}:${source.node}:${source.path.join('.')}`
}

function BindingsEditor({ doc, node, lookup, t, bindings, onChange }: { doc: FlowDocument; node: FlowNode; lookup: FlowLookup; t: Translate; bindings: InputBinding[]; onChange(next: InputBinding[]): void }): ReactNode {
  const options = useMemo(() => variableOptions(doc, node.id, lookup), [doc, node.id, lookup])
  const update = (index: number, patch: Partial<InputBinding>): void => {
    onChange(bindings.map((binding, i) => i === index ? { ...binding, ...patch } : binding))
  }
  const add = (): void => {
    const name = uniqueName('input', new Set(bindings.map(binding => binding.name)))
    onChange([...bindings, { name, schema: { type: 'string' }, value: { kind: 'literal', value: '' } }])
  }
  return (
    <div className="dsflow-field">
      <span className="dsflow-field__label">{t('inputs')}</span>
      {bindings.map((binding, index) => (
        <div key={index} className="dsflow-binding">
          <div className="dsflow-binding__row">
            <input
              className="dsflow-input"
              aria-invalid={!NAME_PATTERN.test(binding.name)}
              value={binding.name}
              onChange={event => { update(index, { name: event.target.value }) }}
            />
            <select className="dsflow-input dsflow-input--narrow" value={binding.schema.type} onChange={event => { update(index, { schema: { type: event.target.value as VarType } }) }}>
              {VAR_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
            </select>
            <label className="dsflow-check" title={t('required')}>
              <input type="checkbox" checked={binding.required ?? true} onChange={event => { update(index, { required: event.target.checked }) }} />
              {t('required')}
            </label>
            <Button variant="ghost" size="sm" onClick={() => { onChange(bindings.filter((_, i) => i !== index)) }}>{t('remove')}</Button>
          </div>
          <div className="dsflow-binding__row">
            <select
              className="dsflow-input"
              value={sourceKey(binding.value)}
              onChange={(event) => {
                const picked = options.find(option => option.key === event.target.value)
                if (picked === undefined) update(index, { value: { kind: 'literal', value: '' } })
                else update(index, { value: picked.source, schema: picked.schema })
              }}
            >
              <option value="">{t('literal')}</option>
              {options.length === 0 && <option disabled value="-">{t('noVariables')}</option>}
              {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </div>
          {binding.value.kind === 'literal' && (
            <LiteralEditor schema={binding.schema} value={binding.value.value} t={t} onChange={value => { update(index, { value: { kind: 'literal', value } }) }} />
          )}
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={add}>{t('addInput')}</Button>
    </div>
  )
}

/** A literal value editor keyed on the binding type; JSON types keep local text until it parses. */
export function LiteralEditor({ schema, value, t, onChange }: { schema: VarSchema; value: JsonValue; t: Translate; onChange(value: JsonValue): void }): ReactNode {
  const [text, setText] = useState(() => literalText(schema, value))
  const [error, setError] = useState('')
  useEffect(() => { setText(literalText(schema, value)); setError('') }, [schema.type, value])
  if (schema.type === 'boolean') {
    return <label className="dsflow-check"><input type="checkbox" checked={value === true} onChange={event => { onChange(event.target.checked) }} />{String(value === true)}</label>
  }
  if (schema.type === 'string') {
    return <textarea className="dsflow-textarea dsflow-textarea--short" value={typeof value === 'string' ? value : ''} onChange={event => { onChange(event.target.value) }} />
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return <input className="dsflow-input" type="number" step={schema.type === 'integer' ? 1 : 'any'} value={typeof value === 'number' ? value : ''} onChange={event => { onChange(event.target.value === '' ? null : Number(event.target.value)) }} />
  }
  return (
    <>
      <textarea
        className="dsflow-textarea dsflow-textarea--mono dsflow-textarea--short"
        value={text}
        spellCheck={false}
        onChange={event => { setText(event.target.value) }}
        onBlur={() => {
          try {
            onChange(JSON.parse(text) as JsonValue)
            setError('')
          } catch (caught: unknown) {
            setError(`${t('invalidJson')}${caught instanceof Error ? caught.message : String(caught)}`)
          }
        }}
      />
      {error !== '' && <div className="dsflow-error">{error}</div>}
    </>
  )
}

function literalText(schema: VarSchema, value: JsonValue): string {
  if (schema.type === 'string' && typeof value === 'string') return value
  return JSON.stringify(value ?? null, null, 2)
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
        onChange={event => { setText(event.target.value) }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); apply() }
        }}
      />
      {error !== '' && <div className="dsflow-error">{error}</div>}
      <Button variant="outline" size="sm" disabled={text === serialized} onClick={apply}>{t('apply')}</Button>
    </div>
  )
}
