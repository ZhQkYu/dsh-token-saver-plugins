/**
 * Per-node-type settings forms. Every setting is edited with dedicated
 * controls (pickers, toggles, lists); nothing requires writing JSON.
 *
 * @module @dsh-plugins/flow-ui/client/editor/node-forms
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConditionBranch, ConditionOp, ErrorPolicy, FlowDocument, FlowLookup, FlowNode, InputBinding, JsonValue, ValueSource, VarField, VarSchema } from '@dsh-plugins/flow/spec'
import { CONDITION_OPS, MAX_NODE_RETRIES, NAME_PATTERN, defaultValue, isUnary, specOf, uniqueName } from '@dsh-plugins/flow/spec'
import type { CatalogFlow, ModelCatalog, ToolSummary } from '../api.ts'
import type { LocaleKey, Translate } from '../locales.ts'
import { newId } from './convert.ts'
import {
  AddButton, AddFromVariable, BindingsEditor, FieldListEditor, InlineTemplate, KeyValueList, LiteralEditor, ModelSelect,
  NumberField, RemoveButton, Section, Segmented, TemplateField, TypeSelect, ValuePicker,
} from './fields.tsx'
import { bodyOutputOptions, literalFor, sourceKey, syncSubflowInputs, syncToolArgs, toolParamChoices, toolParams, variableOptions, type VariableOption } from './variables.ts'

/** What the forms need besides the node. */
export interface FormContext {
  doc: FlowDocument
  lookup: FlowLookup
  t: Translate
  tools: ToolSummary[] | undefined
  models: ModelCatalog | undefined
  flows: CatalogFlow[]
  /** Whether the flow is guided: forms edit instructions for a model instead of engine settings. */
  guided: boolean
}

type NodeOf<T extends FlowNode['type']> = Extract<FlowNode, { type: T }>

interface FormProps<T extends FlowNode['type']> {
  node: NodeOf<T>
  ctx: FormContext
  options: VariableOption[]
  onChange(next: FlowNode): void
}

/** The settings form for a node. */
export function NodeForm({ node, ctx, onChange }: { node: FlowNode; ctx: FormContext; onChange(next: FlowNode): void }): ReactNode {
  const options = useMemo(() => variableOptions(ctx.doc, node.id, ctx.lookup), [ctx.doc, ctx.lookup, node.id])
  if (ctx.guided) {
    switch (node.type) {
      case 'end': return <GuidedEndForm node={node} ctx={ctx} options={options} onChange={onChange} />
      case 'agent': return <GuidedStepForm node={node} ctx={ctx} options={options} onChange={onChange} />
      case 'condition': return <GuidedConditionForm node={node} ctx={ctx} options={options} onChange={onChange} />
      case 'loop': return <GuidedLoopForm node={node} ctx={ctx} options={options} onChange={onChange} />
      default: break
    }
  }
  switch (node.type) {
    case 'start': return <StartForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'end': return <EndForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'llm': return <LlmForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'intent': return <IntentForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'agent': return <AgentForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'condition': return <ConditionForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'code': return <CodeForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'http': return <HttpForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'tool': return <ToolForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'text': return <TextForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'json': return <JsonForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'aggregate': return <AggregateForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'loop': return <LoopForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'batch': return <BatchForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'assign': return <AssignForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'subflow': return <SubflowForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'question': return <QuestionForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'message': return <MessageForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'comment': return <CommentForm node={node} ctx={ctx} options={options} onChange={onChange} />
    case 'break': case 'continue': return <div className="dsflow-hint">{ctx.t(`nodeHelp.${node.type}`)}</div>
  }
}

function InputsSection({ bindings, options, t, onChange }: { bindings: InputBinding[]; options: VariableOption[]; t: Translate; onChange(next: InputBinding[]): void }): ReactNode {
  return (
    <Section title={t('inputs')} hint={t('inputs.hint')}>
      <BindingsEditor bindings={bindings} options={options} t={t} onChange={onChange} />
    </Section>
  )
}

function seconds(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : ms / 1000
}

function millis(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 1000)
}

function withOptional<T extends object, K extends string, V>(data: T, key: K, value: V | undefined): T {
  const { [key]: _dropped, ...rest } = data as Record<string, unknown>
  return (value === undefined ? rest : { ...rest, [key]: value }) as T
}

function StartForm({ node, ctx, onChange }: FormProps<'start'>): ReactNode {
  const { t } = ctx
  return (
    <Section title={t('start.fields')} hint={t('start.hint')}>
      <FieldListEditor fields={node.data.fields} t={t} required describe defaults addLabel={t('start.addField')} namePrefix="input" onChange={(fields) => { onChange({ ...node, data: { fields } }) }} />
    </Section>
  )
}

function EndForm({ node, ctx, options, onChange }: FormProps<'end'>): ReactNode {
  const { t } = ctx
  const set = (patch: Partial<NodeOf<'end'>['data']>): void => { onChange({ ...node, data: { ...node.data, ...patch } }) }
  return (
    <>
      <Section title={t('end.mode')}>
        <Segmented
          value={node.data.mode}
          options={[{ value: 'variables', label: t('end.variables') }, { value: 'text', label: t('end.text') }]}
          onChange={(mode) => { set(mode === 'text' ? { mode, template: node.data.template ?? '' } : { mode }) }}
        />
      </Section>
      {node.data.mode === 'variables'
        ? (
          <Section title={t('end.outputs')} hint={t('end.outputsHint')}>
            <BindingsEditor bindings={node.data.inputs} options={options} t={t} addLabel={t('addOutput')} onChange={(inputs) => { set({ inputs }) }} />
          </Section>
        )
        : (
          <>
            <TemplateField label={t('end.template')} placeholder={t('end.templatePlaceholder')} value={node.data.template ?? ''} bindings={node.data.inputs} options={options} t={t} onChange={(template, inputs) => { set({ template, ...(inputs === undefined ? {} : { inputs }) }) }} />
            <InputsSection bindings={node.data.inputs} options={options} t={t} onChange={(inputs) => { set({ inputs }) }} />
          </>
        )}
    </>
  )
}

function OutputFormat({ fields, t, onChange }: { fields: VarField[] | undefined; t: Translate; onChange(fields: VarField[] | undefined): void }): ReactNode {
  return (
    <Section title={t('llm.output')}>
      <Segmented
        value={fields === undefined ? 'text' : 'json'}
        options={[{ value: 'text', label: t('llm.outputText') }, { value: 'json', label: t('llm.outputJson') }]}
        onChange={(format) => { onChange(format === 'text' ? undefined : fields ?? [{ name: 'result', schema: { type: 'string' }, required: true }]) }}
      />
      {fields === undefined
        ? <div className="dsflow-hint">{t('llm.outputTextHint')}</div>
        : (
          <>
            <div className="dsflow-hint">{t('llm.outputJsonHint')}</div>
            <FieldListEditor fields={fields} t={t} required describe addLabel={t('addOutput')} onChange={onChange} />
          </>
        )}
    </Section>
  )
}

