/**
 * VarSchema helpers: type compatibility, default values, JSON Schema
 * conversion, and human-readable descriptions. Pure and dependency-free so it
 * is shared by Host validation and the browser UI.
 *
 * @module @dsh-plugins/flow/spec/var-schema
 */

import type { JsonValue, VarField, VarSchema, VarType } from './types.ts'

/** The compatibility result of using a value of `from` schema where `to` is expected. */
export interface Compatibility {
  ok: boolean
  severity: 'error' | 'warning'
  reason: string
}

const VAR_TYPES: readonly VarType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'any']

/** Whether a `VarType` is one of the known types. */
export function isVarType(value: string): value is VarType {
  return (VAR_TYPES as readonly string[]).includes(value)
}

/**
 * Whether a value of `from` schema can be used where `to` is expected.
 * `any` is compatible with everything; `integer` narrows into `number`;
 * a `number` fed into `integer` is only a warning (runtime coerce may still
 * succeed for integral values); anything else must match exactly.
 */
export function compatible(from: VarSchema, to: VarSchema): Compatibility {
  if (to.type === 'any' || from.type === 'any') return { ok: true, severity: 'error', reason: 'any is compatible with every type' }
  if (from.type === to.type) {
    if (from.type === 'object') return compatibleObject(from, to)
    if (from.type === 'array') return compatibleArray(from, to)
    return { ok: true, severity: 'error', reason: `same type ${from.type}` }
  }
  if (from.type === 'integer' && to.type === 'number') return { ok: true, severity: 'error', reason: 'integer is a number' }
  if (from.type === 'number' && to.type === 'integer') return { ok: true, severity: 'warning', reason: 'number may not be an integer' }
  return { ok: false, severity: 'error', reason: `incompatible types ${from.type} -> ${to.type}` }
}

function compatibleObject(from: VarSchema, to: VarSchema): Compatibility {
  if (to.properties === undefined || from.properties === undefined) return { ok: true, severity: 'error', reason: 'object fields are loose' }
  for (const field of to.properties) {
    const src = from.properties.find(f => f.name === field.name)
    if (src === undefined) {
      if (field.required) return { ok: false, severity: 'error', reason: `missing required field ${field.name}` }
      continue
    }
    const nested = compatible(src.schema, field.schema)
    if (!nested.ok) return nested
  }
  return { ok: true, severity: 'error', reason: 'object fields compatible' }
}

function compatibleArray(from: VarSchema, to: VarSchema): Compatibility {
  if (to.items === undefined || from.items === undefined) return { ok: true, severity: 'error', reason: 'array elements are loose' }
  return compatible(from.items, to.items)
}

/** The default value for a schema, used to fill unset bindings and start fields. */
export function defaultValue(schema: VarSchema): JsonValue {
  switch (schema.type) {
    case 'string': return ''
    case 'number': return 0
    case 'integer': return 0
    case 'boolean': return false
    case 'object': {
      const out: Record<string, JsonValue> = {}
      for (const field of schema.properties ?? []) out[field.name] = defaultValue(field.schema)
      return out
    }
    case 'array': return []
    case 'any': return null
  }
}

/** A human-readable description of a schema, e.g. `string`, `object{a:number}`, `array<string>`. */
export function describeVarSchema(schema: VarSchema): string {
  switch (schema.type) {
    case 'object': {
      const fields = (schema.properties ?? []).map(f => `${f.name}${f.required ? '' : '?'}:${describeVarSchema(f.schema)}`).join(',')
      return `object{${fields}}`
    }
    case 'array': return `array<${schema.items === undefined ? 'any' : describeVarSchema(schema.items)}>`
    default: return schema.type
  }
}

/**
 * Convert a JSON Schema (as a tool parameter or output schema) into a
 * {@link VarSchema}. Unknown structures degrade to `any` rather than throwing,
 * so foreign schemas never break the editor.
 */
export function jsonSchemaToVarSchema(schema: unknown): VarSchema {
  if (schema === null || typeof schema !== 'object') return { type: 'any' }
  const record = schema as Record<string, unknown>
  const type = record['type']
  if (typeof type === 'string') {
    if (type === 'string') return { type: 'string', description: asString(record['description']) }
    if (type === 'number') return { type: 'number', description: asString(record['description']) }
    if (type === 'integer') return { type: 'integer', description: asString(record['description']) }
    if (type === 'boolean') return { type: 'boolean', description: asString(record['description']) }
    if (type === 'object') return objectFromJsonSchema(record)
    if (type === 'array') {
      const items = record['items']
      return { type: 'array', items: items === undefined ? undefined : jsonSchemaToVarSchema(items) }
    }
    if (type === 'null') return { type: 'any' }
  }
  if (Array.isArray(type)) return { type: 'any' }
  // No type, but properties present: treat as object.
  if (record['properties'] !== undefined) return objectFromJsonSchema(record)
  return { type: 'any' }
}

