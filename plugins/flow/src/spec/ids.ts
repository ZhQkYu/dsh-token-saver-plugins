/**
 * Id and name generation helpers for flows, nodes, edges, and runs. Ids use
 * only the characters allowed by {@link ID_PATTERN}, so they are safe in file
 * paths and route params.
 *
 * @module @dsh-plugins/flow/spec/ids
 */

import { ID_PATTERN, NAME_PATTERN } from './types.ts'

/** Generate a random id in the {@link ID_PATTERN} charset. */
export function generateId(prefix = ''): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let body = ''
  for (let i = 0; i < 12; i++) body += chars[Math.floor(Math.random() * chars.length)]
  return `${prefix}${body}`
}

/** Whether a string matches {@link ID_PATTERN}. */
export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/** Whether a string matches {@link NAME_PATTERN}. */
export function isValidName(value: string): boolean {
  return NAME_PATTERN.test(value)
}

/** Coerce an arbitrary string into a valid name, used when deriving input names from field names. */
export function toValidName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, '_')
  const prefixed = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`
  return prefixed.slice(0, 64)
}

/** Generate a unique name by appending a counter until it passes {@link isValidName}. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  let candidate = toValidName(base) || 'value'
  let counter = 2
  while (taken.has(candidate)) {
    candidate = `${toValidName(base)}_${counter}`
    counter++
  }
  return candidate
}
