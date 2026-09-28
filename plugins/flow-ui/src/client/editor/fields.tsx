/**
 * Reusable point-and-click form controls for the node inspector: variable
 * pickers, typed value editors, templates with one-click variable insertion,
 * field lists, key/value lists, and the model picker.
 *
 * @module @dsh-plugins/flow-ui/client/editor/fields
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InputBinding, JsonValue, ModelSelection, ValueSource, VarField, VarSchema } from '@dsh-plugins/flow/spec'
import { NAME_PATTERN, describeVarSchema, uniqueName } from '@dsh-plugins/flow/spec'
import type { ModelCatalog } from '../api.ts'
import type { LocaleKey, Translate } from '../locales.ts'
import { bindingForOption, insertText, literalFor, sourceKey, type VariableOption } from './variables.ts'

const TYPE_CHOICES: { key: string; schema: VarSchema; label: LocaleKey }[] = [
  { key: 'string', schema: { type: 'string' }, label: 'type.string' },
  { key: 'number', schema: { type: 'number' }, label: 'type.number' },
  { key: 'integer', schema: { type: 'integer' }, label: 'type.integer' },
  { key: 'boolean', schema: { type: 'boolean' }, label: 'type.boolean' },
  { key: 'object', schema: { type: 'object' }, label: 'type.object' },
  { key: 'array<string>', schema: { type: 'array', items: { type: 'string' } }, label: 'type.arrayString' },
  { key: 'array<number>', schema: { type: 'array', items: { type: 'number' } }, label: 'type.arrayNumber' },
  { key: 'array<object>', schema: { type: 'array', items: { type: 'object' } }, label: 'type.arrayObject' },
  { key: 'array<any>', schema: { type: 'array' }, label: 'type.array' },
  { key: 'any', schema: { type: 'any' }, label: 'type.any' },
]

function schemaKey(schema: VarSchema): string {
  if (schema.type === 'object') return (schema.properties ?? []).length === 0 ? 'object' : 'custom'
  if (schema.type === 'array') {
    const items = schema.items
    if (items === undefined || items.type === 'any') return 'array<any>'
    if ((items.type === 'object' && (items.properties ?? []).length > 0) || items.type === 'array') return 'custom'
    const key = `array<${items.type}>`
    return TYPE_CHOICES.some(choice => choice.key === key) ? key : 'custom'
  }
  return schema.type
}

/**
 * A short localized type name.
 * @param t - the translator.
 * @param schema - the schema.
 * @returns the label.
 */
export function typeLabel(t: Translate, schema: VarSchema): string {
  const choice = TYPE_CHOICES.find(candidate => candidate.key === schemaKey(schema))
  return choice === undefined ? describeVarSchema(schema) : t(choice.label)
}

/** A variable type picker; structured schemas it cannot express stay selected as-is. */
export function TypeSelect({ schema, t, onChange }: { schema: VarSchema; t: Translate; onChange(schema: VarSchema): void }): ReactNode {
  const key = schemaKey(schema)
  return (
    <select className="dsflow-input dsflow-input--type" aria-label={t('type')} value={key} onChange={(event) => {
      const choice = TYPE_CHOICES.find(candidate => candidate.key === event.target.value)
      if (choice !== undefined) onChange(choice.schema)
    }}>
      {key === 'custom' && <option value="custom">{describeVarSchema(schema)}</option>}
      {TYPE_CHOICES.map(choice => <option key={choice.key} value={choice.key}>{t(choice.label)}</option>)}
    </select>
  )
}

/** A labelled group of controls. */
export function Section({ title, hint, extra, children }: { title: string; hint?: string; extra?: ReactNode; children?: ReactNode }): ReactNode {
  return (
    <div className="dsflow-section">
      <div className="dsflow-section__head">
        <span className="dsflow-section__title">{title}</span>
        {extra}
      </div>
      {hint !== undefined && hint !== '' && <div className="dsflow-hint">{hint}</div>}
      {children}
    </div>
  )
}

