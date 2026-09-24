/** Per-kind artwork: accent colors and icons shared by the node, palette, and menus. */

import type { ReactNode } from 'react'
import {
  IconApiOutlineRegular, IconBranchOutlineRegular, IconChecklistOutlineRegular, IconDataOutlineRegular, IconDeliverDocRegular,
  IconFolderOpenOutlineRegular, IconGlobeOutlineRegular, IconInspectOutlineRegular, IconRefreshOutlineRegular, IconUsersOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { NodeKind } from '@dsh-plugins/token-saver/protocol'

/** Kind accent colors; artwork, so they stay fixed across themes. */
export const KIND_COLOR: Record<NodeKind, string> = {
  input: '#7c5cff',
  task: '#4c8bf5',
  'web-ai': '#2f9e6e',
  subagent: '#c47c1f',
  tool: '#b0475e',
  review: '#8a6d3b',
  output: '#6b7280',
  condition: '#0e9aa7',
  loop: '#9c4dcc',
  subflow: '#5b6abf',
}

/** Kinds that shape the flow instead of doing a step's work. */
export const CONTROL_KINDS: ReadonlySet<NodeKind> = new Set(['condition', 'loop', 'subflow'])

/**
 * Render the icon of one node kind.
 * @param props.kind - the node kind.
 * @param props.size - icon edge in px.
 * @returns the icon element.
 */
export function KindIcon({ kind, size = 14 }: { kind: NodeKind; size?: number }): ReactNode {
  switch (kind) {
    case 'input': return <IconDataOutlineRegular size={size} />
    case 'task': return <IconChecklistOutlineRegular size={size} />
    case 'web-ai': return <IconGlobeOutlineRegular size={size} />
    case 'subagent': return <IconUsersOutlineRegular size={size} />
    case 'tool': return <IconApiOutlineRegular size={size} />
    case 'review': return <IconInspectOutlineRegular size={size} />
    case 'output': return <IconDeliverDocRegular size={size} />
    case 'condition': return <IconBranchOutlineRegular size={size} />
    case 'loop': return <IconRefreshOutlineRegular size={size} />
    case 'subflow': return <IconFolderOpenOutlineRegular size={size} />
  }
}