function LlmForm({ node, ctx, options, onChange }: FormProps<'llm'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const set = (patch: Partial<NodeOf<'llm'>['data']>): void => { onChange({ ...node, data: { ...data, ...patch } }) }
  return (
    <>
      <Section title={t('llm.model')}>
        <ModelSelect value={data.model} models={ctx.models} t={t} onChange={(model) => { onChange({ ...node, data: withOptional(data, 'model', model) }) }} />
      </Section>
      <TemplateField label={t('llm.prompt')} placeholder={t('llm.promptPlaceholder')} value={data.prompt} bindings={data.inputs} options={options} t={t} onChange={(prompt, inputs) => { set({ prompt, ...(inputs === undefined ? {} : { inputs }) }) }} />
      <TemplateField label={t('llm.system')} placeholder={t('llm.systemPlaceholder')} value={data.system} bindings={data.inputs} options={options} t={t} onChange={(system, inputs) => { set({ system, ...(inputs === undefined ? {} : { inputs }) }) }} />
      <InputsSection bindings={data.inputs} options={options} t={t} onChange={(inputs) => { set({ inputs }) }} />
      <OutputFormat fields={data.output.format === 'json' ? data.output.fields : undefined} t={t} onChange={(fields) => { set({ output: fields === undefined ? { format: 'text' } : { format: 'json', fields } }) }} />
      <details className="dsflow-advanced">
        <summary>{t('advanced')}</summary>
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('llm.temperature')}</span>
          <NumberField value={data.temperature} min={0} max={2} step={0.1} placeholder={t('model.defaultValue')} onChange={(value) => { onChange({ ...node, data: withOptional(data, 'temperature', value) }) }} />
        </label>
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('llm.maxTokens')}</span>
          <NumberField value={data.maxTokens} min={1} placeholder={t('model.defaultValue')} onChange={(value) => { onChange({ ...node, data: withOptional(data, 'maxTokens', value) }) }} />
        </label>
      </details>
    </>
  )
}

function IntentForm({ node, ctx, options, onChange }: FormProps<'intent'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const set = (patch: Partial<NodeOf<'intent'>['data']>): void => { onChange({ ...node, data: { ...data, ...patch } }) }
  const updateIntent = (index: number, patch: Partial<NodeOf<'intent'>['data']['intents'][number]>): void => {
    set({ intents: data.intents.map((intent, i) => i === index ? { ...intent, ...patch } : intent) })
  }
  return (
    <>
      <TemplateField label={t('intent.query')} placeholder={t('intent.queryPlaceholder')} value={data.query} multiline={false} bindings={data.inputs} options={options} t={t} onChange={(query, inputs) => { set({ query, ...(inputs === undefined ? {} : { inputs }) }) }} />
      <Section title={t('intent.intents')} hint={t('intent.intentsHint')}>
        <div className="dsflow-list">
          {data.intents.map((intent, index) => (
            <div key={intent.id} className="dsflow-bind">
              <div className="dsflow-bind__row">
                <input className="dsflow-input" placeholder={t('intent.label')} value={intent.label} onChange={(event) => { updateIntent(index, { label: event.target.value }) }} />
                <RemoveButton t={t} onClick={() => { set({ intents: data.intents.filter((_, i) => i !== index) }) }} />
              </div>
              <input className="dsflow-input dsflow-input--quiet" placeholder={t('intent.description')} value={intent.description ?? ''} onChange={(event) => {
                const next = [...data.intents]
                next[index] = withOptional(intent, 'description', event.target.value === '' ? undefined : event.target.value)
                set({ intents: next })
              }} />
            </div>
          ))}
          <AddButton label={t('intent.add')} onClick={() => { set({ intents: [...data.intents, { id: newId('intent'), label: `${t('intent')} ${data.intents.length + 1}` }] }) }} />
        </div>
      </Section>
      <Section title={t('llm.model')}>
        <ModelSelect value={data.model} models={ctx.models} t={t} onChange={(model) => { onChange({ ...node, data: withOptional(data, 'model', model) }) }} />
      </Section>
      <InputsSection bindings={data.inputs} options={options} t={t} onChange={(inputs) => { set({ inputs }) }} />
      <details className="dsflow-advanced">
        <summary>{t('advanced')}</summary>
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('intent.instruction')}</span>
          <textarea className="dsflow-textarea dsflow-textarea--short" value={data.instruction ?? ''} onChange={(event) => { onChange({ ...node, data: withOptional(data, 'instruction', event.target.value === '' ? undefined : event.target.value) }) }} />
        </label>
      </details>
    </>
  )
}

function AgentForm({ node, ctx, options, onChange }: FormProps<'agent'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const set = (patch: Partial<NodeOf<'agent'>['data']>): void => { onChange({ ...node, data: { ...data, ...patch } }) }
  const allow = data.tools?.allow
  const [filter, setFilter] = useState('')
  const tools = (ctx.tools ?? []).filter(tool => filter === '' || tool.name.includes(filter.toLowerCase()))
  return (
    <>
      <TemplateField label={t('agent.prompt')} placeholder={t('agent.promptPlaceholder')} value={data.prompt} bindings={data.inputs} options={options} t={t} onChange={(prompt, inputs) => { set({ prompt, ...(inputs === undefined ? {} : { inputs }) }) }} />
      <label className="dsflow-field">
        <span className="dsflow-field__label">{t('agent.persona')}</span>
        <textarea className="dsflow-textarea dsflow-textarea--short" placeholder={t('agent.personaPlaceholder')} value={data.persona ?? ''} onChange={(event) => { onChange({ ...node, data: withOptional(data, 'persona', event.target.value === '' ? undefined : event.target.value) }) }} />
      </label>
      <Section title={t('agent.tools')}>
        <Segmented
          value={allow === undefined ? 'all' : 'some'}
          options={[{ value: 'all', label: t('agent.toolsAll') }, { value: 'some', label: t('agent.toolsSome') }]}
          onChange={(mode) => { onChange({ ...node, data: withOptional(data, 'tools', mode === 'all' ? undefined : { allow: allow ?? [] }) }) }}
        />
        {allow !== undefined && (
          <div className="dsflow-checklist">
            <input className="dsflow-input dsflow-input--quiet" placeholder={t('agent.toolsFilter')} value={filter} onChange={(event) => { setFilter(event.target.value) }} />
            {tools.map(tool => (
              <label key={tool.name} className="dsflow-check" title={tool.description}>
                <input type="checkbox" checked={allow.includes(tool.name)} onChange={(event) => {
                  set({ tools: { allow: event.target.checked ? [...allow, tool.name] : allow.filter(name => name !== tool.name) } })
                }} />
                {tool.name}
              </label>
            ))}
          </div>
        )}
      </Section>
      <Section title={t('llm.model')}>
        <ModelSelect value={data.model} models={ctx.models} t={t} onChange={(model) => { onChange({ ...node, data: withOptional(data, 'model', model) }) }} />
      </Section>
      <InputsSection bindings={data.inputs} options={options} t={t} onChange={(inputs) => { set({ inputs }) }} />
      <OutputFormat fields={data.outputs} t={t} onChange={(fields) => { onChange({ ...node, data: withOptional(data, 'outputs', fields) }) }} />
    </>
  )
}

