/**
 * token-saver-ui browser half: registers the "Workflow Canvas" sidebar entry and
 * its main panel page. All Host interaction goes through Connection fetch routes.
 *
 * @module @dsh-plugins/token-saver-ui/client
 */

import type { ReactNode } from 'react'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import flowCss from '@xyflow/react/dist/style.css'
import { CanvasPage } from './CanvasPage.tsx'
import { en, zh } from './locales.ts'
import { PAGE_CSS } from './styles.ts'

/** Browser plugin context, narrowed to what this bundle uses. */
export interface ClientCtx {
  effect(fn: () => (() => void) | void): () => void
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  locale: {
    register(ns: string, dict: Record<string, unknown>): () => void
    bind(ns: string): (key: string) => string
  }
}

export const name = 'token-saver-ui'
export const inject = ['slots', 'locale']

const PLUGIN_ID = '@dsh-plugins/token-saver-ui'
const NS = 'tokenSaver'
const PANEL_ID = 'token-saver-canvas'

/** The sidebar entry icon; the sidebar owns the button, label, and selected state. */
function CanvasPanelIcon({ size }: { size: number }): ReactNode {
  return <IconBranchOutlineRegular size={size} />
}

/**
 * Register the dictionaries, page styles, sidebar entry, and main panel.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientCtx): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = PLUGIN_ID
    style.textContent = `${flowCss}\n${PAGE_CSS}`
    document.head.append(style)
    return () => { style.remove() }
  })
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, CanvasPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 40,
    label: () => t('panel'),
    locale: NS,
  }, CanvasPanelIcon))
}