function objectFromJsonSchema(record: Record<string, unknown>): VarSchema {
  const rawProps = record['properties']
  const fields: VarField[] = []
  if (rawProps !== null && typeof rawProps === 'object' && !Array.isArray(rawProps)) {
    const required = Array.isArray(record['required']) ? record['required'] : []
    for (const [name, propSchema] of Object.entries(rawProps as Record<string, unknown>)) {
      const fieldSchema = jsonSchemaToVarSchema(propSchema)
      fields.push({
        name,
        schema: fieldSchema,
        required: required.includes(name),
        description: fieldSchema.description,
      })
    }
  }
  return { type: 'object', properties: fields, description: asString(record['description']) }
}

/**
 * Infer a schema from a sample value (e.g. a node's last run output), so
 * downstream pickers can offer its fields. Arrays take their first element's
 * schema; `null` is `any`.
 * @param value - the sample value.
 * @param depth - the remaining nesting depth to describe.
 * @returns the inferred schema.
 */
export function schemaFromValue(value: JsonValue | undefined, depth = 6): VarSchema {
  if (value === null || value === undefined) return { type: 'any' }
  if (typeof value === 'string') return { type: 'string' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' }
  if (Array.isArray(value)) {
    if (depth <= 0 || value.length === 0) return { type: 'array' }
    return { type: 'array', items: schemaFromValue(value[0], depth - 1) }
  }
  if (depth <= 0) return { type: 'object' }
  return { type: 'object', properties: fieldsFromValue(value, depth) }
}

/**
 * The fields of an object sample value, see {@link schemaFromValue}.
 * @param value - the sample object.
 * @param depth - the remaining nesting depth.
 * @returns one field per key.
 */
export function fieldsFromValue(value: JsonValue | undefined, depth = 6): VarField[] {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value).map(([name, child]) => ({ name, schema: schemaFromValue(child, depth - 1) }))
}

/** Build a DSH `defineTool` parameter schema spec from a {@link VarSchema}. */
export function toParameterSchemaSpec(schema: VarSchema, required: boolean): Record<string, unknown> {
  const req = required ? { required: true } : {}
  switch (schema.type) {
    case 'string': return { type: 'string', ...req }
    case 'number': return { type: 'number', ...req }
    case 'integer': return { type: 'integer', ...req }
    case 'boolean': return { type: 'boolean', ...req }
    case 'array': return { type: 'array', items: schema.items === undefined ? { type: 'json' } : toParameterSchemaSpec(schema.items, false), ...req }
    case 'object': {
      const properties: Record<string, unknown> = {}
      for (const field of schema.properties ?? []) properties[field.name] = toParameterSchemaSpec(field.schema, field.required === true)
      return { type: 'object', properties, additionalProperties: false, ...req }
    }
    case 'any': return { type: 'json', ...req }
  }
}

/** Build a DSH tool output value schema from a {@link VarSchema}. */
export function toValueSchemaSpec(schema: VarSchema): Record<string, unknown> {
  switch (schema.type) {
    case 'string': return { type: 'string' }
    case 'number': return { type: 'number' }
    case 'integer': return { type: 'integer' }
    case 'boolean': return { type: 'boolean' }
    case 'array': return { type: 'array', items: schema.items === undefined ? { type: 'json' } : toValueSchemaSpec(schema.items) }
    case 'object': {
      const properties: Record<string, unknown> = {}
      for (const field of schema.properties ?? []) properties[field.name] = toValueSchemaSpec(field.schema)
      return { type: 'object', properties, additionalProperties: true }
    }
    case 'any': return { type: 'json' }
  }
}

/** Build a JSON Schema object (for subagent `outputSchema`) from VarFields. */
export function toObjectJsonSchema(fields: VarField[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const field of fields) {
    properties[field.name] = toJsonSchemaValue(field.schema)
    if (field.required) required.push(field.name)
  }
  return { type: 'object', properties, required }
}

function toJsonSchemaValue(schema: VarSchema): Record<string, unknown> {
  switch (schema.type) {
    case 'string': return { type: 'string' }
    case 'number': return { type: 'number' }
    case 'integer': return { type: 'integer' }
    case 'boolean': return { type: 'boolean' }
    case 'array': return { type: 'array', items: schema.items === undefined ? {} : toJsonSchemaValue(schema.items) }
    case 'object': {
      const properties: Record<string, unknown> = {}
      for (const field of schema.properties ?? []) properties[field.name] = toJsonSchemaValue(field.schema)
      return { type: 'object', properties }
    }
    case 'any': return {}
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
