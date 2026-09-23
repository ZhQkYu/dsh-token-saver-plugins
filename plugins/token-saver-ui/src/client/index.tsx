/**
 * token-saver-ui browser half: registers the "Workflow Canvas" sidebar entry and
 * its main panel page. The ctx here is the browser plugin context; all Host
 * interaction goes through Connection fetch routes.
 *
 * @module @dsh-plugins/token-saver-ui/client
 */

import { CanvasPage } from './CanvasPage.tsx'

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

const NS = 'tokenSaver'
const PANEL_ID = 'token-saver-canvas'

const zh = {
  panel: '工作流画布',
  canvas: '工作流画布',
  newGraph: '新建',
  save: '保存',
  run: '运行',
  runInWorkspace: '在工作区中运行',
  delete: '删除',
  graphName: '工作流名称',
  graphDescription: '描述',
  nodeTitle: '节点标题',
  instruction: '指令',
  nodeKind: '节点类型',
  provider: '提供方',
  tool: '工具',
  selectWorkspace: '选择工作区',
  progress: '进度',
}

const en = {
  panel: 'Workflow Canvas',
  canvas: 'Workflow Canvas',
  newGraph: 'New',
  save: 'Save',
  run: 'Run',
  runInWorkspace: 'Run in workspace',
  delete: 'Delete',
  graphName: 'Workflow name',
  graphDescription: 'Description',
  nodeTitle: 'Node title',
  instruction: 'Instruction',
  nodeKind: 'Node kind',
  provider: 'Provider',
  tool: 'Tool',
  selectWorkspace: 'Select workspace',
  progress: 'Progress',
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, () => CanvasPage({ t })))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 40,
    label: () => t('panel'),
    locale: NS,
  }, () => ({ size }: { size: number }) => null))
}
