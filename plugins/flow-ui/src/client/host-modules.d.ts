// Host-provided browser modules this bundle requires at runtime; only the members used here are declared.
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react'
  export function Button(props: {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactNode
  export function Input(props: { icon?: ReactNode; className?: string } & InputHTMLAttributes<HTMLInputElement>): ReactNode
  export function IconBranchOutlineRegular(props: { size: number }): ReactNode
  export function IconPlusOutlineRegular(props: { size: number }): ReactNode
  export function Tooltip(props: { label: string | (() => string); side?: 'right' | 'bottom' | 'top'; align?: 'center' | 'end'; portal?: boolean; children: ReactElement }): ReactNode
  export function Tag(props: { children: ReactNode; tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }): ReactNode
}
