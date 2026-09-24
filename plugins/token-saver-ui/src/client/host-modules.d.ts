// Host-provided browser modules this bundle requires at runtime; only the members used here are declared.
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ReactNode } from 'react'
  export function Button(props: {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: string
    icon?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactNode
  export function IconBranchOutlineRegular(props: { size?: number }): ReactNode
}
