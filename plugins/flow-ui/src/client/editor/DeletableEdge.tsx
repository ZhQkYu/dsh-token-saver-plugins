/**
 * The editor's edge: a bezier path with its branch label and a delete button
 * shown while the edge is hovered or selected. Deletion goes through
 * `deleteElements`, so it reaches the editor's `onEdgesChange` like a
 * Delete-key removal.
 *
 * @module @dsh-plugins/flow-ui/client/editor/DeletableEdge
 */

import { useState, type ReactNode } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type Edge, type EdgeProps } from '@xyflow/react'

/** Edge data: the localized delete-button label and an optional branch label. */
export type DeletableEdgeData = { deleteLabel: string; branch?: string }

/** A React Flow edge carrying {@link DeletableEdgeData}. */
export type DeletableEdgeType = Edge<DeletableEdgeData, 'deletable'>

/**
 * Render one deletable edge.
 * @param props - React Flow edge props.
 * @returns the edge path, label, and delete button.
 */
export function DeletableEdge(props: EdgeProps<DeletableEdgeType>): ReactNode {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, selected, data } = props
  const { deleteElements } = useReactFlow()
  const [hover, setHover] = useState(false)
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const showDelete = hover || selected === true
  return (
    <>
      <g onMouseEnter={() => { setHover(true) }} onMouseLeave={() => { setHover(false) }}>
        <BaseEdge id={id} path={path} {...(markerEnd === undefined ? {} : { markerEnd })} {...(style === undefined ? {} : { style })} interactionWidth={24} />
      </g>
      <EdgeLabelRenderer>
        <div
          className="dsflow-edge__label nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onMouseEnter={() => { setHover(true) }}
          onMouseLeave={() => { setHover(false) }}
        >
          {data?.branch === undefined ? null : <span className="dsflow-edge__branch">{data.branch}</span>}
          {showDelete
            ? (
              <button
                type="button"
                className="dsflow-edge__delete"
                title={data?.deleteLabel}
                aria-label={data?.deleteLabel}
                onClick={(event) => { event.stopPropagation(); void deleteElements({ edges: [{ id }] }) }}
              >
                ×
              </button>
            )
            : null}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
