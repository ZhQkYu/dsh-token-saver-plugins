/**
 * The one validation schema for canvas graphs, runs, and route bodies. Graph
 * ids and node ids share the path-safe {@link ID_PATTERN}; structural limits
 * bound what the store writes and the model later reads.
 *
 * @module @dsh-plugins/token-saver/workflow-canvas/schema
 */

import { z } from 'zod'
import { ID_PATTERN, NODE_KINDS, NODE_STATUSES } from '../protocol.ts'

/** Maximum nodes in one graph. */
export const MAX_NODES = 200
/** Maximum edges in one graph. */
export const MAX_EDGES = 500
/** Maximum characters of one node-status summary. */
export const MAX_SUMMARY_CHARS = 2000

const id = z.string().regex(ID_PATTERN)

const nodeSchema = z.strictObject({
  id,
  kind: z.enum(NODE_KINDS),
  title: z.string().max(200),
  instruction: z.string().max(8000),
  config: z.strictObject({
    provider: z.string().max(64).optional(),
    tool: z.string().max(128).optional(),
    model: z.string().max(128).optional(),
  }),
  position: z.strictObject({ x: z.number(), y: z.number() }),
})

const edgeSchema = z.strictObject({
  id,
  source: id,
  target: id,
  label: z.string().max(200).optional(),
})

/** A saved workflow graph. */
export const graphSchema = z.strictObject({
  version: z.literal(1),
  id,
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  nodes: z.array(nodeSchema).max(MAX_NODES),
  edges: z.array(edgeSchema).max(MAX_EDGES),
  updatedAt: z.number().int().nonnegative(),
})

/** A stored run of a graph. */
export const runSchema = z.strictObject({
  runId: id,
  graphId: id,
  sessionId: z.string().optional(),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  nodes: z.record(z.string(), z.strictObject({
    status: z.enum(NODE_STATUSES),
    summary: z.string().max(MAX_SUMMARY_CHARS).optional(),
    updatedAt: z.number().int().nonnegative(),
  })),
})

/** Body of the delete route. */
export const deleteRequestSchema = z.strictObject({ id })

/** Body of the run route. */
export const runRequestSchema = z.strictObject({ graphId: id, workspaceId: z.string().min(1).max(128) })
