/**
 * The custom React Flow node renderer: a compact card with the node title, a
 * short summary, an input handle on the left, and one handle per output port
 * on the right.
 *
 * @module @dsh-plugins/flow-ui/client/editor/NodeView
 */

import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { FlowNode } from '@dsh-plugins/flow/spec'
import { specOf } from '@dsh-plugins/flow/spec'
import type { RfNode } from './convert.ts'

/** Render a flow node as a React Flow node. */
export function FlowNodeView({ data, selected }: NodeProps): JSX.Element {
  const flowNode = (data as { flowNode: FlowNode }).flowNode
  const spec = specOf(flowNode)
  const ports = spec.ports(flowNode)
  return (
    <div className={`dsflow-node${selected ? ' dsflow-node--selected' : ''}`} data-node-type={flowNode.type}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="dsflow-node__title">{flowNode.title}</div>
      <div className="dsflow-node__type">{flowNode.type}</div>
      <div className="dsflow-node__ports">
        {ports.map(port => (
          <Handle key={port.id} type="source" position={Position.Right} id={port.id} />
        ))}
      </div>
    </div>
  )
}

/** Render a comment node. */
export function CommentNodeView({ data }: NodeProps): JSX.Element {
  const flowNode = (data as { flowNode: FlowNode }).flowNode
  const text = flowNode.type === 'comment' ? flowNode.data.text : ''
  return (
    <div className="dsflow-comment">
      <div className="dsflow-comment__text">{text}</div>
    </div>
  )
}