const OPS_BY_TYPE: Record<string, readonly ConditionOp[]> = {
  string: ['eq', 'ne', 'contains', 'not_contains', 'empty', 'not_empty', 'len_gt', 'len_ge', 'len_lt', 'len_le', 'matches'],
  number: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'empty', 'not_empty'],
  integer: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'empty', 'not_empty'],
  boolean: ['is_true', 'is_false', 'eq', 'ne', 'empty', 'not_empty'],
  array: ['contains', 'not_contains', 'empty', 'not_empty', 'len_gt', 'len_ge', 'len_lt', 'len_le'],
  object: ['contains_key', 'not_contains_key', 'empty', 'not_empty'],
  any: CONDITION_OPS,
}

function rightSchema(op: ConditionOp, left: VarSchema): VarSchema {
  switch (op) {
    case 'len_gt': case 'len_ge': case 'len_lt': case 'len_le': return { type: 'integer' }
    case 'gt': case 'ge': case 'lt': case 'le': return { type: 'number' }
    case 'matches': case 'contains_key': case 'not_contains_key': return { type: 'string' }
    case 'contains': case 'not_contains': return left.type === 'array' ? left.items ?? { type: 'string' } : { type: 'string' }
    default: return left.type === 'any' || left.type === 'object' || left.type === 'array' ? { type: 'string' } : left
  }
}

function schemaOf(options: readonly VariableOption[], source: ValueSource): VarSchema {
  return options.find(option => option.key === sourceKey(source))?.schema ?? { type: 'string' }
}

function emptyCondition(): ConditionBranch['conditions'][number] {
  return { left: { kind: 'literal', value: '' }, op: 'eq', right: { kind: 'literal', value: '' } }
}

function ConditionForm({ node, ctx, options, onChange }: FormProps<'condition'>): ReactNode {
  const { t } = ctx
  const branches = node.data.branches
  const setBranches = (next: ConditionBranch[]): void => { onChange({ ...node, data: { branches: next } }) }
  const updateBranch = (index: number, patch: Partial<ConditionBranch>): void => { setBranches(branches.map((branch, i) => i === index ? { ...branch, ...patch } : branch)) }
  return (
    <>
      <div className="dsflow-hint">{t('condition.hint')}</div>
      {branches.map((branch, bi) => (
        <div key={branch.id} className="dsflow-card">
          <div className="dsflow-card__head">
            <span className="dsflow-card__index">{bi === 0 ? t('condition.if') : t('condition.elseIf')}</span>
            <input className="dsflow-input" aria-label={t('condition.label')} placeholder={t('condition.label')} value={branch.label} onChange={(event) => { updateBranch(bi, { label: event.target.value }) }} />
            <RemoveButton t={t} onClick={() => { setBranches(branches.filter((_, i) => i !== bi)) }} />
          </div>
          {branch.conditions.length > 1 && (
            <Segmented value={branch.logic} options={[{ value: 'and', label: t('condition.and') }, { value: 'or', label: t('condition.or') }]} onChange={(logic) => { updateBranch(bi, { logic }) }} />
          )}
          {branch.conditions.map((condition, ci) => {
            const left = schemaOf(options, condition.left)
            const ops = OPS_BY_TYPE[left.type] ?? CONDITION_OPS
            const shown = ops.includes(condition.op) ? ops : [condition.op, ...ops]
            const updateCondition = (patch: Partial<typeof condition>): void => {
              updateBranch(bi, { conditions: branch.conditions.map((current, i) => i === ci ? { ...current, ...patch } : current) })
            }
            return (
              <div key={ci} className="dsflow-cond">
                <div className="dsflow-bind__row">
                  <ValuePicker value={condition.left} schema={left} options={options} t={t} literal={false} onChange={(value, schema) => {
                    const nextLeft = schema ?? left
                    const nextOps = OPS_BY_TYPE[nextLeft.type] ?? CONDITION_OPS
                    const op = nextOps.includes(condition.op) ? condition.op : nextOps[0] ?? 'eq'
                    updateCondition({ left: value, op, ...(isUnary(op) ? {} : { right: condition.right?.kind === 'ref' ? condition.right : literalFor(rightSchema(op, nextLeft)) }) })
                  }} />
                  <RemoveButton t={t} onClick={() => { updateBranch(bi, { conditions: branch.conditions.filter((_, i) => i !== ci) }) }} />
                </div>
                <div className="dsflow-bind__row">
                  <select className="dsflow-input dsflow-input--op" aria-label={t('condition.op')} value={condition.op} onChange={(event) => {
                    const op = event.target.value as ConditionOp
                    if (isUnary(op)) {
                      const { right: _dropped, ...rest } = condition
                      updateBranch(bi, { conditions: branch.conditions.map((current, i) => i === ci ? { ...rest, op } : current) })
                    } else {
                      updateCondition({ op, right: condition.right?.kind === 'ref' ? condition.right : literalFor(rightSchema(op, left)) })
                    }
                  }}>
                    {shown.map(op => <option key={op} value={op}>{t(`op.${op}` as LocaleKey)}</option>)}
                  </select>
                  {!isUnary(condition.op) && (
                    <ValuePicker value={condition.right ?? literalFor(rightSchema(condition.op, left))} schema={rightSchema(condition.op, left)} options={options} t={t} onChange={(right) => { updateCondition({ right }) }} />
                  )}
                </div>
              </div>
            )
          })}
          <AddButton label={t('condition.addCondition')} onClick={() => { updateBranch(bi, { conditions: [...branch.conditions, emptyCondition()] }) }} />
        </div>
      ))}
      <AddButton label={t('condition.addBranch')} onClick={() => { setBranches([...branches, { id: newId('branch'), label: `${t('branch')} ${branches.length + 1}`, logic: 'and', conditions: [emptyCondition()] }]) }} />
      <div className="dsflow-card dsflow-card--else">
        <span className="dsflow-card__index">{t('condition.else')}</span>
        <span className="dsflow-hint">{t('condition.elseHint')}</span>
      </div>
    </>
  )
}

function CodeForm({ node, ctx, options, onChange }: FormProps<'code'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const set = (patch: Partial<NodeOf<'code'>['data']>): void => { onChange({ ...node, data: { ...data, ...patch } }) }
  return (
    <>
      <Section title={t('inputs')} hint={t('code.inputsHint')}>
        <BindingsEditor bindings={data.inputs} options={options} t={t} onChange={(inputs) => { set({ inputs }) }} />
      </Section>
      <Section title={t('code.code')} hint={t('code.hint')}>
        <textarea className="dsflow-textarea dsflow-textarea--mono dsflow-textarea--code" spellCheck={false} value={data.code} onChange={(event) => { set({ code: event.target.value }) }} onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          event.preventDefault()
          const element = event.currentTarget
          const start = element.selectionStart
          const next = `${data.code.slice(0, start)}  ${data.code.slice(element.selectionEnd)}`
          set({ code: next })
          requestAnimationFrame(() => { element.setSelectionRange(start + 2, start + 2) })
        }} />
      </Section>
      <Section title={t('outputs')} hint={t('code.outputsHint')}>
        <FieldListEditor fields={data.outputs} t={t} addLabel={t('addOutput')} namePrefix="result" onChange={(outputs) => { set({ outputs }) }} />
      </Section>
      <details className="dsflow-advanced">
        <summary>{t('advanced')}</summary>
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('timeoutSeconds')}</span>
          <NumberField value={seconds(data.timeoutMs)} min={1} placeholder={t('model.defaultValue')} onChange={(value) => { onChange({ ...node, data: withOptional(data, 'timeoutMs', millis(value)) }) }} />
        </label>
      </details>
    </>
  )
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const

