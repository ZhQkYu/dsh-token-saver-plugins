/** Editor actions shared with the custom node and edge renderers through React context. */

import { createContext, useContext } from 'react'
import type { LocaleKey } from './locales.ts'

/** Operations a node or edge renderer can ask the editor to perform. */
export interface CanvasActions {
  t: (key: LocaleKey) => string
  duplicateNode(id: string): void
  deleteNode(id: string): void
  deleteEdge(id: string): void
}

export const CanvasActionsContext = createContext<CanvasActions | null>(null)

/**
 * Read the editor actions; renderers are only mounted inside the editor.
 * @returns the actions of the enclosing editor.
 */
export function useCanvasActions(): CanvasActions {
  const actions = useContext(CanvasActionsContext)
  if (actions === null) throw new Error('canvas renderer mounted outside the editor')
  return actions
}
