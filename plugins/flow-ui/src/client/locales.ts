/**
 * zh/en dictionaries for the flow UI. The browser plugin registers these under
 * the `dshFlow` namespace; all product text routes through `t()`.
 *
 * @module @dsh-plugins/flow-ui/client/locales
 */

/** The en dictionary. */
export const en = {
  panel: 'Flow',
  empty: 'No flows yet. Create one to get started.',
  newFlow: 'New flow',
  name: 'Name',
  description: 'Description',
  updatedAt: 'Updated',
  open: 'Open',
  broken: 'Broken',
  delete: 'Delete',
  create: 'Create',
  cancel: 'Cancel',
  loadError: 'Failed to load flows',
  loading: 'Loading…',
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  save: 'Save',
  publish: 'Publish',
  published: 'Published',
  run: 'Run',
  stop: 'Stop',
  running: 'Running…',
  runFailed: 'Run failed',
  runPanel: 'Run',
  selectNode: 'Select a node to edit.',
  issues: 'issues',
} as const

/** The zh dictionary. */
export const zh = {
  panel: '工作流',
  empty: '还没有工作流。创建一个开始使用。',
  newFlow: '新建工作流',
  name: '名称',
  description: '描述',
  updatedAt: '更新时间',
  open: '打开',
  broken: '损坏',
  delete: '删除',
  create: '创建',
  cancel: '取消',
  loadError: '加载工作流失败',
  loading: '加载中…',
  saved: '已保存',
  unsaved: '有未保存的更改',
  save: '保存',
  publish: '发布',
  published: '已发布',
  run: '试运行',
  stop: '停止',
  running: '运行中…',
  runFailed: '运行失败',
  runPanel: '试运行',
  selectNode: '选择一个节点进行编辑。',
  issues: '问题',
} as const

/** The locale shape used by `t()`. */
export type Locale = typeof en
