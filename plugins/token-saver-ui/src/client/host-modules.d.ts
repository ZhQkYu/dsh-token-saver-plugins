// Host-provided browser modules this bundle requires at runtime; only the members used here are declared.
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react'
  export function Button(props: {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactNode
  export function Input(props: { icon?: ReactNode; className?: string } & InputHTMLAttributes<HTMLInputElement>): ReactNode
  export function SegmentedControl<Value extends string>(props: {
    id: string
    value: Value
    options: readonly { value: Value; label: string; disabled?: boolean; title?: string }[]
    onChange: (next: Value) => void
    label: string
    disabled?: boolean
    className?: string | undefined
  }): ReactNode
  export function Tooltip(props: {
    label: string | (() => string)
    side?: 'right' | 'bottom' | 'top'
    align?: 'center' | 'end'
    portal?: boolean
    children: ReactElement
  }): ReactNode
  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    icon?: ReactNode
    danger?: boolean
    submenu?: readonly MenuItem[]
  }
  export interface MenuSeparator { type: 'separator'; id: string }
  export interface MenuLabel { type: 'label'; id: string; text: string }
  export type MenuEntry = MenuItem | MenuSeparator | MenuLabel
  export function Menu(props: {
    open: boolean
    anchor: ReactNode
    items?: readonly MenuEntry[]
    onSelect?: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    dense?: boolean
    autoFocus?: boolean
    getAnchorRect?: () => DOMRect | null
  }): ReactNode
  type Icon = (props: { size?: number }) => ReactNode
  export const IconApiOutlineRegular: Icon
  export const IconBranchOutlineRegular: Icon
  export const IconChecklistOutlineRegular: Icon
  export const IconCloseOutlineRegular: Icon
  export const IconCopyOutlineRegular: Icon
  export const IconDataOutlineRegular: Icon
  export const IconDeliverDocRegular: Icon
  export const IconFolderOpenOutlineRegular: Icon
  export const IconGlobeOutlineRegular: Icon
  export const IconInspectOutlineRegular: Icon
  export const IconPlayOutlineRegular: Icon
  export const IconPlusOutlineRegular: Icon
  export const IconRefreshOutlineRegular: Icon
  export const IconSearchOutlineRegular: Icon
  export const IconStopFillRegular: Icon
  export const IconTrashOutlineRegular: Icon
  export const IconUsersOutlineRegular: Icon
  export const IconWorkspaceTreeOutlineRegular: Icon
}
