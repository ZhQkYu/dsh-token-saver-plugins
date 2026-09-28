/**
 * comment node spec: a non-executable annotation.
 *
 * @module @dsh-plugins/flow/spec/nodes/comment
 */

import type { FlowNode, Issue, NodeSpec } from '../types.ts'

type CommentNode = Extract<FlowNode, { type: 'comment' }>

/** The comment node spec. */
export const commentSpec: NodeSpec<CommentNode> = {
  type: 'comment',
  executable: false,
  container: false,
  allowedParents: ['root', 'loop', 'batch'],
  defaults: () => ({ text: '' }),
  hasInput: () => false,
  ports: () => [],
  outputs: () => [],
  validate: (_node, _ctx): Issue[] => [],
}
