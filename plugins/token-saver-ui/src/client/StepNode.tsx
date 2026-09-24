/**
 * The workflow step node: kind header, title, a one-line detail (tool,
 * provider, referenced workflow, or instruction preview), live run status,
 * a left input handle and either one right output handle or, for condition
 * nodes, one per branch, and a toolbar with duplicate/delete while selected.
 */

import type { CSSProperties, ReactNode } from 'react'
import { Handle, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react'
import { Button, IconCopyOutlineRegular, IconTrashOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ELSE_BRANCH, type NodeKind, type NodeStatus } from '@dsh-plugins/token-saver/protocol'
import { useCanvasActions } from './actions.ts'
import { KIND_COLOR, KindIcon } from './kinds.tsx'

/** Content the editor derives for one node each render. */
export type StepData = {
  kind: NodeKind
  title: string
  /** Tool name, provider, or instruction preview; empty hides the line. */
  detail: string
  /** True when the detail names something the deployment does not offer. */
  detailWarning: boolean
  status?: NodeStatus | undefined
  /** Short run fact beside the status, such as the loop round. */
  badge?: string | undefined
  /** Condition nodes: one output handle per entry, the else exit last. */
  branches?: { id: string; label: string }[] | undefined
  /** Condition nodes: the branch the run took. */
  takenBranch?: string | undefined
}

export type StepFlowNode = Node<StepData, 'step'>

/**
 * Render one step node.
 * @param props - React Flow node props.
 * @returns the node element.
 */
export function StepNode({ id, data, selected }: NodeProps<StepFlowNode>): ReactNode {
  const { t, duplicateNode, deleteNode } = useCanvasActions()
  const color = KIND_COLOR[data.kind]
  return (
    <div className="ts-step" data-selected={selected} data-status={data.status} style={{ '--ts-kind': color } as CSSProperties}>
      <NodeToolbar isVisible={selected} position={Position.Top} className="ts-step-toolbar">
        <Tooltip label={t('duplicateNode')} side="top">
          <Button size="sm" aria-label={t('duplicateNode')} icon={<IconCopyOutlineRegular size={14} />} onClick={() => { duplicateNode(id) }} />
        </Tooltip>
        <Tooltip label={t('deleteNode')} side="top">
          <Button size="sm" aria-label={t('deleteNode')} icon={<IconTrashOutlineRegular size={14} />} onClick={() => { deleteNode(id) }} />
        </Tooltip>
      </NodeToolbar>
      <Handle type="target" position={Position.Left} className="ts-handle" />
      <div className="ts-step-head">
        <span className="ts-step-kind"><KindIcon kind={data.kind} />{t(`kind.${data.kind}`)}</span>
        {data.badge !== undefined && <span className="ts-step-badge">{data.badge}</span>}
        {data.status !== undefined && <span className="ts-step-status" data-status={data.status}>{t(`status.${data.status}`)}</span>}
      </div>
      <div className="ts-step-title">{data.title === '' ? t('untitled') : data.title}</div>
      {data.detail !== '' && <div className="ts-step-detail" data-warning={data.detailWarning}>{data.detail}</div>}
      {data.branches === undefined
        ? <Handle type="source" position={Position.Right} className="ts-handle" />
        : (
          <div className="ts-branches">
            {data.branches.map(branch => (
              <div key={branch.id} className="ts-branch" data-taken={data.takenBranch === branch.id} data-else={branch.id === ELSE_BRANCH}>
                {branch.label}
                <Handle type="source" id={branch.id} position={Position.Right} className="ts-handle ts-branch-handle" />
              </div>
            ))}
          </div>
        )}
    </div>
  )
}
