/**
 * Frame: one execution of a scope (root once, loop per round, batch per item).
 * Frames form a chain, so references can walk outward to outer scopes.
 *
 * @module @dsh-plugins/flow/host/engine/frames
 */

import type { FrameStep, JsonValue, ValueSource } from '../../spec/types.ts'
import { stepPath } from '../../spec/template.ts'
import type { ExecutionPlan } from './compile.ts'

/** The lifecycle state of a node within a frame. */
export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'

/** One frame execution. */
export interface Frame {
  scope: string
  parent?: Frame
  path: FrameStep[]
  /** The plan this frame runs under, so containers resolve their own scope. */
  plan: ExecutionPlan
  /** The abort signal for this frame, inheriting the parent's and aborting siblings on failure. */
  signal: AbortSignal
  /** node id -> output values. */
  outputs: Map<string, Record<string, JsonValue>>
  /** node id -> status. */
  status: Map<string, NodeStatus>
  /** node id -> the ports fired on success (branch ids, 'next', 'else', 'error'). */
  firedPorts: Map<string, string[]>
  /** container inner variables: item/index/loop vars. */
  inner?: Record<string, JsonValue>
  /** loop control signal set by a break/continue node inside a container body. */
  control?: 'break' | 'continue'
  /** The first fatal error that failed this frame (onError=fail), propagated upward. */
  error?: { code: string; message: string; nodeId?: string }
  /** The frame's own abort controller, used to cancel siblings on failure. */
  controller: AbortController
}

/** Resolve a reference against a frame chain. */
export function resolveRef(frame: Frame, ref: ValueSource): JsonValue {
  if (ref.kind === 'literal') return ref.value
  if (ref.source === 'inner') {
    const target = findFrameByScope(frame, ref.node)
    if (target === undefined) return null
    const inner = target.inner ?? {}
    return traversePath(inner, ref.path)
  }
  // output ref
  const found = findNodeInChain(frame, ref.node)
  if (found === undefined) return null
  if (found.frame.status.get(ref.node) !== 'succeeded') return null
  const outputs = found.frame.outputs.get(ref.node)
  if (outputs === undefined) return null
  return traversePath(outputs, ref.path)
}

function findFrameByScope(frame: Frame, scope: string): Frame | undefined {
  let current: Frame | undefined = frame
  while (current !== undefined) {
    if (current.scope === scope) return current
    current = current.parent
  }
  return undefined
}

function findNodeInChain(frame: Frame, nodeId: string): { frame: Frame } | undefined {
  let current: Frame | undefined = frame
  while (current !== undefined) {
    if (current.outputs.has(nodeId) || current.status.has(nodeId)) return { frame: current }
    current = current.parent
  }
  return undefined
}

function traversePath(root: Record<string, JsonValue>, path: string[]): JsonValue {
  let current: JsonValue | undefined = root[path[0] ?? '']
  for (let i = 1; i < path.length; i++) {
    current = stepPath(current, path[i] ?? '')
    if (current === undefined) return null
  }
  return current === undefined ? null : current
}

/** Resolve an `output` ref against a flat node-id -> outputs map, used by containers. */
export function resolveRefFromOutputs(nodeOutputs: Map<string, Record<string, JsonValue>>, ref: ValueSource): JsonValue {
  if (ref.kind === 'literal') return ref.value
  if (ref.source !== 'output') return null
  const outputs = nodeOutputs.get(ref.node)
  if (outputs === undefined) return null
  return traversePath(outputs, ref.path)
}

/**
 * Build a frame for a scope with its path. `baseSignal` (the owning node's
 * signal) takes precedence over the parent frame's, so a container or subflow
 * node timing out or being cancelled aborts its body.
 */
export function createFrame(scope: string, path: FrameStep[], plan: ExecutionPlan, parent?: Frame, baseSignal?: AbortSignal, inner?: Record<string, JsonValue>): Frame {
  const controller = new AbortController()
  const upstream = baseSignal ?? parent?.signal
  const signal = upstream === undefined ? controller.signal : AbortSignal.any([upstream, controller.signal])
  return {
    scope,
    path,
    plan,
    signal,
    controller,
    parent,
    outputs: new Map(),
    status: new Map(),
    firedPorts: new Map(),
    ...(inner === undefined ? {} : { inner }),
  }
}

/** The execution key for a node within a frame. */
export function execKey(frame: Frame, nodeId: string): string {
  const base = frame.path.map(step => step.index === undefined ? step.node : `${step.node}#${step.index}`).join('/')
  return `${base === '' ? '' : `${base}/`}${nodeId}`
}
