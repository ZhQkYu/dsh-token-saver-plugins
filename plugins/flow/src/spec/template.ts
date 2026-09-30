/**
 * Template parsing and rendering. A template is a string with `{{ name }}` and
 * `{{ name.field.sub }}` placeholders; `\{{` escapes to a literal `{{`. There
 * are no expressions, filters, or function calls and no `eval`/`new Function`.
 * The first path segment is a node input name, the rest are object fields or
 * array indices (`{{ items[0].name }}` or `{{ items.0.name }}`).
 *
 * @module @dsh-plugins/flow/spec/template
 */

import type { JsonValue } from './types.ts'

/** One parsed part of a template. */
export type TemplatePart =
  | { kind: 'text'; text: string }
  | { kind: 'var'; path: string[] }

/** Parse a template into text and variable parts, for validation and highlighting. */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  let index = 0
  let text = ''
  while (index < template.length) {
    const escaped = template.startsWith('\\{{', index)
    if (escaped) {
      text += '{{'
      index += 3
      continue
    }
    const start = template.indexOf('{{', index)
    if (start === -1) {
      text += template.slice(index)
      break
    }
    if (start > index && template[start - 1] === '\\') {
      // `\{{` mid-text: emit the preceding text and resume at the escape.
      text += template.slice(index, start - 1)
      index = start - 1
      continue
    }
    if (start > index) text += template.slice(index, start)
    const end = template.indexOf('}}', start + 2)
    if (end === -1) {
      // Unclosed placeholder: treat the rest as literal text.
      text += template.slice(start)
      break
    }
    const inner = template.slice(start + 2, end).trim()
    if (inner === '') {
      text += '{{}}'
      index = end + 2
      continue
    }
    const path = parsePath(inner)
    if (path.length === 0) {
      text += '{{}}'
      index = end + 2
      continue
    }
    if (text !== '') {
      parts.push({ kind: 'text', text })
      text = ''
    }
    parts.push({ kind: 'var', path })
    index = end + 2
  }
  if (text !== '') parts.push({ kind: 'text', text })
  return parts
}

/**
 * Split a member expression such as `a.b[0].c` or `a.items.0` into path
 * segments (`['a', 'b', '0', 'c']`). Numeric segments index arrays.
 * @param text - the member expression.
 * @returns the non-empty segments.
 */
export function parsePath(text: string): string[] {
  return text.replace(/\[\s*(\d+)\s*\]/g, '.$1').split('.').map(part => part.trim()).filter(part => part !== '')
}

/**
 * Format path segments as a member expression, e.g. `a.b[0].c`.
 * @param path - the segments.
 * @returns the expression.
 */
export function formatPath(path: readonly string[]): string {
  let out = ''
  for (const segment of path) out += /^\d+$/.test(segment) && out !== '' ? `[${segment}]` : out === '' ? segment : `.${segment}`
  return out
}

/**
 * Step one path segment into a value: an object field, or an array index for
 * a numeric segment. `undefined` when the step does not exist.
 * @param value - the current value.
 * @param segment - the field name or index.
 * @returns the child value.
 */
export function stepPath(value: JsonValue | undefined, segment: string): JsonValue | undefined {
  if (value === null || value === undefined || typeof value !== 'object') return undefined
  if (Array.isArray(value)) return /^\d+$/.test(segment) ? value[Number(segment)] : undefined
  return (value as Record<string, JsonValue>)[segment]
}

/** The result of rendering a template. */
export interface RenderedTemplate {
  text: string
  warnings: string[]
}

/** Collect the variable names referenced by a template. */
export function templateVariables(template: string): Set<string> {
  const out = new Set<string>()
  for (const part of parseTemplate(template)) if (part.kind === 'var') out.add(part.path[0] ?? '')
  return out
}

/**
 * Render a template against a set of node input values. Missing or null values
 * render as empty string and produce a warning; objects and arrays are JSON
 * stringified; strings, numbers, and booleans render via `String()`.
 */
export function renderTemplate(template: string, values: Record<string, JsonValue>): RenderedTemplate {
  const warnings: string[] = []
  let out = ''
  for (const part of parseTemplate(template)) {
    if (part.kind === 'text') {
      out += part.text
      continue
    }
    const [root, ...rest] = part.path
    const rootValue = values[root ?? '']
    if (rootValue === undefined || rootValue === null) {
      warnings.push(`template variable "{{${formatPath(part.path)}}}" is missing`)
    }
    const value = resolvePath(rootValue ?? null, rest, warnings, part.path)
    out += renderValue(value)
  }
  return { text: out, warnings }
}

function resolvePath(value: JsonValue, rest: string[], warnings: string[], path: string[]): JsonValue {
  let current: JsonValue = value
  for (const segment of rest) {
    if (current === null || current === undefined || typeof current !== 'object') {
      warnings.push(`template path "${formatPath(path)}" stopped at "${segment}"`)
      return null
    }
    const next = stepPath(current, segment)
    if (next === undefined) {
      warnings.push(`template path "${formatPath(path)}" missing field "${segment}"`)
      return null
    }
    current = next
  }
  return current
}

function renderValue(value: JsonValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