function HttpForm({ node, ctx, options, onChange }: FormProps<'http'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const set = (patch: Partial<NodeOf<'http'>['data']>, inputs?: InputBinding[]): void => { onChange({ ...node, data: { ...data, ...patch, ...(inputs === undefined ? {} : { inputs }) } }) }
  const body = data.body
  return (
    <>
      <Section title={t('http.request')}>
        <div className="dsflow-bind__row">
          <select className="dsflow-input dsflow-input--method" aria-label={t('http.method')} value={data.method} onChange={(event) => { set({ method: event.target.value as NodeOf<'http'>['data']['method'] }) }}>
            {HTTP_METHODS.map(method => <option key={method} value={method}>{method}</option>)}
          </select>
          <InlineTemplate value={data.url} bindings={data.inputs} options={options} t={t} placeholder="https://example.com/api/{{id}}" onChange={(url, inputs) => { set({ url }, inputs) }} />
        </div>
      </Section>
      <Section title={t('http.headers')}>
        <KeyValueList items={data.headers} bindings={data.inputs} options={options} t={t} addLabel={t('http.addHeader')} keyPlaceholder="Header" onChange={(headers, inputs) => { set({ headers }, inputs) }} />
      </Section>
      <Section title={t('http.query')}>
        <KeyValueList items={data.query} bindings={data.inputs} options={options} t={t} addLabel={t('http.addQuery')} keyPlaceholder={t('name')} onChange={(query, inputs) => { set({ query }, inputs) }} />
      </Section>
      {data.method !== 'GET' && data.method !== 'HEAD' && (
        <Section title={t('http.body')}>
          <Segmented
            value={body.kind}
            options={[{ value: 'none', label: t('http.bodyNone') }, { value: 'json', label: 'JSON' }, { value: 'text', label: t('http.bodyText') }, { value: 'form', label: t('http.bodyForm') }]}
            onChange={(kind) => {
              if (kind === 'none') set({ body: { kind } })
              else if (kind === 'form') set({ body: { kind, fields: body.kind === 'form' ? body.fields : [] } })
              else set({ body: { kind, template: body.kind === 'json' || body.kind === 'text' ? body.template : kind === 'json' ? '{\n  \n}' : '' } })
            }}
          />
          {(body.kind === 'json' || body.kind === 'text') && (
            <TemplateField value={body.template} mono={body.kind === 'json'} bindings={data.inputs} options={options} t={t} hint={body.kind === 'json' ? t('http.jsonHint') : undefined} onChange={(template, inputs) => { set({ body: { kind: body.kind, template } }, inputs) }} />
          )}
          {body.kind === 'form' && (
            <KeyValueList items={body.fields} bindings={data.inputs} options={options} t={t} addLabel={t('http.addField')} keyPlaceholder={t('name')} onChange={(fields, inputs) => { set({ body: { kind: 'form', fields } }, inputs) }} />
          )}
        </Section>
      )}
      <InputsSection bindings={data.inputs} options={options} t={t} onChange={(inputs) => { set({}, inputs) }} />
      <div className="dsflow-hint">{t('http.outputsHint')}</div>
      <details className="dsflow-advanced">
        <summary>{t('advanced')}</summary>
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('timeoutSeconds')}</span>
          <NumberField value={seconds(data.timeoutMs)} min={1} placeholder={t('model.defaultValue')} onChange={(value) => { onChange({ ...node, data: withOptional(data, 'timeoutMs', millis(value)) }) }} />
        </label>
      </details>
    </>
  )
}

