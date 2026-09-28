/**
 * dsh-flow-ui browser half: registers the "Flow" sidebar entry and its main
 * panel page. All Host interaction goes through Connection fetch routes.
 *
 * @module @dsh-plugins/flow-ui/client
 */

import type { ReactNode } from 'react'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { FlowPage } from './FlowPage.tsx'
import { en, zh } from './locales.ts'
import { PAGE_CSS } from './styles.ts'
import xyflowCss from '@xyflow/react/dist/style.css'

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

export const name = 'dsh-flow-ui'
export const inject = ['slots', 'locale']

const PLUGIN_ID = '@dsh-plugins/flow-ui'
const NS = 'dshFlow'
const PANEL_ID = 'dsh-flow'

/** The sidebar entry icon; the sidebar owns the button, label, and selected state. */
function FlowPanelIcon({ size }: { size: number }): ReactNode {
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
    style.textContent = `${xyflowCss}\n${PAGE_CSS}`
    document.head.append(style)
    return () => { style.remove() }
  })
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, FlowPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 41,
    label: () => t('panel'),
    locale: NS,
  }, FlowPanelIcon))
}
