/**
 * Canvas node renderers. Every output port is its own labelled row with its
 * own handle, so branch ports (condition, intent, question, error) can be
 * connected individually. Containers render their `body` port inside, on the
 * left, and can be resized.
 *
 * @module @dsh-plugins/flow-ui/client/editor/NodeView
 */

import { createContext, useContext, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import type { FlowNode, PortSpec } from '@dsh-plugins/flow/spec'
import { specOf } from '@dsh-plugins/flow/spec'
import { portLabel, type RfNode } from './convert.ts'
import { nodeSummary } from './summary.ts'
import type { LocaleKey, Translate } from '../locales.ts'

/** What node views need from the editor: the translator, the resize callback, and subflow names. */
export const NodeViewContext = createContext<{ t: Translate; onResize(nodeId: string, size: { width: number; height: number }): void; flowName(flowId: string): string | undefined }>({
  t: key => key,
  onResize: () => {},
  flowName: () => undefined,
})

function Summary({ node }: { node: FlowNode }): ReactNode {
  const { t, flowName } = useContext(NodeViewContext)
  const lines = nodeSummary(node, t, flowName)
  if (lines.length === 0) return null
  return <div className="dsflow-node__summary">{lines.map((line, index) => <div key={index} className="dsflow-node__line">{line}</div>)}</div>
}

function Header({ node, t, overlay }: { node: FlowNode; t: Translate; overlay: RfNode['data']['overlay'] }): ReactNode {
  const errors = overlay.issues.filter(issue => issue.severity === 'error')
  const typeName = t(`nodeType.${node.type}` as LocaleKey)
  return (
    <div className="dsflow-node__head">
      <span className="dsflow-node__dot" />
      <span className="dsflow-node__title">{node.title}</span>
      {node.title !== typeName && <span className="dsflow-node__type">{typeName}</span>}
      {errors.length > 0 && <span className="dsflow-node__issue" title={errors.map(issue => issue.message).join('\n')}>!</span>}
      {overlay.status !== undefined && (
        <span className="dsflow-node__status" data-status={overlay.status} title={t(`status.${overlay.status}` as LocaleKey)}>
          {t(`status.${overlay.status}` as LocaleKey)}
          {overlay.durationMs !== undefined ? ` · ${formatDuration(overlay.durationMs)}` : ''}
          {overlay.tokens !== undefined && overlay.tokens > 0 ? ` · ${overlay.tokens} ${t('tokens')}` : ''}
        </span>
      )}
    </div>
  )
}

function OutputPorts({ ports, t }: { ports: PortSpec[]; t: Translate }): ReactNode {
  return (
    <div className="dsflow-node__ports">
      {ports.map(port => (
        <div key={port.id} className="dsflow-node__port" data-kind={port.kind}>
          <span>{portLabel(t, port)}</span>
          <Handle type="source" position={Position.Right} id={port.id} className="dsflow-handle" />
        </div>
      ))}
    </div>
  )
}

/** A regular node. */
export function FlowNodeView({ data, selected }: NodeProps<RfNode>): ReactNode {
  const { t } = useContext(NodeViewContext)
  const node = data.flowNode
  const spec = specOf(node)
  return (
    <div className={`dsflow-node${selected ? ' dsflow-node--selected' : ''}`} data-node-type={node.type}>
      {spec.hasInput(node) && <Handle type="target" position={Position.Left} id="in" className="dsflow-handle dsflow-handle--in" />}
      <Header node={node} t={t} overlay={data.overlay} />
      <Summary node={node} />
      <OutputPorts ports={spec.ports(node)} t={t} />
    </div>
  )
}

/** A loop/batch container with its body port inside. */
export function ContainerNodeView({ id, data, selected }: NodeProps<RfNode>): ReactNode {
  const { t, onResize } = useContext(NodeViewContext)
  const node = data.flowNode
  const spec = specOf(node)
  const outer = spec.ports(node).filter(port => port.kind !== 'body')
  return (
    <div className={`dsflow-container${selected ? ' dsflow-node--selected' : ''}`} data-node-type={node.type}>
      <NodeResizer isVisible={selected} minWidth={260} minHeight={160} onResizeEnd={(_event, params) => { onResize(id, { width: params.width, height: params.height }) }} />
      <Handle type="target" position={Position.Left} id="in" className="dsflow-handle dsflow-handle--in" />
      <Header node={node} t={t} overlay={data.overlay} />
      <Summary node={node} />
      <div className="dsflow-container__body-port">
        <span>{t('port.body')}</span>
        <Handle type="source" position={Position.Right} id="body" className="dsflow-handle" />
      </div>
      <div className="dsflow-container__outer">
        <OutputPorts ports={outer} t={t} />
      </div>
    </div>
  )
}

/** A comment note: no handles. */
export function CommentNodeView({ data }: NodeProps<RfNode>): ReactNode {
  const node = data.flowNode
  return <div className="dsflow-comment">{node.type === 'comment' ? node.data.text || node.title : node.title}</div>
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