function ToolForm({ node, ctx, options, onChange }: FormProps<'tool'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const tool = ctx.tools?.find(candidate => candidate.name === data.tool)
  const params = useMemo(() => tool === undefined ? undefined : toolParams(tool.parameters), [tool])
  const optional = params?.filter(param => param.required !== true && !data.args.some(arg => arg.name === param.name)) ?? []
  const [manual, setManual] = useState(false)
  const known = data.tool === '' || tool !== undefined
  const setTool = (name: string): void => {
    const next = ctx.tools?.find(candidate => candidate.name === name)
    onChange({ ...node, data: { tool: name, args: next === undefined ? data.args : syncToolArgs(toolParams(next.parameters), data.args) } })
  }
  return (
    <>
      <Section title={t('tool.tool')}>
        {manual || (ctx.tools !== undefined && ctx.tools.length === 0)
          ? <input className="dsflow-input" placeholder={t('tool.manualPlaceholder')} value={data.tool} onChange={(event) => { setTool(event.target.value.trim()) }} />
          : (
            <select className="dsflow-input" value={data.tool} onChange={(event) => { if (event.target.value === '__manual') setManual(true); else setTool(event.target.value) }}>
              <option value="" disabled>{ctx.tools === undefined ? t('loading') : t('tool.pick')}</option>
              {!known && <option value={data.tool}>{data.tool} ({t('tool.unregistered')})</option>}
              {ctx.tools?.map(candidate => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}
              <option value="__manual">{t('tool.manual')}</option>
            </select>
          )}
        {tool !== undefined && tool.description !== '' && <div className="dsflow-hint dsflow-hint--clamp" title={tool.description}>{tool.description}</div>}
      </Section>
      {data.tool !== '' && (
        <Section title={t('tool.params')} hint={params === undefined ? t('tool.paramsUnknown') : params.length === 0 ? t('tool.noParams') : undefined}>
          {params === undefined
            ? <BindingsEditor bindings={data.args} options={options} t={t} addLabel={t('tool.addParam')} onChange={(args) => { onChange({ ...node, data: { ...data, args } }) }} />
            : (
              <>
                <BindingsEditor
                  bindings={data.args}
                  options={options}
                  t={t}
                  fixed
                  removable={binding => binding.required === false}
                  describe={binding => params.find(param => param.name === binding.name)?.description}
                  choices={binding => tool === undefined ? undefined : toolParamChoices(tool.parameters, binding.name)}
                  onChange={(args) => { onChange({ ...node, data: { ...data, args: syncToolArgs(params, args) } }) }}
                />
                {optional.length > 0 && (
                  <select className="dsflow-input dsflow-add-select" value="" onChange={(event) => {
                    const param = optional.find(candidate => candidate.name === event.target.value)
                    if (param !== undefined) onChange({ ...node, data: { ...data, args: [...data.args, { name: param.name, schema: param.schema, value: literalFor(param.schema), required: false }] } })
                  }}>
                    <option value="" disabled>+ {t('tool.addOptional')}</option>
                    {optional.map(param => <option key={param.name} value={param.name} title={param.description}>{param.name}</option>)}
                  </select>
                )}
              </>
            )}
        </Section>
      )}
      <div className="dsflow-hint">{t('tool.outputsHint')}</div>
    </>
  )
}

const DELIMITERS: { value: string; label: LocaleKey }[] = [
  { value: ',', label: 'text.comma' },
  { value: '\n', label: 'text.newline' },
  { value: ';', label: 'text.semicolon' },
  { value: ' ', label: 'text.space' },
  { value: '\t', label: 'text.tab' },
  { value: '|', label: 'text.pipe' },
]

function TextForm({ node, ctx, options, onChange }: FormProps<'text'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const [custom, setCustom] = useState('')
  return (
    <>
      <Segmented
        value={data.op}
        options={[{ value: 'concat', label: t('text.concat') }, { value: 'split', label: t('text.split') }]}
        onChange={(op) => {
          if (op === data.op) return
          onChange({ ...node, data: op === 'concat' ? { op, inputs: [], template: '' } : { op, input: { kind: 'literal', value: '' }, delimiters: [','] } })
        }}
      />
      {data.op === 'concat'
        ? (
          <>
            <TemplateField label={t('text.template')} placeholder={t('text.templatePlaceholder')} value={data.template} bindings={data.inputs} options={options} t={t} onChange={(template, inputs) => { onChange({ ...node, data: { ...data, template, ...(inputs === undefined ? {} : { inputs }) } }) }} />
            <InputsSection bindings={data.inputs} options={options} t={t} onChange={(inputs) => { onChange({ ...node, data: { ...data, inputs } }) }} />
          </>
        )
        : (
          <>
            <Section title={t('text.input')}>
              <ValuePicker value={data.input} schema={{ type: 'string' }} options={options} t={t} onChange={(input) => { onChange({ ...node, data: { ...data, input } }) }} />
            </Section>
            <Section title={t('text.delimiters')}>
              <div className="dsflow-chips">
                {DELIMITERS.map(delimiter => (
                  <label key={delimiter.label} className="dsflow-check">
                    <input type="checkbox" checked={data.delimiters.includes(delimiter.value)} onChange={(event) => {
                      onChange({ ...node, data: { ...data, delimiters: event.target.checked ? [...data.delimiters, delimiter.value] : data.delimiters.filter(value => value !== delimiter.value) } })
                    }} />
                    {t(delimiter.label)}
                  </label>
                ))}
                {data.delimiters.filter(value => !DELIMITERS.some(delimiter => delimiter.value === value)).map(value => (
                  <span key={value} className="dsflow-chip">{value}<RemoveButton t={t} onClick={() => { onChange({ ...node, data: { ...data, delimiters: data.delimiters.filter(other => other !== value) } }) }} /></span>
                ))}
              </div>
              <div className="dsflow-bind__row">
                <input className="dsflow-input" placeholder={t('text.custom')} value={custom} onChange={(event) => { setCustom(event.target.value) }} />
                <AddButton label={t('add')} onClick={() => {
                  if (custom === '' || data.delimiters.includes(custom)) return
                  onChange({ ...node, data: { ...data, delimiters: [...data.delimiters, custom] } })
                  setCustom('')
                }} />
              </div>
            </Section>
          </>
        )}
    </>
  )
}

function JsonForm({ node, ctx, options, onChange }: FormProps<'json'>): ReactNode {
  const { t } = ctx
  const data = node.data
  return (
    <>
      <Segmented
        value={data.op}
        options={[{ value: 'parse', label: t('json.parse') }, { value: 'stringify', label: t('json.stringify') }]}
        onChange={(op) => { if (op !== data.op) onChange({ ...node, data: op === 'parse' ? { op, input: data.input } : { op, input: data.input, pretty: true } }) }}
      />
      <Section title={t('json.input')} hint={data.op === 'parse' ? t('json.parseHint') : t('json.stringifyHint')}>
        <ValuePicker value={data.input} schema={data.op === 'parse' ? { type: 'string' } : { type: 'any' }} options={options} t={t} multiline onChange={(input) => { onChange({ ...node, data: { ...data, input } }) }} />
      </Section>
      {data.op === 'parse'
        ? (
          <Section title={t('outputs')}>
            <Segmented
              value={data.outputs === undefined ? 'value' : 'fields'}
              options={[{ value: 'value', label: t('json.whole') }, { value: 'fields', label: t('json.fields') }]}
              onChange={(mode) => { onChange({ ...node, data: withOptional(data, 'outputs', mode === 'value' ? undefined : data.outputs ?? [{ name: 'field', schema: { type: 'string' } }]) }) }}
            />
            {data.outputs !== undefined && <FieldListEditor fields={data.outputs} t={t} required addLabel={t('addOutput')} onChange={(outputs) => { onChange({ ...node, data: { ...data, outputs } }) }} />}
          </Section>
        )
        : (
          <label className="dsflow-check">
            <input type="checkbox" checked={data.pretty === true} onChange={(event) => { onChange({ ...node, data: { ...data, pretty: event.target.checked } }) }} />
            {t('json.pretty')}
          </label>
        )}
    </>
  )
}

function RefList({ values, options, t, addLabel, onChange }: { values: ValueSource[]; options: VariableOption[]; t: Translate; addLabel: string; onChange(values: ValueSource[], picked?: VariableOption): void }): ReactNode {
  return (
    <div className="dsflow-list">
      {values.map((value, index) => (
        <div key={index} className="dsflow-bind__row">
          <ValuePicker value={value} schema={schemaOf(options, value)} options={options} t={t} literal={false} onChange={(next) => { onChange(values.map((current, i) => i === index ? next : current)) }} />
          <RemoveButton t={t} onClick={() => { onChange(values.filter((_, i) => i !== index)) }} />
        </div>
      ))}
      <AddFromVariable label={addLabel} options={options} t={t} onPick={(option) => { if (option !== undefined) onChange([...values, option.source], option) }} />
    </div>
  )
}

function AggregateForm({ node, ctx, options, onChange }: FormProps<'aggregate'>): ReactNode {
  const { t } = ctx
  const groups = node.data.groups
  const setGroups = (next: typeof groups): void => { onChange({ ...node, data: { groups: next } }) }
  const update = (index: number, patch: Partial<(typeof groups)[number]>): void => { setGroups(groups.map((group, i) => i === index ? { ...group, ...patch } : group)) }
  return (
    <>
      <div className="dsflow-hint">{t('aggregate.hint')}</div>
      {groups.map((group, index) => (
        <div key={index} className="dsflow-card">
          <div className="dsflow-card__head">
            <input className="dsflow-input dsflow-bind__name" aria-label={t('name')} aria-invalid={!NAME_PATTERN.test(group.name)} value={group.name} onChange={(event) => { update(index, { name: event.target.value }) }} />
            <TypeSelect schema={group.schema} t={t} onChange={(schema) => { update(index, { schema }) }} />
            <RemoveButton t={t} onClick={() => { setGroups(groups.filter((_, i) => i !== index)) }} />
          </div>
          <RefList values={group.candidates} options={options} t={t} addLabel={t('aggregate.addCandidate')} onChange={(candidates, picked) => {
            update(index, { candidates, ...(group.candidates.length === 0 && picked !== undefined ? { schema: picked.schema } : {}) })
          }} />
        </div>
      ))}
      <AddButton label={t('aggregate.addGroup')} onClick={() => { setGroups([...groups, { name: uniqueName('result', new Set(groups.map(group => group.name))), schema: { type: 'any' }, candidates: [] }]) }} />
    </>
  )
}

function CollectedOutputs({ outputs, options, t, onChange }: { outputs: { name: string; value: ValueSource }[]; options: VariableOption[]; t: Translate; onChange(next: { name: string; value: ValueSource }[]): void }): ReactNode {
  return (
    <div className="dsflow-list">
      {outputs.map((output, index) => (
        <div key={index} className="dsflow-bind__row">
          <input className="dsflow-input dsflow-bind__name" aria-label={t('name')} aria-invalid={!NAME_PATTERN.test(output.name)} value={output.name} onChange={(event) => { onChange(outputs.map((current, i) => i === index ? { ...current, name: event.target.value } : current)) }} />
          <ValuePicker value={output.value} schema={schemaOf(options, output.value)} options={options} t={t} literal={false} onChange={(value) => { onChange(outputs.map((current, i) => i === index ? { ...current, value } : current)) }} />
          <RemoveButton t={t} onClick={() => { onChange(outputs.filter((_, i) => i !== index)) }} />
        </div>
      ))}
      <AddFromVariable label={t('addOutput')} options={options} t={t} onPick={(option) => {
        if (option === undefined) return
        const name = uniqueName(option.source.path[option.source.path.length - 1] ?? 'result', new Set(outputs.map(output => output.name)))
        onChange([...outputs, { name, value: option.source }])
      }} />
    </div>
  )
}

function LoopForm({ node, ctx, options, onChange }: FormProps<'loop'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const set = (patch: Partial<NodeOf<'loop'>['data']>): void => { onChange({ ...node, data: { ...data, ...patch } }) }
  const body = useMemo(() => bodyOutputOptions(ctx.doc, node.id, ctx.lookup), [ctx.doc, ctx.lookup, node.id])
  const variables: InputBinding[] = data.variables.map(variable => ({ name: variable.name, schema: variable.schema, value: variable.initial }))
  return (
    <>
      <Section title={t('loop.mode')}>
        <Segmented
          value={data.mode}
          options={[{ value: 'array', label: t('loop.mode.array') }, { value: 'count', label: t('loop.mode.count') }, { value: 'infinite', label: t('loop.mode.infinite') }]}
          onChange={(mode) => { set({ mode }) }}
        />
        {data.mode === 'array' && (
          <ValuePicker value={data.array ?? { kind: 'literal', value: [] }} schema={{ type: 'array' }} options={options} t={t} onChange={(array) => { set({ array }) }} />
        )}
        {data.mode === 'count' && (
          <ValuePicker value={data.count ?? { kind: 'literal', value: 3 }} schema={{ type: 'integer' }} options={options} t={t} onChange={(count) => { set({ count }) }} />
        )}
        <div className="dsflow-hint">{t(`loop.modeHint.${data.mode}` as LocaleKey)}</div>
      </Section>
      <label className="dsflow-field">
        <span className="dsflow-field__label">{t('loop.maxIterations')}</span>
        <NumberField value={data.maxIterations} min={1} onChange={(value) => { set({ maxIterations: value ?? 1 }) }} />
      </label>
      <Section title={t('loop.variables')} hint={t('loop.variablesHint')}>
        <BindingsEditor bindings={variables} options={options} t={t} addLabel={t('loop.addVariable')} onChange={(next) => { set({ variables: next.map(variable => ({ name: variable.name, schema: variable.schema, initial: variable.value })) }) }} />
      </Section>
      <Section title={t('loop.outputs')} hint={t('loop.outputsHint')}>
        <CollectedOutputs outputs={data.outputs} options={body} t={t} onChange={(outputs) => { set({ outputs }) }} />
      </Section>
    </>
  )
}

function BatchForm({ node, ctx, options, onChange }: FormProps<'batch'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const set = (patch: Partial<NodeOf<'batch'>['data']>): void => { onChange({ ...node, data: { ...data, ...patch } }) }
  const body = useMemo(() => bodyOutputOptions(ctx.doc, node.id, ctx.lookup), [ctx.doc, ctx.lookup, node.id])
  return (
    <>
      <Section title={t('batch.array')} hint={t('batch.arrayHint')}>
        <ValuePicker value={data.array} schema={{ type: 'array' }} options={options} t={t} onChange={(array) => { set({ array }) }} />
      </Section>
      <div className="dsflow-bind__row">
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('batch.concurrency')}</span>
          <NumberField value={data.concurrency} min={1} onChange={(value) => { set({ concurrency: value ?? 1 }) }} />
        </label>
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('batch.maxItems')}</span>
          <NumberField value={data.maxItems} min={1} onChange={(value) => { set({ maxItems: value ?? 1 }) }} />
        </label>
      </div>
      <Section title={t('loop.outputs')} hint={t('batch.outputsHint')}>
        <CollectedOutputs outputs={data.outputs} options={body} t={t} onChange={(outputs) => { set({ outputs }) }} />
      </Section>
    </>
  )
}