/** A segmented single choice. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly { value: T; label: string }[]; onChange(value: T): void }): ReactNode {
  return (
    <div className="dsflow-seg" role="radiogroup">
      {options.map(option => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} className="dsflow-seg__item" data-active={option.value === value} onClick={() => { onChange(option.value) }}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** A small remove button. */
export function RemoveButton({ t, onClick }: { t: Translate; onClick(): void }): ReactNode {
  return <button type="button" className="dsflow-icon-btn" aria-label={t('remove')} title={t('remove')} onClick={onClick}>×</button>
}

/** An add button styled as a dashed row. */
export function AddButton({ label, onClick }: { label: string; onClick(): void }): ReactNode {
  return <button type="button" className="dsflow-add" onClick={onClick}>+ {label}</button>
}

/** A number input where empty means unset. */
export function NumberField({ value, min, max, step, placeholder, onChange }: { value: number | undefined; min?: number; max?: number; step?: number; placeholder?: string; onChange(value: number | undefined): void }): ReactNode {
  return (
    <input
      className="dsflow-input dsflow-input--number"
      type="number"
      value={value ?? ''}
      min={min}
      max={max}
      step={step ?? 1}
      placeholder={placeholder}
      onChange={(event) => {
        if (event.target.value === '') onChange(undefined)
        else if (Number.isFinite(Number(event.target.value))) onChange(Number(event.target.value))
      }}
    />
  )
}

