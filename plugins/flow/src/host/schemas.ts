/**
 * The one zod validation schema for flow documents and route bodies. Flow ids
 * and node ids share the path-safe {@link ID_PATTERN}; structural limits bound
 * what the store writes and the engine later reads.
 *
 * @module @dsh-plugins/flow/host/schemas
 */

import { z } from 'zod'
import type { VarField, VarSchema } from '../spec/types.ts'
import { CONDITION_OPS, FLOW_TOOL_NAME_PATTERN, ID_PATTERN, NAME_PATTERN } from '../spec/types.ts'

/** Maximum nodes in one flow. */
export const MAX_NODES = 500
/** Maximum edges in one flow. */
export const MAX_EDGES = 1000
/** Maximum characters of a node title. */
export const MAX_TITLE_CHARS = 200
/** Maximum characters of a flow description. */
export const MAX_DESCRIPTION_CHARS = 2000
/** Upper bound the schema accepts for a loop's iteration limit; config may set a lower one. */
export const MAX_SCHEMA_LOOP_ITERATIONS = 1000

const id = z.string().regex(ID_PATTERN)
const name = z.string().regex(NAME_PATTERN)

const varSchema: z.ZodType<VarSchema> = z.lazy(() => z.strictObject({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array', 'any']),
  items: z.lazy(() => varSchema).optional(),
  properties: z.array(z.lazy(() => varField)).optional(),
  description: z.string().max(500).optional(),
}))

const varField: z.ZodType<VarField> = z.lazy(() => z.strictObject({
  name,
  schema: varSchema,
  required: z.boolean().optional(),
  description: z.string().max(500).optional(),
}))

const valueSource = z.union([
  z.strictObject({ kind: z.literal('literal'), value: z.json() }),
  z.strictObject({
    kind: z.literal('ref'),
    node: id,
    source: z.enum(['output', 'inner']),
    path: z.tuple([name]).rest(name),
  }),
])

const inputBinding = z.strictObject({
  name,
  schema: varSchema,
  value: valueSource,
  required: z.boolean().optional(),
})

const errorPolicy = z.strictObject({
  timeoutMs: z.number().int().nonnegative().optional(),
  retries: z.number().int().min(0).max(5).optional(),
  onError: z.enum(['fail', 'default', 'branch']),
  defaultOutputs: z.record(z.string(), z.json()).optional(),
})

const modelSelection = z.strictObject({
  provider: z.string().max(128),
  model: z.string().max(128),
  reasoningEffort: z.string().max(128).optional(),
})

const position = z.strictObject({ x: z.number(), y: z.number() })
const size = z.strictObject({ width: z.number().positive(), height: z.number().positive() })

const baseNode = {
  id,
  title: z.string().max(MAX_TITLE_CHARS),
  description: z.string().max(2000).optional(),
  position,
  parentId: id.optional(),
  size: size.optional(),
  onError: errorPolicy.optional(),
}