function enclosingLoop(doc: FlowDocument, node: FlowNode): NodeOf<'loop'> | undefined {
  let parentId = node.parentId
  while (parentId !== undefined) {
    const parent = doc.nodes.find(candidate => candidate.id === parentId)
    if (parent === undefined) return undefined
    if (parent.type === 'loop') return parent
    parentId = parent.parentId
  }
  return undefined
}

function AssignForm({ node, ctx, options, onChange }: FormProps<'assign'>): ReactNode {
  const { t } = ctx
  const loop = enclosingLoop(ctx.doc, node)
  const variables = loop?.data.variables ?? []
  const assignments = node.data.assignments
  const setAssignments = (next: typeof assignments): void => { onChange({ ...node, data: { assignments: next } }) }
  if (loop === undefined) return <div className="dsflow-error">{t('assign.noLoop')}</div>
  if (variables.length === 0) return <div className="dsflow-hint">{t('assign.noVariables')}</div>
  return (
    <>
      <div className="dsflow-hint">{t('assign.hint')}</div>
      <div className="dsflow-list">
        {assignments.map((assignment, index) => {
          const variable = variables.find(candidate => candidate.name === assignment.variable)
          return (
            <div key={index} className="dsflow-bind__row">
              <select className="dsflow-input dsflow-bind__name" aria-label={t('assign.variable')} value={assignment.variable} onChange={(event) => { setAssignments(assignments.map((current, i) => i === index ? { ...current, variable: event.target.value } : current)) }}>
                {variable === undefined && <option value={assignment.variable}>{assignment.variable}</option>}
                {variables.map(candidate => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}
              </select>
              <span className="dsflow-muted">=</span>
              <ValuePicker value={assignment.value} schema={variable?.schema ?? { type: 'any' }} options={options} t={t} onChange={(value) => { setAssignments(assignments.map((current, i) => i === index ? { ...current, value } : current)) }} />
              <RemoveButton t={t} onClick={() => { setAssignments(assignments.filter((_, i) => i !== index)) }} />
            </div>
          )
        })}
        <AddButton label={t('assign.add')} onClick={() => {
          const free = variables.find(candidate => !assignments.some(assignment => assignment.variable === candidate.name)) ?? variables[0]
          if (free !== undefined) setAssignments([...assignments, { variable: free.name, value: literalFor(free.schema) }])
        }} />
      </div>
    </>
  )
}

function SubflowForm({ node, ctx, options, onChange }: FormProps<'subflow'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const entry = ctx.flows.find(flow => flow.id === data.flowId)
  const resolved = data.flowId === '' ? undefined : ctx.lookup(data.flowId, data.version)
  const synced = resolved === undefined ? data.inputs : syncSubflowInputs(resolved.inputs, data.inputs)
  const stale = JSON.stringify(synced) !== JSON.stringify(data.inputs)
  useEffect(() => { if (stale) onChange({ ...node, data: { ...data, inputs: synced } }) })
  const choose = (flowId: string, version: 'published' | 'draft'): void => {
    const next = ctx.lookup(flowId, version)
    onChange({ ...node, data: { flowId, version, inputs: next === undefined ? [] : syncSubflowInputs(next.inputs, data.inputs) } })
  }
  return (
    <>
      <Section title={t('subflow.flow')}>
        <select className="dsflow-input" value={data.flowId} onChange={(event) => {
          const picked = ctx.flows.find(flow => flow.id === event.target.value)
          choose(event.target.value, picked?.published === undefined ? 'draft' : data.version)
        }}>
          <option value="" disabled>{t('subflow.pick')}</option>
          {data.flowId !== '' && entry === undefined && <option value={data.flowId}>{data.flowId} ({t('subflow.missing')})</option>}
          {ctx.flows.filter(flow => flow.id !== ctx.doc.id).map(flow => <option key={flow.id} value={flow.id}>{flow.name}{flow.published === undefined ? ` (${t('subflow.unpublished')})` : ` v${flow.published.version}`}</option>)}
        </select>
        {data.flowId !== '' && (
          <Segmented
            value={data.version}
            options={[{ value: 'published', label: t('subflow.published') }, { value: 'draft', label: t('subflow.draft') }]}
            onChange={(version) => { choose(data.flowId, version) }}
          />
        )}
        {data.flowId !== '' && resolved === undefined && <div className="dsflow-error">{t('subflow.notAvailable')}</div>}
      </Section>
      {resolved !== undefined && (
        <>
          <Section title={t('inputs')} hint={resolved.inputs.length === 0 ? t('subflow.noInputs') : undefined}>
            <BindingsEditor bindings={synced} options={options} t={t} fixed removable={false} onChange={(inputs) => { onChange({ ...node, data: { ...data, inputs } }) }} />
          </Section>
          <div className="dsflow-hint">{t('outputs')}: {resolved.outputs.map(field => field.name).join(', ') || '—'}</div>
        </>
      )}
    </>
  )
}

function QuestionForm({ node, ctx, options, onChange }: FormProps<'question'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const set = (patch: Partial<NodeOf<'question'>['data']>): void => { onChange({ ...node, data: { ...data, ...patch } }) }
  const answer = data.answer
  return (
    <>
      <TemplateField label={t('question.question')} placeholder={t('question.placeholder')} value={data.question} bindings={data.inputs} options={options} t={t} onChange={(question, inputs) => { set({ question, ...(inputs === undefined ? {} : { inputs }) }) }} />
      <Section title={t('question.answer')}>
        <Segmented
          value={answer.kind}
          options={[{ value: 'text', label: t('question.free') }, { value: 'options', label: t('question.options') }]}
          onChange={(kind) => { set({ answer: kind === 'text' ? { kind } : { kind, options: answer.kind === 'options' ? answer.options : [{ id: newId('option'), label: t('value.true') }, { id: newId('option'), label: t('value.false') }], allowOther: false } }) }}
        />
        {answer.kind === 'options' && (
          <div className="dsflow-list">
            <div className="dsflow-hint">{t('question.optionsHint')}</div>
            {answer.options.map((option, index) => (
              <div key={option.id} className="dsflow-bind__row">
                <input className="dsflow-input" value={option.label} placeholder={t('question.optionLabel')} onChange={(event) => { set({ answer: { ...answer, options: answer.options.map((current, i) => i === index ? { ...current, label: event.target.value } : current) } }) }} />
                <RemoveButton t={t} onClick={() => { set({ answer: { ...answer, options: answer.options.filter((_, i) => i !== index) } }) }} />
              </div>
            ))}
            <AddButton label={t('question.addOption')} onClick={() => { set({ answer: { ...answer, options: [...answer.options, { id: newId('option'), label: '' }] } }) }} />
            <label className="dsflow-check">
              <input type="checkbox" checked={answer.allowOther} onChange={(event) => { set({ answer: { ...answer, allowOther: event.target.checked } }) }} />
              {t('question.allowOther')}
            </label>
          </div>
        )}
      </Section>
      <InputsSection bindings={data.inputs} options={options} t={t} onChange={(inputs) => { set({ inputs }) }} />
      <details className="dsflow-advanced">
        <summary>{t('advanced')}</summary>
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('question.timeout')}</span>
          <NumberField value={seconds(data.timeoutMs)} min={1} placeholder={t('question.noTimeout')} onChange={(value) => { onChange({ ...node, data: withOptional(data, 'timeoutMs', millis(value)) }) }} />
        </label>
      </details>
    </>
  )
}