/** A typed literal value editor; JSON types keep local text until it parses. */
export function LiteralEditor({ schema, value, t, multiline = false, onChange }: { schema: VarSchema; value: JsonValue; t: Translate; multiline?: boolean; onChange(value: JsonValue): void }): ReactNode {
  const json = schema.type === 'object' || schema.type === 'array' || (schema.type === 'any' && value !== null && typeof value !== 'string')
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2))
  const [error, setError] = useState('')
  useEffect(() => { if (json) { setText(JSON.stringify(value ?? null, null, 2)); setError('') } }, [json, value])
  if (schema.type === 'boolean') {
    return (
      <Segmented
        value={value === true ? 'true' : 'false'}
        options={[{ value: 'true', label: t('value.true') }, { value: 'false', label: t('value.false') }]}
        onChange={(next) => { onChange(next === 'true') }}
      />
    )
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return <NumberField value={typeof value === 'number' ? value : undefined} step={schema.type === 'integer' ? 1 : 0.01} placeholder={t('value.enterNumber')} onChange={(next) => { onChange(next ?? null) }} />
  }
  if (!json) {
    const current = typeof value === 'string' ? value : ''
    return multiline
      ? <textarea className="dsflow-textarea dsflow-textarea--short" value={current} placeholder={t('value.enterText')} onChange={(event) => { onChange(event.target.value) }} />
      : <input className="dsflow-input" value={current} placeholder={t('value.enterText')} onChange={(event) => { onChange(event.target.value) }} />
  }
  return (
    <>
      <textarea
        className="dsflow-textarea dsflow-textarea--mono dsflow-textarea--short"
        value={text}
        spellCheck={false}
        onChange={(event) => { setText(event.target.value) }}
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

function groupOptions(options: readonly VariableOption[]): { key: string; title: string; options: VariableOption[] }[] {
  const groups: { key: string; title: string; options: VariableOption[] }[] = []
  for (const option of options) {
    const key = `${option.source.source}:${option.source.node}`
    let group = groups.find(candidate => candidate.key === key)
    if (group === undefined) {
      group = { key, title: option.group, options: [] }
      groups.push(group)
    }
    group.options.push(option)
  }
  return groups
}

function VariableOptions({ options, t }: { options: readonly VariableOption[]; t: Translate }): ReactNode {
  return groupOptions(options).map(group => (
    <optgroup key={group.key} label={group.title}>
      {group.options.map(option => <option key={option.key} value={option.key}>{option.group} › {option.label} ({typeLabel(t, option.schema)})</option>)}
    </optgroup>
  ))
}

/**
 * A value: either a typed literal or a reference to an upstream variable,
 * chosen from one dropdown. `onChange` passes the referenced variable's
 * schema when a variable is picked.
 */
export function ValuePicker({ value, schema, options, t, literal = true, multiline = false, literalExtra, onChange }: {
  value: ValueSource
  schema: VarSchema
  options: readonly VariableOption[]
  t: Translate
  literal?: boolean
  multiline?: boolean
  literalExtra?: ReactNode
  onChange(value: ValueSource, schema?: VarSchema): void
}): ReactNode {
  const key = sourceKey(value)
  const known = key === '' || options.some(option => option.key === key)
  return (
    <div className="dsflow-value">
      <select
        className="dsflow-input"
        data-kind={value.kind}
        value={key}
        onChange={(event) => {
          const picked = options.find(option => option.key === event.target.value)
          if (picked !== undefined) onChange(picked.source, picked.schema)
          else onChange(literalFor(schema))
        }}
      >
        <option value="" disabled={!literal}>{literal ? t('value.literal') : t('value.pick')}</option>
        {!known && value.kind === 'ref' && <option value={key}>{t('value.missing')} {value.path.join('.')}</option>}
        {options.length === 0 && <option value="-" disabled>{t('noVariables')}</option>}
        <VariableOptions options={options} t={t} />
      </select>
      {literal && value.kind === 'literal' && (
        <div className="dsflow-value__literal">
          <LiteralEditor schema={schema} value={value.value} t={t} multiline={multiline} onChange={(next) => { onChange({ kind: 'literal', value: next }) }} />
          {literalExtra}
        </div>
      )}
    </div>
  )
}

/** A dropdown that adds something: a fixed value (when `literalLabel` is set) or a picked variable; it resets after each pick. */
export function AddFromVariable({ label, literalLabel, options, t, onPick }: { label: string; literalLabel?: string; options: readonly VariableOption[]; t: Translate; onPick(option: VariableOption | undefined): void }): ReactNode {
  return (
    <select
      className="dsflow-input dsflow-add-select"
      value=""
      onChange={(event) => {
        if (event.target.value === '__literal') onPick(undefined)
        else {
          const picked = options.find(option => option.key === event.target.value)
          if (picked !== undefined) onPick(picked)
        }
      }}
    >
      <option value="" disabled>+ {label}</option>
      {literalLabel !== undefined && <option value="__literal">{literalLabel}</option>}
      {options.length === 0 && <option value="-" disabled>{t('noVariables')}</option>}
      <VariableOptions options={options} t={t} />
    </select>
  )
}

/**
 * Named inputs: each row is a name and a value picker. `fixed` rows keep
 * their names and types (tool parameters, subflow inputs).
 */
export function BindingsEditor({ bindings, options, t, onChange, fixed = false, removable = true, describe, addLabel }: {
  bindings: readonly InputBinding[]
  options: readonly VariableOption[]
  t: Translate
  onChange(next: InputBinding[]): void
  fixed?: boolean
  removable?: boolean | ((binding: InputBinding) => boolean)
  describe?: (binding: InputBinding) => string | undefined
  addLabel?: string
}): ReactNode {
  const update = (index: number, patch: Partial<InputBinding>): void => {
    onChange(bindings.map((binding, i) => i === index ? { ...binding, ...patch } : binding))
  }
  return (
    <div className="dsflow-list">
      {bindings.map((binding, index) => (
        <div key={index} className="dsflow-bind">
          <div className="dsflow-bind__row">
            {fixed
              ? <span className="dsflow-bind__name dsflow-bind__name--fixed" title={describe?.(binding)}>{binding.name}{binding.required === false ? '' : ' *'}</span>
              : <input className="dsflow-input dsflow-bind__name" aria-label={t('name')} aria-invalid={!NAME_PATTERN.test(binding.name)} value={binding.name} onChange={(event) => { update(index, { name: event.target.value }) }} />}
            <ValuePicker
              value={binding.value}
              schema={binding.schema}
              options={options}
              t={t}
              literalExtra={fixed ? undefined : <TypeSelect schema={binding.schema} t={t} onChange={(schema) => { update(index, { schema, value: literalFor(schema) }) }} />}
              onChange={(value, schema) => { update(index, fixed || schema === undefined ? { value } : { value, schema }) }}
            />
            {(typeof removable === 'function' ? removable(binding) : removable) && <RemoveButton t={t} onClick={() => { onChange(bindings.filter((_, i) => i !== index)) }} />}
          </div>
          {fixed && describe?.(binding) !== undefined && describe(binding) !== '' && <div className="dsflow-hint">{describe(binding)}</div>}
        </div>
      ))}
      {!fixed && (
        <AddFromVariable
          label={addLabel ?? t('addInput')}
          literalLabel={t('value.literalRow')}
          options={options}
          t={t}
          onPick={(option) => {
            if (option === undefined) {
              const name = uniqueName('input', new Set(bindings.map(binding => binding.name)))
              onChange([...bindings, { name, schema: { type: 'string' }, value: { kind: 'literal', value: '' } }])
            } else {
              onChange([...bindings, bindingForOption(bindings, option).binding])
            }
          }}
        />
      )}
    </div>
  )
}

/**
 * A template with one-click variable insertion: click an input name to insert
 * `{{name}}`, or pick any upstream variable to add it as an input and insert it.
 */
export function TemplateField({ label, hint, value, bindings, options, t, multiline = true, mono = false, placeholder, onChange }: {
  label?: string
  hint?: string
  value: string
  bindings: readonly InputBinding[]
  options: readonly VariableOption[]
  t: Translate
  multiline?: boolean
  mono?: boolean
  placeholder?: string
  onChange(text: string, bindings?: InputBinding[]): void
}): ReactNode {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const insert = (name: string, nextBindings?: InputBinding[]): void => {
    const element = ref.current
    const start = element?.selectionStart ?? value.length
    const end = element?.selectionEnd ?? value.length
    const next = insertText(value, start, end, `{{${name}}}`)
    onChange(next.text, nextBindings)
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(next.cursor, next.cursor)
    })
  }
  const className = multiline ? `dsflow-textarea${mono ? ' dsflow-textarea--mono' : ''}` : 'dsflow-input'
  return (
    <div className="dsflow-field">
      {label !== undefined && <span className="dsflow-field__label">{label}</span>}
      {multiline
        ? <textarea ref={ref} className={className} value={value} placeholder={placeholder} spellCheck={false} onChange={(event) => { onChange(event.target.value) }} />
        : <input ref={ref} className={className} value={value} placeholder={placeholder} onChange={(event) => { onChange(event.target.value) }} />}
      <div className="dsflow-chips">
        {bindings.length > 0 && <span className="dsflow-muted">{t('template.insert')}</span>}
        {bindings.map(binding => (
          <button key={binding.name} type="button" className="dsflow-chip" title={`{{${binding.name}}}`} onMouseDown={(event) => { event.preventDefault() }} onClick={() => { insert(binding.name) }}>
            {binding.name}
          </button>
        ))}
        <AddFromVariable
          label={t('template.reference')}
          options={options}
          t={t}
          onPick={(option) => {
            if (option === undefined) return
            const { binding, added } = bindingForOption(bindings, option)
            insert(binding.name, added ? [...bindings, binding] : undefined)
          }}
        />
      </div>
      {hint !== undefined && <div className="dsflow-hint">{hint}</div>}
    </div>
  )
}

