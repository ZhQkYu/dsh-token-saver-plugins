/**
 * Page styles for the flow UI. Colors use DSH theme CSS variables only, so the
 * page adapts to light and dark themes.
 *
 * @module @dsh-plugins/flow-ui/client/styles
 */

/** The flow page stylesheet. */
export const PAGE_CSS = `
.dsh-flow-page { display: flex; flex-direction: column; height: 100%; overflow: hidden; padding: 16px; gap: 12px; }
.dsh-flow-page-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-flow-page-title { font-size: 16px; font-weight: 600; color: var(--vscode-foreground, #d4d4d4); }
.dsh-flow-list { display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.dsh-flow-row { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 6px; background: var(--vscode-editor-background, #1e1e1e); cursor: pointer; }
.dsh-flow-row:hover { border-color: var(--vscode-focusBorder, #007fd4); }
.dsh-flow-row-name { font-weight: 500; color: var(--vscode-foreground, #d4d4d4); }
.dsh-flow-row-desc { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 12px; }
.dsh-flow-empty { color: var(--vscode-descriptionForeground, #9d9d9d); padding: 24px; text-align: center; }

.dsflow-editor { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.dsflow-editor__toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
.dsflow-editor__name { font-weight: 600; }
.dsflow-editor__status { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 12px; }
.dsflow-editor__issues { margin-left: auto; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 12px; }
.dsflow-editor__body { display: flex; flex: 1; min-height: 0; }
.dsflow-editor__canvas { flex: 1; min-width: 0; height: 100%; }
.dsflow-editor__side { width: 320px; border-left: 1px solid var(--vscode-panel-border, #3c3c3c); padding: 12px; overflow: auto; }
.dsflow-editor__side-head { display: flex; align-items: center; justify-content: space-between; font-weight: 600; margin-bottom: 8px; }
.dsflow-editor__empty { color: var(--vscode-descriptionForeground, #9d9d9d); padding: 24px; text-align: center; }
.dsflow-editor__problems { border-top: 1px solid var(--vscode-panel-border, #3c3c3c); max-height: 140px; overflow: auto; padding: 8px 12px; }
.dsflow-problem { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; }
.dsflow-problem--error { color: var(--vscode-errorForeground, #f48771); }
.dsflow-problem--warning { color: var(--vscode-warningForeground, #cca700); }
.dsflow-problem__code { font-weight: 600; }
.dsflow-editor__run { border-top: 1px solid var(--vscode-panel-border, #3c3c3c); padding: 8px 12px; display: flex; flex-direction: column; gap: 8px; }
.dsflow-editor__run-head { display: flex; align-items: center; gap: 8px; }
.dsflow-editor__run-status { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 12px; }
.dsflow-editor__run-output { max-height: 120px; overflow: auto; font-size: 12px; white-space: pre-wrap; }

.dsflow-palette { width: 160px; border-right: 1px solid var(--vscode-panel-border, #3c3c3c); padding: 12px; overflow: auto; }
.dsflow-palette__category { margin-bottom: 12px; }
.dsflow-palette__category-label { font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground, #9d9d9d); margin-bottom: 4px; }
.dsflow-palette__item { display: block; width: 100%; text-align: left; padding: 6px 8px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--vscode-foreground, #d4d4d4); cursor: grab; font-size: 13px; }
.dsflow-palette__item:hover { border-color: var(--vscode-panel-border, #3c3c3c); background: var(--vscode-editor-background, #1e1e1e); }

.dsflow-node { border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 6px; background: var(--vscode-editor-background, #1e1e1e); padding: 8px 12px; min-width: 140px; font-size: 13px; }
.dsflow-node--selected { border-color: var(--vscode-focusBorder, #007fd4); box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4); }
.dsflow-node__title { font-weight: 600; }
.dsflow-node__type { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; }
.dsflow-comment { border: 1px dashed var(--vscode-panel-border, #3c3c3c); border-radius: 6px; padding: 8px; color: var(--vscode-descriptionForeground, #9d9d9d); }

.dsflow-form { display: flex; flex-direction: column; gap: 12px; }
.dsflow-field { display: flex; flex-direction: column; gap: 4px; }
.dsflow-field__label { font-size: 12px; color: var(--vscode-descriptionForeground, #9d9d9d); }
.dsflow-input { background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4); border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 4px; padding: 4px 6px; font-size: 13px; width: 100%; }
.dsflow-textarea { background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4); border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 4px; padding: 6px; font-size: 13px; width: 100%; min-height: 60px; }
.dsflow-textarea--mono { font-family: var(--vscode-editor-font-family, monospace); min-height: 120px; }
.dsflow-form__json { display: flex; flex-direction: column; gap: 4px; }
.dsflow-form__label { font-size: 12px; color: var(--vscode-descriptionForeground, #9d9d9d); }
.dsflow-button { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); border: none; border-radius: 4px; padding: 4px 10px; font-size: 13px; cursor: pointer; }
.dsflow-button--ghost { background: transparent; color: var(--vscode-foreground, #d4d4d4); border: 1px solid var(--vscode-panel-border, #3c3c3c); }
.dsflow-button:disabled { opacity: 0.5; cursor: default; }
.dsflow-bindings { display: flex; flex-direction: column; gap: 8px; }
.dsflow-bindings__row { display: flex; align-items: center; gap: 6px; }
.dsflow-bindings__ref { display: inline-flex; align-items: center; gap: 4px; }
`