function MessageForm({ node, ctx, options, onChange }: FormProps<'message'>): ReactNode {
  const { t } = ctx
  const data = node.data
  return (
    <>
      <TemplateField label={t('message.template')} placeholder={t('message.placeholder')} value={data.template} bindings={data.inputs} options={options} t={t} onChange={(template, inputs) => { onChange({ ...node, data: { ...data, template, ...(inputs === undefined ? {} : { inputs }) } }) }} />
      <InputsSection bindings={data.inputs} options={options} t={t} onChange={(inputs) => { onChange({ ...node, data: { ...data, inputs } }) }} />
    </>
  )
}

function CommentForm({ node, ctx, onChange }: FormProps<'comment'>): ReactNode {
  return (
    <textarea className="dsflow-textarea" placeholder={ctx.t('comment.placeholder')} value={node.data.text} onChange={(event) => { onChange({ ...node, data: { text: event.target.value } }) }} />
  )
}

function GuidedStepForm({ node, ctx, options, onChange }: FormProps<'agent'>): ReactNode {
  const { t } = ctx
  const data = node.data
  return (
    <>
      <TemplateField label={t('guided.instruction')} placeholder={t('guided.instructionPlaceholder')} value={data.prompt} bindings={data.inputs} options={options} t={t} onChange={(prompt, inputs) => { onChange({ ...node, data: { ...data, prompt, ...(inputs === undefined ? {} : { inputs }) } }) }} />
      <Section title={t('inputs')} hint={t('guided.inputsHint')}>
        <BindingsEditor bindings={data.inputs} options={options} t={t} onChange={(inputs) => { onChange({ ...node, data: { ...data, inputs } }) }} />
      </Section>
    </>
  )
}

