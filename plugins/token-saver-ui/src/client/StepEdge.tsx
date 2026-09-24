/**
 * The workflow edge: a bezier curve with an arrow, straight when both handles
 * share a row, and a delete button at its midpoint while hovered or selected.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import { Button, IconCloseOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCanvasActions } from './actions.ts'

export type StepFlowEdge = Edge<Record<string, never>, 'step'>

/** Grace period that lets the pointer cross from the SVG path onto the HTML button. */
const HIDE_DELAY_MS = 150

/**
 * Render one edge.
 * @param props - React Flow edge props.
 * @returns the edge path and its hover controls.
 */
export function StepEdge(props: EdgeProps<StepFlowEdge>): ReactNode {
  const { t, deleteEdge } = useCanvasActions()
  const [hovered, setHovered] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { clearTimeout(hideTimer.current) }, [])
  const show = (): void => {
    clearTimeout(hideTimer.current)
    setHovered(true)
  }
  const hide = (): void => {
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => { setHovered(false) }, HIDE_DELAY_MS)
  }
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX, sourceY: props.sourceY, sourcePosition: props.sourcePosition,
    targetX: props.targetX, targetY: props.targetY, targetPosition: props.targetPosition,
  })
  const active = hovered || props.selected === true
  return (
    <g onMouseEnter={show} onMouseLeave={hide}>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} interactionWidth={24} className="ts-edge" data-active={active} />
      {active && (
        <EdgeLabelRenderer>
          <div
            className="ts-edge-delete nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={show}
            onMouseLeave={hide}
          >
            <Tooltip label={t('deleteEdge')} side="top">
              <Button size="sm" aria-label={t('deleteEdge')} icon={<IconCloseOutlineRegular size={12} />} onClick={() => { deleteEdge(props.id) }} />
            </Tooltip>
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  )
}
