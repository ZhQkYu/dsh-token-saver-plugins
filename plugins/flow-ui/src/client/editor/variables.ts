/**
 * Pure helpers behind the point-and-click forms: the upstream variables a
 * node can reference, bindings created from a picked variable, template
 * insertion, and tool/subflow parameter syncing.
 *
 * @module @dsh-plugins/flow-ui/client/editor/variables
 */

import type { FlowDocument, FlowLookup, InputBinding, JsonValue, ValueSource, VarField, VarSchema } from '@dsh-plugins/flow/spec'
import { availableVariables, defaultValue, jsonSchemaToVarSchema, specOf, uniqueName } from '@dsh-plugins/flow/spec'

/** A reference value source. */
export type RefSource = Extract<ValueSource, { kind: 'ref' }>

/** One selectable variable: an output (or nested field) of an upstream node, or a container inner variable. */
export interface VariableOption {
  key: string
  /** The node or container title, used as the option group. */
  group: string
  /** The field path within the group, e.g. `items` or `user.name`. */
  label: string
  source: RefSource
  schema: VarSchema
}

const MAX_FIELD_DEPTH = 2

function pushField(options: VariableOption[], group: string, label: string, source: RefSource, schema: VarSchema, depth: number): void {
  options.push({ key: sourceKey(source), group, label, source, schema })
  if (schema.type !== 'object' || depth >= MAX_FIELD_DEPTH) return
  for (const property of schema.properties ?? []) {
    pushField(options, group, `${label}.${property.name}`, { ...source, path: [...source.path, property.name] }, property.schema, depth + 1)
  }
}

/**
 * The variables a node can reference: outputs of upstream nodes in its scope
 * and enclosing scopes, plus the inner variables of its container.
 * @param doc - the flow.
 * @param nodeId - the node whose inputs are being edited.
 * @param lookup - subflow lookup for subflow outputs.
 * @returns the options in scope order.
 */
export function variableOptions(doc: FlowDocument, nodeId: string, lookup: FlowLookup): VariableOption[] {
  const options: VariableOption[] = []
  for (const group of availableVariables(doc, nodeId, lookup)) {
    for (const entry of group.nodes) {
      for (const field of entry.outputs) {
        pushField(options, entry.nodeTitle, field.name, { kind: 'ref', node: entry.nodeId, source: 'output', path: [field.name] }, field.schema, 0)
      }
    }
    if (group.inner !== undefined) {
      const { containerId, fields } = group.inner
      const title = doc.nodes.find(node => node.id === containerId)?.title ?? containerId
      for (const field of fields) {
        pushField(options, title, field.name, { kind: 'ref', node: containerId, source: 'inner', path: [field.name] }, field.schema, 0)
      }
    }
  }
  return options
}

/**
 * The outputs of the nodes inside a loop/batch body, for the container's collected outputs.
 * @param doc - the flow.
 * @param containerId - the loop or batch node.
 * @param lookup - subflow lookup for subflow outputs.
 * @returns the options, grouped by body node.
 */
export function bodyOutputOptions(doc: FlowDocument, containerId: string, lookup: FlowLookup): VariableOption[] {
  const options: VariableOption[] = []
  for (const node of doc.nodes) {
    if (node.parentId !== containerId || !specOf(node).executable) continue
    for (const field of specOf(node).outputs(node, lookup)) {
      pushField(options, node.title, field.name, { kind: 'ref', node: node.id, source: 'output', path: [field.name] }, field.schema, 0)
    }
  }
  return options
}

/**
 * A stable key for a value source; `''` for literals.
 * @param source - the value source.
 * @returns the key.
 */
export function sourceKey(source: ValueSource): string {
  return source.kind === 'literal' ? '' : `${source.source}:${source.node}:${source.path.join('.')}`
}

/**
 * The binding that references a picked variable: an existing binding with the
 * same source, or a new one named after the field.
 * @param bindings - the node's current bindings.
 * @param option - the picked variable.
 * @returns the binding and whether it is new.
 */
export function bindingForOption(bindings: readonly InputBinding[], option: VariableOption): { binding: InputBinding; added: boolean } {
  const existing = bindings.find(binding => sourceKey(binding.value) === option.key)
  if (existing !== undefined) return { binding: existing, added: false }
  const name = uniqueName(option.source.path[option.source.path.length - 1] ?? 'value', new Set(bindings.map(binding => binding.name)))
  return { binding: { name, schema: option.schema, value: option.source }, added: true }
}

/**
 * Insert a snippet into text, replacing the selection.
 * @param text - the current text.
 * @param start - selection start.
 * @param end - selection end.
 * @param snippet - the text to insert.
 * @returns the new text and the cursor position after the snippet.
 */
export function insertText(text: string, start: number, end: number, snippet: string): { text: string; cursor: number } {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  return { text: text.slice(0, from) + snippet + text.slice(to), cursor: from + snippet.length }
}

/**
 * The parameters of a tool from its JSON Schema.
 * @param parameters - the tool's JSON Schema parameters.
 * @returns one field per property; `required` is always set.
 */
export function toolParams(parameters: unknown): VarField[] {
  const schema = jsonSchemaToVarSchema(parameters)
  if (schema.type !== 'object') return []
  return (schema.properties ?? []).map(field => ({ ...field, required: field.required === true }))
}

/**
 * Tool arguments for a parameter list: every required parameter, plus the
 * optional ones already set; existing values are kept.
 * @param params - the tool parameters.
 * @param existing - the current arguments.
 * @returns the arguments.
 */
export function syncToolArgs(params: readonly VarField[], existing: readonly InputBinding[]): InputBinding[] {
  const out: InputBinding[] = []
  for (const param of params) {
    const current = existing.find(binding => binding.name === param.name)
    if (current === undefined && param.required !== true) continue
    out.push({
      name: param.name,
      schema: param.schema,
      value: current?.value ?? literalFor(param.schema),
      required: param.required === true,
    })
  }
  return out
}

/**
 * Subflow input bindings for the subflow's start fields; existing values are kept.
 * @param fields - the subflow's start fields.
 * @param existing - the current bindings.
 * @returns one binding per field.
 */
export function syncSubflowInputs(fields: readonly VarField[], existing: readonly InputBinding[]): InputBinding[] {
  return fields.map((field) => {
    const current = existing.find(binding => binding.name === field.name)
    return {
      name: field.name,
      schema: field.schema,
      value: current?.value ?? literalFor(field.schema),
      required: field.required === true,
    }
  })
}

/**
 * The empty literal for a schema.
 * @param schema - the value schema.
 * @returns a literal source.
 */
export function literalFor(schema: VarSchema): ValueSource {
  const value: JsonValue = schema.type === 'number' || schema.type === 'integer' ? null : defaultValue(schema)
  return { kind: 'literal', value }
}