/** Declared fields (start inputs, JSON outputs, code outputs): name, type, and optionally required, description, and default. */
export function FieldListEditor({ fields, t, onChange, required = false, describe = false, defaults = false, addLabel, namePrefix = 'field' }: {
  fields: readonly (VarField & { default?: JsonValue })[]
  t: Translate
  onChange(next: (VarField & { default?: JsonValue })[]): void
  required?: boolean
  describe?: boolean
  defaults?: boolean
  addLabel: string
  namePrefix?: string
}): ReactNode {
  const update = (index: number, patch: Partial<VarField & { default?: JsonValue }>): void => {
    onChange(fields.map((field, i) => i === index ? { ...field, ...patch } : field))
  }
  return (
    <div className="dsflow-list">
      {fields.map((field, index) => (
        <div key={index} className="dsflow-bind">
          <div className="dsflow-bind__row">
            <input className="dsflow-input dsflow-bind__name" aria-label={t('name')} aria-invalid={!NAME_PATTERN.test(field.name)} value={field.name} onChange={(event) => { update(index, { name: event.target.value }) }} />
            <TypeSelect schema={field.schema} t={t} onChange={(schema) => {
              const { default: _dropped, ...rest } = field
              const next = [...fields]
              next[index] = { ...rest, schema }
              onChange(next)
            }} />
            {required && (
              <label className="dsflow-check" title={t('required')}>
                <input type="checkbox" checked={field.required === true} onChange={(event) => { update(index, { required: event.target.checked }) }} />
                {t('required')}
              </label>
            )}
            <RemoveButton t={t} onClick={() => { onChange(fields.filter((_, i) => i !== index)) }} />
          </div>
          {describe && (
            <input className="dsflow-input dsflow-input--quiet" placeholder={t('field.description')} value={field.description ?? ''} onChange={(event) => {
              const { description: _dropped, ...rest } = field
              const next = [...fields]
              next[index] = event.target.value === '' ? rest : { ...rest, description: event.target.value }
              onChange(next)
            }} />
          )}
          {defaults && field.schema.type !== 'boolean' && (
            <DefaultValue field={field} t={t} onChange={(value) => {
              const { default: _dropped, ...rest } = field
              const next = [...fields]
              next[index] = value === undefined ? rest : { ...rest, default: value }
              onChange(next)
            }} />
          )}
        </div>
      ))}
      <AddButton label={addLabel} onClick={() => { onChange([...fields, { name: uniqueName(namePrefix, new Set(fields.map(field => field.name))), schema: { type: 'string' }, ...(required ? { required: true } : {}) }]) }} />
    </div>
  )
}