const nodeSchemas = {
  start: z.strictObject({ ...baseNode, type: z.literal('start'), data: z.strictObject({ fields: z.array(z.intersection(varField, z.strictObject({ default: z.json().optional() }))).max(200) }) }),
  end: z.strictObject({ ...baseNode, type: z.literal('end'), data: z.strictObject({ mode: z.enum(['variables', 'text']), inputs: z.array(inputBinding).max(200), template: z.string().max(20000).optional() }) }),
  llm: z.strictObject({ ...baseNode, type: z.literal('llm'), data: z.strictObject({ model: modelSelection.optional(), inputs: z.array(inputBinding).max(200), system: z.string().max(20000), prompt: z.string().max(50000), temperature: z.number().min(0).max(2).optional(), maxTokens: z.number().int().positive().optional(), output: z.union([z.strictObject({ format: z.literal('text') }), z.strictObject({ format: z.literal('json'), fields: z.array(varField).max(200) })]) }) }),
  intent: z.strictObject({ ...baseNode, type: z.literal('intent'), data: z.strictObject({ model: modelSelection.optional(), inputs: z.array(inputBinding).max(200), query: z.string().max(50000), intents: z.array(z.strictObject({ id, label: z.string().max(100), description: z.string().max(500).optional() })).max(20), instruction: z.string().max(5000).optional() }) }),
  agent: z.strictObject({ ...baseNode, type: z.literal('agent'), data: z.strictObject({ inputs: z.array(inputBinding).max(200), prompt: z.string().max(50000), persona: z.string().max(5000).optional(), model: modelSelection.optional(), tools: z.strictObject({ allow: z.array(z.string().max(128)).max(200).optional() }).optional(), outputs: z.array(varField).max(200).optional(), provider: z.string().max(128).optional() }) }),
  condition: z.strictObject({ ...baseNode, type: z.literal('condition'), data: z.strictObject({ branches: z.array(z.strictObject({ id, label: z.string().max(100), logic: z.enum(['and', 'or']), conditions: z.array(z.strictObject({ left: valueSource, op: z.enum(CONDITION_OPS), right: valueSource.optional() })).max(50) })).max(8) }) }),
  code: z.strictObject({ ...baseNode, type: z.literal('code'), data: z.strictObject({ language: z.literal('typescript'), inputs: z.array(inputBinding).max(200), code: z.string().max(100000), outputs: z.array(varField).max(200), timeoutMs: z.number().int().positive().optional() }) }),
  http: z.strictObject({ ...baseNode, type: z.literal('http'), data: z.strictObject({ inputs: z.array(inputBinding).max(200), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']), url: z.string().max(5000), headers: z.array(z.strictObject({ name: z.string().max(200), value: z.string().max(5000) })).max(100), query: z.array(z.strictObject({ name: z.string().max(200), value: z.string().max(5000) })).max(100), body: z.union([z.strictObject({ kind: z.literal('none') }), z.strictObject({ kind: z.enum(['json', 'text']), template: z.string().max(50000) }), z.strictObject({ kind: z.literal('form'), fields: z.array(z.strictObject({ name: z.string().max(200), value: z.string().max(5000) })).max(100) })]), timeoutMs: z.number().int().positive().optional() }) }),
  tool: z.strictObject({ ...baseNode, type: z.literal('tool'), data: z.strictObject({ tool: z.string().max(128), args: z.array(inputBinding).max(200) }) }),
  text: z.strictObject({ ...baseNode, type: z.literal('text'), data: z.union([z.strictObject({ op: z.literal('concat'), inputs: z.array(inputBinding).max(200), template: z.string().max(50000) }), z.strictObject({ op: z.literal('split'), input: valueSource, delimiters: z.array(z.string().max(500)).max(20) })]) }),
  json: z.strictObject({ ...baseNode, type: z.literal('json'), data: z.union([z.strictObject({ op: z.literal('parse'), input: valueSource, outputs: z.array(varField).max(200).optional() }), z.strictObject({ op: z.literal('stringify'), input: valueSource, pretty: z.boolean().optional() })]) }),
  aggregate: z.strictObject({ ...baseNode, type: z.literal('aggregate'), data: z.strictObject({ groups: z.array(z.strictObject({ name, schema: varSchema, candidates: z.array(valueSource).max(200) })).max(200) }) }),
  loop: z.strictObject({ ...baseNode, type: z.literal('loop'), data: z.strictObject({ mode: z.enum(['array', 'count', 'infinite']), array: valueSource.optional(), count: valueSource.optional(), maxIterations: z.number().int().min(1).max(MAX_SCHEMA_LOOP_ITERATIONS), variables: z.array(z.strictObject({ name, schema: varSchema, initial: valueSource })).max(200), outputs: z.array(z.strictObject({ name, value: valueSource })).max(200) }) }),
  batch: z.strictObject({ ...baseNode, type: z.literal('batch'), data: z.strictObject({ array: valueSource, concurrency: z.number().int().min(1).max(100), maxItems: z.number().int().min(1).max(1000), outputs: z.array(z.strictObject({ name, value: valueSource })).max(200) }) }),
  break: z.strictObject({ ...baseNode, type: z.literal('break'), data: z.strictObject({}) }),
  continue: z.strictObject({ ...baseNode, type: z.literal('continue'), data: z.strictObject({}) }),
  assign: z.strictObject({ ...baseNode, type: z.literal('assign'), data: z.strictObject({ assignments: z.array(z.strictObject({ variable: name, value: valueSource })).max(200) }) }),
  subflow: z.strictObject({ ...baseNode, type: z.literal('subflow'), data: z.strictObject({ flowId: id, version: z.enum(['published', 'draft']), inputs: z.array(inputBinding).max(200) }) }),
  question: z.strictObject({ ...baseNode, type: z.literal('question'), data: z.strictObject({ inputs: z.array(inputBinding).max(200), question: z.string().max(50000), answer: z.union([z.strictObject({ kind: z.literal('text') }), z.strictObject({ kind: z.literal('options'), options: z.array(z.strictObject({ id, label: z.string().max(100) })).max(20), allowOther: z.boolean() })]), timeoutMs: z.number().int().positive().optional() }) }),
  message: z.strictObject({ ...baseNode, type: z.literal('message'), data: z.strictObject({ inputs: z.array(inputBinding).max(200), template: z.string().max(50000) }) }),
  comment: z.strictObject({ ...baseNode, type: z.literal('comment'), data: z.strictObject({ text: z.string().max(20000) }) }),
} as const

/** A node, discriminated on `type`. */
export const flowNodeSchema = z.discriminatedUnion('type', [
  nodeSchemas.start, nodeSchemas.end, nodeSchemas.llm, nodeSchemas.intent, nodeSchemas.agent,
  nodeSchemas.condition, nodeSchemas.code, nodeSchemas.http, nodeSchemas.tool, nodeSchemas.text,
  nodeSchemas.json, nodeSchemas.aggregate, nodeSchemas.loop, nodeSchemas.batch, nodeSchemas.break,
  nodeSchemas.continue, nodeSchemas.assign, nodeSchemas.subflow, nodeSchemas.question,
  nodeSchemas.message, nodeSchemas.comment,
])

const flowEdgeSchema = z.strictObject({
  id,
  source: id,
  sourceHandle: z.string().max(128),
  target: id,
})

/** A saved flow document. */
export const flowDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  name: z.string().min(1).max(200),
  description: z.string().max(MAX_DESCRIPTION_CHARS),
  nodes: z.array(flowNodeSchema).max(MAX_NODES),
  edges: z.array(flowEdgeSchema).max(MAX_EDGES),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

/** A flow meta file. */
export const flowMetaSchema = z.strictObject({
  publishedVersion: z.number().int().positive().optional(),
  tool: z.strictObject({ enabled: z.boolean(), name: z.string().max(128), description: z.string().max(2000) }).optional(),
  createdAt: z.number().int().nonnegative(),
})

/** A published version meta file. */
export const versionMetaSchema = z.strictObject({
  version: z.number().int().positive(),
  note: z.string().max(2000),
  publishedAt: z.number().int().nonnegative(),
})

/** A stored run summary. */
export const runSummarySchema = z.strictObject({
  runId: id,
  flowId: id,
  flowName: z.string().max(200),
  version: z.union([z.number().int().positive(), z.literal('draft')]),
  trigger: z.union([
    z.strictObject({ kind: z.literal('canvas') }),
    z.strictObject({ kind: z.literal('tool'), sessionId: z.string(), callId: z.string() }),
    z.strictObject({ kind: z.literal('debug'), nodeId: id }),
  ]),
  status: z.enum(['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  inputs: z.json(),
  outputs: z.json().optional(),
  error: z.strictObject({ code: z.string(), message: z.string(), nodeId: z.string().optional() }).optional(),
  sessionId: z.string().optional(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  usage: z.strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative().optional(), reasoningTokens: z.number().int().nonnegative().optional() }),
  nodeExecutions: z.number().int().nonnegative(),
  workspacePath: z.string().max(5000).optional(),
  eventsTruncated: z.boolean().optional(),
})

/** Route body schemas. */
export const createFlowSchema = z.strictObject({ name: z.string().min(1).max(200), description: z.string().max(MAX_DESCRIPTION_CHARS).optional() })
export const saveFlowSchema = z.strictObject({ flow: flowDocumentSchema, baseRevision: z.number().int().nonnegative() })
export const idRequestSchema = z.strictObject({ id })
export const duplicateFlowSchema = z.strictObject({ id })
export const publishFlowSchema = z.strictObject({ id, baseRevision: z.number().int().nonnegative(), note: z.string().max(2000).optional(), tool: z.strictObject({ enabled: z.boolean(), name: z.string().regex(FLOW_TOOL_NAME_PATTERN), description: z.string().max(2000).optional() }).optional() })
export const runStartSchema = z.strictObject({ flowId: id, version: z.union([z.number().int().positive(), z.literal('draft')]), inputs: z.json(), workspaceId: z.string().min(1) })
export const runCancelSchema = z.strictObject({ runId: id })
export const runAnswerSchema = z.strictObject({ runId: id, execKey: z.string().max(1000), answer: z.strictObject({ text: z.string().max(20000).optional(), optionId: z.string().max(128).optional() }) })
export const nodeDebugSchema = z.strictObject({ flow: flowDocumentSchema, nodeId: id, inputs: z.json(), workspaceId: z.string().min(1) })

/** A validator for a {@link FlowDocument}, used by the store. */
export interface FlowDocumentValidator {
  parse(value: unknown): import('../spec/types.ts').FlowDocument
}
