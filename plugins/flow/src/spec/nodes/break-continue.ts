/**
 * break / continue node specs: control flow inside a loop body.
 *
 * @module @dsh-plugins/flow/spec/nodes/break-continue
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'

type BreakNode = Extract<FlowNode, { type: 'break' }>
type ContinueNode = Extract<FlowNode, { type: 'continue' }>

/** The break node spec. */
export const breakSpec: NodeSpec<BreakNode> = {
  type: 'break',
  executable: true,
  container: false,
  allowedParents: ['loop'],
  defaults: () => ({}),
  hasInput: () => true,
  ports: () => [],
  outputs: () => [],
  validate: (_node, _ctx): Issue[] => [],
}

/** The continue node spec. */
export const continueSpec: NodeSpec<ContinueNode> = {
  type: 'continue',
  executable: true,
  container: false,
  allowedParents: ['loop'],
  defaults: () => ({}),
  hasInput: () => true,
  ports: () => [],
  outputs: () => [],
  validate: (_node, _ctx): Issue[] => [],
}