function DefaultValue({ field, t, onChange }: { field: VarField & { default?: JsonValue }; t: Translate; onChange(value: JsonValue | undefined): void }): ReactNode {
  const type = field.schema.type
  const [text, setText] = useState(() => field.default === undefined ? '' : typeof field.default === 'string' ? field.default : JSON.stringify(field.default))
  const [error, setError] = useState('')
  return (
    <>
      <input
        className="dsflow-input dsflow-input--quiet"
        placeholder={t('field.default')}
        value={text}
        onChange={(event) => {
          const raw = event.target.value
          setText(raw)
          if (raw === '') { onChange(undefined); setError(''); return }
          if (type === 'string') { onChange(raw); return }
          if (type === 'number' || type === 'integer') {
            if (Number.isFinite(Number(raw))) { onChange(Number(raw)); setError('') } else setError(t('value.enterNumber'))
            return
          }
          try {
            onChange(JSON.parse(raw) as JsonValue)
            setError('')
          } catch {
            if (type === 'any') { onChange(raw); setError('') } else setError(t('invalidJson'))
          }
        }}
      />
      {error !== '' && <div className="dsflow-error">{error}</div>}
    </>
  )
}

/** Key/value rows (HTTP headers, query, form fields); values are templates with variable insertion. */
export function KeyValueList({ items, bindings, options, t, addLabel, keyPlaceholder, onChange }: {
  items: readonly { name: string; value: string }[]
  bindings: readonly InputBinding[]
  options: readonly VariableOption[]
  t: Translate
  addLabel: string
  keyPlaceholder: string
  onChange(items: { name: string; value: string }[], bindings?: InputBinding[]): void
}): ReactNode {
  const update = (index: number, patch: Partial<{ name: string; value: string }>, nextBindings?: InputBinding[]): void => {
    onChange(items.map((item, i) => i === index ? { ...item, ...patch } : item), nextBindings)
  }
  return (
    <div className="dsflow-list">
      {items.map((item, index) => (
        <div key={index} className="dsflow-kv">
          <input className="dsflow-input dsflow-kv__key" placeholder={keyPlaceholder} value={item.name} onChange={(event) => { update(index, { name: event.target.value }) }} />
          <InlineTemplate value={item.value} bindings={bindings} options={options} t={t} onChange={(value, nextBindings) => { update(index, { value }, nextBindings) }} />
          <RemoveButton t={t} onClick={() => { onChange(items.filter((_, i) => i !== index)) }} />
        </div>
      ))}
      <AddButton label={addLabel} onClick={() => { onChange([...items, { name: '', value: '' }]) }} />
    </div>
  )
}

