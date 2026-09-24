/**
 * The one validation schema for canvas graphs, runs, and route bodies. Graph
 * ids and node ids share the path-safe {@link ID_PATTERN}; structural limits
 * bound what the store writes and the model later reads.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas/schema
 */

import { z } from 'zod'
import { DECIDE_MODES, GRAPH_MODES, ID_PATTERN, NODE_KINDS, NODE_STATUSES, RULE_OPS, RUN_STATES } from '../protocol.ts'

/** Maximum nodes in one graph. */
export const MAX_NODES = 200
/** Maximum edges in one graph. */
export const MAX_EDGES = 500
/** Maximum characters of one node-status summary. */
export const MAX_SUMMARY_CHARS = 2000
/** Maximum characters of a strict run's stored output. */
export const MAX_RUN_OUTPUT_CHARS = 20000
/** Maximum named branches of one condition node. */
export const MAX_BRANCHES = 8
/** Upper bound the schema accepts for a loop's round limit; the plugin config may set a lower one. */
export const MAX_LOOP_ITERATIONS = 100

const id = z.string().regex(ID_PATTERN)

const ruleSchema = z.strictObject({
  op: z.enum(RULE_OPS),
  value: z.string().min(1).max(500),
}).refine((rule) => {
  if (rule.op !== 'regex') return true
  try {
    new RegExp(rule.value, 'i')
    return true
  } catch (invalid: unknown) {
    // An uncompilable pattern is reported as the refinement failure.
    return false
  }
}, { message: 'invalid regular expression' })

const nodeSchema = z.strictObject({
  id,
  kind: z.enum(NODE_KINDS),
  title: z.string().max(200),
  instruction: z.string().max(8000),
  config: z.strictObject({
    provider: z.string().max(64).optional(),
    tool: z.string().max(128).optional(),
    model: z.string().max(128).optional(),
    decide: z.enum(DECIDE_MODES).optional(),
    branches: z.array(z.strictObject({
      id,
      label: z.string().min(1).max(100),
      rule: ruleSchema.optional(),
    })).max(MAX_BRANCHES).optional(),
    graphId: id.optional(),
    maxIterations: z.number().int().min(1).max(MAX_LOOP_ITERATIONS).optional(),
    exitRule: ruleSchema.optional(),
  }),
  position: z.strictObject({ x: z.number(), y: z.number() }),
})

const edgeSchema = z.strictObject({
  id,
  source: id,
  target: id,
  label: z.string().max(200).optional(),
  sourceHandle: id.optional(),
})

/** A saved workflow graph. */
export const graphSchema = z.strictObject({
  version: z.literal(1),
  id,
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  mode: z.enum(GRAPH_MODES).optional(),
  nodes: z.array(nodeSchema).max(MAX_NODES),
  edges: z.array(edgeSchema).max(MAX_EDGES),
  updatedAt: z.number().int().nonnegative(),
})

/** A stored run of a graph. */
export const runSchema = z.strictObject({
  runId: id,
  graphId: id,
  sessionId: z.string().optional(),
  mode: z.enum(GRAPH_MODES).optional(),
  state: z.enum(RUN_STATES).optional(),
  output: z.string().max(MAX_RUN_OUTPUT_CHARS).optional(),
  error: z.string().max(MAX_SUMMARY_CHARS).optional(),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  nodes: z.record(z.string(), z.strictObject({
    status: z.enum(NODE_STATUSES),
    summary: z.string().max(MAX_SUMMARY_CHARS).optional(),
    branch: z.string().max(64).optional(),
    iteration: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative(),
  })),
})

/** Body of the delete route. */
export const deleteRequestSchema = z.strictObject({ id })

/** Body of the run route; `input` is the optional text the run starts from. */
export const runRequestSchema = z.strictObject({
  graphId: id,
  workspaceId: z.string().min(1).max(128),
  input: z.string().max(8000).optional(),
})

/** Body of the cancel route. */
export const cancelRequestSchema = z.strictObject({ runId: id })
