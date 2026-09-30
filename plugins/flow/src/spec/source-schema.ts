/**
 * Static schema of a value source within a flow document, so containers can
 * type their `item` and collected outputs from what they iterate or collect.
 *
 * @module @dsh-plugins/flow/spec/source-schema
 */

import type { FlowDocument, FlowLookup, ValueSource, VarSchema } from './types.ts'
import { NODE_SPECS, specOf } from './nodes/index.ts'

const NO_LOOKUP: FlowLookup = () => undefined

/**
 * The schema at a path inside a schema: object fields, or array items for
 * numeric segments. Unknown or loose paths are `any`.
 * @param schema - the root schema.
 * @param path - the field names and indices.
 * @returns the nested schema.
 */
export function schemaAtPath(schema: VarSchema, path: readonly string[]): VarSchema {
  let current = schema
  for (const segment of path) {
    if (current.type === 'array' && /^\d+$/.test(segment)) {
      current = current.items ?? { type: 'any' }
      continue
    }
    if (current.type !== 'object' || current.properties === undefined) return { type: 'any' }
    const next = current.properties.find(field => field.name === segment)
    if (next === undefined) return { type: 'any' }
    current = next.schema
  }
  return current
}

/**
 * The static schema of a value source.
 * @param doc - the flow.
 * @param source - the literal or reference.
 * @param lookup - subflow lookup for subflow outputs.
 * @param depth - recursion guard for container chains.
 * @returns the schema, `any` when unknown.
 */
export function sourceSchema(doc: FlowDocument, source: ValueSource, lookup: FlowLookup = NO_LOOKUP, depth = 0): VarSchema {
  if (source.kind === 'literal' || depth > 16) return { type: 'any' }
  const node = doc.nodes.find(candidate => candidate.id === source.node)
  if (node === undefined) return { type: 'any' }
  const [head, ...rest] = source.path
  if (source.source === 'output') {
    const field = specOf(node).outputs(node, lookup).find(candidate => candidate.name === head)
    return field === undefined ? { type: 'any' } : schemaAtPath(field.schema, rest)
  }
  if (head === 'item' && (node.type === 'loop' || node.type === 'batch')) {
    const array = node.data.array
    const items = array === undefined ? undefined : sourceSchema(doc, array, lookup, depth + 1)
    return schemaAtPath(items?.type === 'array' ? items.items ?? { type: 'any' } : { type: 'any' }, rest)
  }
  const inner = node.type === 'loop' ? NODE_SPECS.loop.innerVars?.(node, doc) : node.type === 'batch' ? NODE_SPECS.batch.innerVars?.(node, doc) : undefined
  const field = inner?.find(candidate => candidate.name === head)
  return field === undefined ? { type: 'any' } : schemaAtPath(field.schema, rest)
}