/** A single-line template with a compact variable picker. */
export function InlineTemplate({ value, bindings, options, t, placeholder, onChange }: {
  value: string
  bindings: readonly InputBinding[]
  options: readonly VariableOption[]
  t: Translate
  placeholder?: string
  onChange(text: string, bindings?: InputBinding[]): void
}): ReactNode {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="dsflow-inline-template">
      <input ref={ref} className="dsflow-input" value={value} placeholder={placeholder ?? t('value.enterText')} onChange={(event) => { onChange(event.target.value) }} />
      <select
        className="dsflow-input dsflow-input--insert"
        aria-label={t('template.reference')}
        title={t('template.reference')}
        value=""
        onChange={(event) => {
          const element = ref.current
          const start = element?.selectionStart ?? value.length
          const end = element?.selectionEnd ?? value.length
          const picked = event.target.value
          let name: string | undefined
          let nextBindings: InputBinding[] | undefined
          if (picked.startsWith('binding:')) name = picked.slice('binding:'.length)
          else {
            const option = options.find(candidate => candidate.key === picked)
            if (option === undefined) return
            const result = bindingForOption(bindings, option)
            name = result.binding.name
            if (result.added) nextBindings = [...bindings, result.binding]
          }
          onChange(insertText(value, start, end, `{{${name}}}`).text, nextBindings)
        }}
      >
        <option value="" disabled>{'{x}'}</option>
        {bindings.length > 0 && <optgroup label={t('inputs')}>{bindings.map(binding => <option key={binding.name} value={`binding:${binding.name}`}>{binding.name}</option>)}</optgroup>}
        <VariableOptions options={options} t={t} />
      </select>
    </div>
  )
}

/** The model picker; empty means the deployment default model. */
export function ModelSelect({ value, models, t, onChange }: { value: ModelSelection | undefined; models: ModelCatalog | undefined; t: Translate; onChange(value: ModelSelection | undefined): void }): ReactNode {
  const key = value === undefined ? '' : `${value.provider}\u0000${value.model}`
  const known = value === undefined || (models?.groups.some(group => group.id === value.provider && group.models.some(model => model.id === value.model)) ?? false)
  return (
    <select className="dsflow-input" value={key} onChange={(event) => {
      if (event.target.value === '') { onChange(undefined); return }
      const [provider, model] = event.target.value.split('\u0000')
      if (provider !== undefined && model !== undefined) onChange({ provider, model })
    }}>
      <option value="">{t('model.default')}{models === undefined ? '' : ` (${models.default.model})`}</option>
      {!known && value !== undefined && <option value={key}>{value.model}</option>}
      {models?.groups.map(group => (
        <optgroup key={group.id} label={group.name}>
          {group.models.map(model => <option key={model.id} value={`${group.id}\u0000${model.id}`}>{model.name}</option>)}
        </optgroup>
      ))}
    </select>
  )
}