function GuidedConditionForm({ node, ctx, onChange }: FormProps<'condition'>): ReactNode {
  const { t } = ctx
  const branches = node.data.branches
  const setBranches = (next: ConditionBranch[]): void => { onChange({ ...node, data: { branches: next } }) }
  return (
    <>
      <div className="dsflow-hint">{t('guided.conditionHint')}</div>
      <label className="dsflow-field">
        <span className="dsflow-field__label">{t('guided.question')}</span>
        <input className="dsflow-input" placeholder={t('guided.questionPlaceholder')} value={node.description ?? ''} onChange={(event) => { onChange({ ...node, description: event.target.value }) }} />
      </label>
      <div className="dsflow-list">
        {branches.map((branch, index) => (
          <div key={branch.id} className="dsflow-bind__row">
            <span className="dsflow-card__index">{index === 0 ? t('condition.if') : t('condition.elseIf')}</span>
            <input className="dsflow-input" placeholder={t('guided.branchPlaceholder')} value={branch.label} onChange={(event) => { setBranches(branches.map((current, i) => i === index ? { ...current, label: event.target.value } : current)) }} />
            <RemoveButton t={t} onClick={() => { setBranches(branches.filter((_, i) => i !== index)) }} />
          </div>
        ))}
        <AddButton label={t('condition.addBranch')} onClick={() => { setBranches([...branches, { id: newId('branch'), label: '', logic: 'and', conditions: [] }]) }} />
      </div>
      <div className="dsflow-card dsflow-card--else">
        <span className="dsflow-card__index">{t('condition.else')}</span>
        <span className="dsflow-hint">{t('condition.elseHint')}</span>
      </div>
    </>
  )
}

function GuidedLoopForm({ node, ctx, options, onChange }: FormProps<'loop'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const set = (patch: Partial<NodeOf<'loop'>['data']>): void => { onChange({ ...node, data: { ...data, ...patch } }) }
  return (
    <>
      <Section title={t('loop.mode')}>
        <Segmented
          value={data.mode}
          options={[{ value: 'array', label: t('loop.mode.array') }, { value: 'count', label: t('loop.mode.count') }, { value: 'infinite', label: t('guided.untilMode') }]}
          onChange={(mode) => { set({ mode }) }}
        />
        {data.mode === 'array' && <ValuePicker value={data.array ?? { kind: 'literal', value: [] }} schema={{ type: 'array' }} options={options} t={t} onChange={(array) => { set({ array }) }} />}
        {data.mode === 'count' && <ValuePicker value={data.count ?? { kind: 'literal', value: 3 }} schema={{ type: 'integer' }} options={options} t={t} onChange={(count) => { set({ count }) }} />}
      </Section>
      <label className="dsflow-field">
        <span className="dsflow-field__label">{t('guided.until')}</span>
        <textarea className="dsflow-textarea dsflow-textarea--short" placeholder={t('guided.untilPlaceholder')} value={data.until ?? ''} onChange={(event) => { onChange({ ...node, data: withOptional(data, 'until', event.target.value === '' ? undefined : event.target.value) }) }} />
      </label>
      <label className="dsflow-field">
        <span className="dsflow-field__label">{t('loop.maxIterations')}</span>
        <NumberField value={data.maxIterations} min={1} onChange={(value) => { set({ maxIterations: value ?? 1 }) }} />
      </label>
      <div className="dsflow-hint">{t('guided.loopHint')}</div>
    </>
  )
}

function GuidedEndForm({ node, ctx, onChange }: FormProps<'end'>): ReactNode {
  const { t } = ctx
  const data = node.data
  const fields: VarField[] = data.inputs.map(binding => ({ name: binding.name, schema: binding.schema }))
  return (
    <>
      <label className="dsflow-field">
        <span className="dsflow-field__label">{t('guided.result')}</span>
        <textarea className="dsflow-textarea dsflow-textarea--short" placeholder={t('guided.resultPlaceholder')} value={data.template ?? ''} onChange={(event) => { onChange({ ...node, data: withOptional(data, 'template', event.target.value === '' ? undefined : event.target.value) }) }} />
      </label>
      <Section title={t('guided.resultFields')} hint={t('guided.resultFieldsHint')}>
        <FieldListEditor
          fields={fields}
          t={t}
          addLabel={t('addOutput')}
          namePrefix="result"
          onChange={(next) => { onChange({ ...node, data: { ...data, mode: 'variables', inputs: next.map(field => ({ name: field.name, schema: field.schema, value: { kind: 'literal', value: null }, required: false })) } }) }}
        />
      </Section>
    </>
  )
}

/** Node types whose failures the error policy form configures. */
const WITH_ERROR_POLICY: ReadonlySet<FlowNode['type']> = new Set(['llm', 'intent', 'agent', 'code', 'http', 'tool', 'subflow', 'json'])

/** The failure handling form: what happens when the node fails, retries, and timeout. */
export function ErrorPolicyForm({ node, t, onChange }: { node: FlowNode; t: Translate; onChange(next: FlowNode): void }): ReactNode {
  if (!WITH_ERROR_POLICY.has(node.type)) return null
  const policy = node.onError ?? { onError: 'fail' as const }
  const outputs = specOf(node).outputs(node, () => undefined).filter(field => field.name !== 'errorMessage')
  const set = (patch: Partial<ErrorPolicy>): void => {
    const merged = { ...policy, ...patch }
    const cleaned: ErrorPolicy = {
      onError: merged.onError,
      ...(merged.retries === undefined ? {} : { retries: merged.retries }),
      ...(merged.timeoutMs === undefined ? {} : { timeoutMs: merged.timeoutMs }),
      ...(merged.onError === 'default' && merged.defaultOutputs !== undefined ? { defaultOutputs: merged.defaultOutputs } : {}),
    }
    const { onError: _dropped, ...rest } = node
    const isDefault = cleaned.onError === 'fail' && cleaned.retries === undefined && cleaned.timeoutMs === undefined
    onChange((isDefault ? rest : { ...rest, onError: cleaned }) as FlowNode)
  }
  const defaults = policy.defaultOutputs ?? {}
  return (
    <details className="dsflow-advanced" open={node.onError !== undefined}>
      <summary>{t('error.title')}</summary>
      <Segmented
        value={policy.onError}
        options={[{ value: 'fail', label: t('error.fail') }, { value: 'default', label: t('error.default') }, { value: 'branch', label: t('error.branch') }]}
        onChange={(onError) => { set({ onError, ...(onError === 'default' ? { defaultOutputs: Object.fromEntries(outputs.map(field => [field.name, defaults[field.name] ?? defaultValue(field.schema)])) } : {}) }) }}
      />
      <div className="dsflow-hint">{t(`error.hint.${policy.onError}` as LocaleKey)}</div>
      {policy.onError === 'default' && outputs.map(field => (
        <label key={field.name} className="dsflow-field">
          <span className="dsflow-field__label">{field.name}</span>
          <LiteralEditor schema={field.schema} value={defaults[field.name] ?? defaultValue(field.schema)} t={t} onChange={(value: JsonValue) => { set({ defaultOutputs: { ...defaults, [field.name]: value } }) }} />
        </label>
      ))}
      <div className="dsflow-bind__row">
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('error.retries')}</span>
          <NumberField value={policy.retries} min={0} max={MAX_NODE_RETRIES} placeholder="0" onChange={(retries) => { set({ retries: retries === 0 ? undefined : retries }) }} />
        </label>
        <label className="dsflow-field">
          <span className="dsflow-field__label">{t('timeoutSeconds')}</span>
          <NumberField value={seconds(policy.timeoutMs)} min={1} placeholder={t('model.defaultValue')} onChange={(value) => { set({ timeoutMs: millis(value) }) }} />
        </label>
      </div>
    </details>
  )
}
