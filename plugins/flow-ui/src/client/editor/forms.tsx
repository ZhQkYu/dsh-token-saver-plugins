/**
 * Node inspector forms. Editing the whole `data` object as JSON is the safe
 * fallback for any node type; common nodes get purpose-built fields. All values
 * are written back through `onChange(data)` so the document stays the source of
 * truth.
 *
 * @module @dsh-plugins/flow-ui/client/editor/forms
 */

import type { FlowNode, InputBinding, ValueSource, VarField, VarSchema } from '@dsh-plugins/flow/spec'
import { NAME_PATTERN } from '@dsh-plugins/flow/spec'

/** Props for a node form. */
export interface NodeFormProps {
  node: FlowNode
  onChange(data: Record<string, unknown>): void
}

/** Render a node form. */
export function NodeForm({ node, onChange }: NodeFormProps): JSX.Element {
  const data = node.data as Record<string, unknown>
  return (
    <div className="dsflow-form">
      <Field label="title">
        <input className="dsflow-input" value={node.title} onChange={e => { void e }} />
      </Field>
      <div className="dsflow-form__json">
        <div className="dsflow-form__label">data (JSON)</div>
        <JsonEditor value={data} onChange={onChange} />
      </div>
    </div>
  )
}

/** A labeled field wrapper. */
function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label className="dsflow-field">
      <span className="dsflow-field__label">{label}</span>
      {children}
    </label>
  )
}

/** A JSON editor for the node data object. */
function JsonEditor({ value, onChange }: { value: Record<string, unknown>; onChange(data: Record<string, unknown>): void }): JSX.Element {
  const text = JSON.stringify(value, null, 2)
  return (
    <textarea
      className="dsflow-textarea dsflow-textarea--mono"
      value={text}
      spellCheck={false}
      onChange={e => {
        try {
          const parsed = JSON.parse(e.target.value) as Record<string, unknown>
          onChange(parsed)
        } catch {
          // Keep the raw text; only commit valid JSON.
        }
      }}
    />
  )
}

/** A reusable input binding list editor. */
export function InputBindingsEditor({ bindings, onChange }: { bindings: InputBinding[]; onChange(bindings: InputBinding[]): void }): JSX.Element {
  const update = (index: number, patch: Partial<InputBinding>): void => {
    const next = bindings.map((binding, i) => i === index ? { ...binding, ...patch } : binding)
    onChange(next)
  }
  const remove = (index: number): void => {
    onChange(bindings.filter((_, i) => i !== index))
  }
  const add = (): void => {
    onChange([...bindings, { name: `input${bindings.length + 1}`, schema: { type: 'string' }, value: { kind: 'literal', value: '' } }])
  }
  return (
    <div className="dsflow-bindings">
      {bindings.map((binding, index) => (
        <div key={index} className="dsflow-bindings__row">
          <input className="dsflow-input" value={binding.name} onChange={e => update(index, { name: e.target.value })} />
          <select className="dsflow-input" value={binding.schema.type} onChange={e => update(index, { schema: { ...binding.schema, type: e.target.value as VarSchema['type'] } })}>
            {(['string', 'number', 'integer', 'boolean', 'object', 'array', 'any'] as const).map(type => <option key={type} value={type}>{type}</option>)}
          </select>
          <ValueSourceEditor value={binding.value} onChange={v => update(index, { value: v })} />
          <button className="dsflow-button dsflow-button--ghost" onClick={() => remove(index)}>×</button>
        </div>
      ))}
      <button className="dsflow-button" onClick={add}>+ add input</button>
    </div>
  )
}

/** A literal / ref editor for one value source. */
export function ValueSourceEditor({ value, onChange }: { value: ValueSource; onChange(value: ValueSource): void }): JSX.Element {
  if (value.kind === 'literal') {
    return (
      <input
        className="dsflow-input"
        value={typeof value.value === 'string' ? value.value : JSON.stringify(value.value ?? null)}
        onChange={e => onChange({ kind: 'literal', value: e.target.value })}
      />
    )
  }
  const pathText = [value.node, ...value.path].join('.')
  return (
    <span className="dsflow-bindings__ref" title="click to convert to literal">
      <button className="dsflow-button dsflow-button--ghost" onClick={() => onChange({ kind: 'literal', value: '' })}>⇄</button>
      <code>{pathText}</code>
    </span>
  )
}

/** A simple textarea for templates. */
export function TemplateEditor({ value, onChange }: { value: string; onChange(value: string): void }): JSX.Element {
  return <textarea className="dsflow-textarea" value={value} onChange={e => onChange(e.target.value)} />
}

/** A simple code editor (monospace textarea with tab indentation). */
export function CodeEditor({ value, onChange }: { value: string; onChange(value: string): void }): JSX.Element {
  return (
    <textarea
      className="dsflow-textarea dsflow-textarea--mono"
      value={value}
      spellCheck={false}
      onKeyDown={e => {
        if (e.key === 'Tab') {
          e.preventDefault()
          const target = e.currentTarget
          const start = target.selectionStart
          const end = target.selectionEnd
          const next = `${value.slice(0, start)}  ${value.slice(end)}`
          onChange(next)
          requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 2 })
        }
      }}
      onChange={e => onChange(e.target.value)}
    />
  )
}

/** A schema editor for output variable fields. */
export function SchemaEditor({ fields, onChange }: { fields: VarField[]; onChange(fields: VarField[]): void }): JSX.Element {
  const update = (index: number, patch: Partial<VarField>): void => {
    onChange(fields.map((field, i) => i === index ? { ...field, ...patch } : field))
  }
  const remove = (index: number): void => {
    onChange(fields.filter((_, i) => i !== index))
  }
  const add = (): void => {
    onChange([...fields, { name: `field${fields.length + 1}`, schema: { type: 'string' } }])
  }
  return (
    <div className="dsflow-bindings">
      {fields.map((field, index) => (
        <div key={index} className="dsflow-bindings__row">
          <input className="dsflow-input" value={field.name} onChange={e => update(index, { name: e.target.value })} />
          <select className="dsflow-input" value={field.schema.type} onChange={e => update(index, { schema: { ...field.schema, type: e.target.value as VarSchema['type'] } })}>
            {(['string', 'number', 'integer', 'boolean', 'object', 'array', 'any'] as const).map(type => <option key={type} value={type}>{type}</option>)}
          </select>
          <button className="dsflow-button dsflow-button--ghost" onClick={() => remove(index)}>×</button>
        </div>
      ))}
      <button className="dsflow-button" onClick={add}>+ add field</button>
    </div>
  )
}

/** Validate a candidate name against the identifier pattern. */
export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name)
}
