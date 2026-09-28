/** Page styles; colors come from the host theme's `--dsw-alias-*` tokens so light and dark themes both work. */

export const PAGE_CSS = `
.dsh-flow-page { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; padding: 16px; gap: 12px; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.dsh-flow-page-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-flow-page-title { font-size: 16px; font-weight: 600; }
.dsh-flow-list { display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.dsh-flow-row { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); cursor: pointer; }
.dsh-flow-row:hover { border-color: var(--dsw-alias-brand-primary); }
.dsh-flow-row[data-broken="true"] { cursor: default; opacity: 0.8; }
.dsh-flow-row-main { flex: 1; min-width: 0; }
.dsh-flow-row-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-flow-row-desc { color: var(--dsw-alias-label-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-flow-empty { color: var(--dsw-alias-label-tertiary); padding: 24px; text-align: center; }

.dsflow-row { display: flex; align-items: center; gap: 8px; }
.dsflow-spacer { flex: 1; }
.dsflow-muted { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsflow-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.dsflow-danger { color: var(--dsw-alias-state-error-primary); }
.dsflow-badge { flex: none; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-fill-l1); }
.dsflow-pre { margin: 0; max-height: 160px; overflow: auto; padding: 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; white-space: pre-wrap; }
.dsflow-banner { display: flex; align-items: center; gap: 8px; padding: 6px 12px; color: var(--dsw-alias-state-warn-primary); border-bottom: 1px solid var(--dsw-alias-border-l3); }

.dsflow-editor { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.dsflow-editor__toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l3); }
.dsflow-editor__name { max-width: 280px; font-weight: 600; }
.dsflow-editor__body { display: flex; flex: 1; min-height: 0; }
.dsflow-editor__canvas { flex: 1; min-width: 0; position: relative; }
.dsflow-editor__side { width: 340px; flex: none; overflow: auto; padding: 12px; border-left: 1px solid var(--dsw-alias-border-l3); }
.dsflow-editor__problems { display: flex; flex-direction: column; max-height: 120px; overflow: auto; padding: 6px 12px; border-top: 1px solid var(--dsw-alias-border-l3); }
.dsflow-problem { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; border: none; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsflow-problem:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsflow-problem[data-severity="error"] .dsflow-problem__code { color: var(--dsw-alias-state-error-primary); }
.dsflow-problem[data-severity="warning"] .dsflow-problem__code { color: var(--dsw-alias-state-warn-primary); }
.dsflow-problem__code { font-weight: 500; white-space: nowrap; }

.dsflow-palette { width: 150px; flex: none; overflow: auto; padding: 8px; border-right: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); }
.dsflow-palette__category { margin-bottom: 10px; }
.dsflow-palette__label { margin: 2px 4px 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsflow-palette__item { display: block; width: 100%; text-align: left; padding: 5px 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: grab; }
.dsflow-palette__item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsflow-palette__hint { padding: 4px; line-height: 1.5; }

.dsflow-node, .dsflow-container { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; }
.dsflow-node { min-width: 170px; padding: 6px 0; }
.dsflow-container { width: 100%; height: 100%; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 70%, transparent); }
.dsflow-node--selected { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.dsflow-node__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; padding: 0 10px 4px; }
.dsflow-container .dsflow-node__head { padding: 6px 10px; border-bottom: 1px dashed var(--dsw-alias-border-l3); }
.dsflow-node__title { font-weight: 600; font-size: 13px; }
.dsflow-node__type { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsflow-node__issue { color: var(--dsw-alias-state-error-primary); font-weight: 700; }
.dsflow-node__status { flex-basis: 100%; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsflow-node__status[data-status="succeeded"] { color: var(--dsw-alias-state-success-primary); }
.dsflow-node__status[data-status="failed"] { color: var(--dsw-alias-state-error-primary); }
.dsflow-node__status[data-status="running"], .dsflow-node__status[data-status="waiting"] { color: var(--dsw-alias-brand-primary); }
.dsflow-node__ports { display: flex; flex-direction: column; }
.dsflow-node__port { position: relative; padding: 2px 14px 2px 10px; text-align: right; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsflow-node__port[data-kind="error"] { color: var(--dsw-alias-state-error-primary); }
.dsflow-container__body-port { position: relative; display: inline-block; margin: 6px 0 0 8px; padding: 2px 14px 2px 8px; border-radius: 6px; background: var(--dsw-alias-fill-l1); font-size: 11px; }
.dsflow-container__outer { position: absolute; right: 0; top: 34px; }
.dsflow-handle { width: 8px; height: 8px; background: var(--dsw-alias-brand-primary); border: 1px solid var(--dsw-alias-bg-layer-1); }
.dsflow-comment { width: 100%; height: 100%; padding: 8px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow: hidden; }
.dsflow-edge--taken .react-flow__edge-path { stroke: var(--dsw-alias-brand-primary); stroke-width: 2; }
.dsflow-edge--idle .react-flow__edge-path { stroke-dasharray: 4 4; opacity: 0.5; }

.dsflow-form { display: flex; flex-direction: column; gap: 12px; }
.dsflow-field { display: flex; flex-direction: column; gap: 4px; }
.dsflow-field__label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsflow-input, .dsflow-textarea { box-sizing: border-box; width: 100%; font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; padding: 5px 8px; }
.dsflow-input:focus, .dsflow-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsflow-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.dsflow-input--narrow { width: auto; flex: none; }
.dsflow-textarea { min-height: 160px; resize: vertical; }
.dsflow-textarea--short { min-height: 56px; }
.dsflow-textarea--mono { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; }
.dsflow-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; white-space: nowrap; }
.dsflow-binding { display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; }
.dsflow-binding__row { display: flex; align-items: center; gap: 4px; }
.dsflow-binding__row .dsflow-input { min-width: 0; }

.dsflow-run { display: flex; flex-direction: column; gap: 8px; max-height: 38%; overflow: auto; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l3); }
.dsflow-run__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsflow-run__title { font-weight: 600; }
.dsflow-run__status[data-status="succeeded"] { color: var(--dsw-alias-state-success-primary); }
.dsflow-run__status[data-status="failed"] { color: var(--dsw-alias-state-error-primary); }
.dsflow-run__status[data-status="running"], .dsflow-run__status[data-status="waiting"] { color: var(--dsw-alias-brand-primary); }
.dsflow-run__inputs { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.dsflow-run__input { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.dsflow-run__question { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 6px; }
.dsflow-run__options { display: flex; flex-wrap: wrap; gap: 6px; }
.dsflow-run__result { display: flex; flex-direction: column; gap: 6px; }
.dsflow-run__message { padding: 4px 6px; border-radius: 6px; background: var(--dsw-alias-fill-l1); white-space: pre-wrap; }

.dsflow-dialog { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 60%, transparent); }
.dsflow-dialog__panel { display: flex; flex-direction: column; gap: 10px; width: 420px; max-width: calc(100% - 32px); padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dsflow-dialog__title { font-size: 15px; font-weight: 600; }
.dsflow-dialog__actions { display: flex; justify-content: flex-end; gap: 8px; }
.dsflow-editor { position: relative; }
`
