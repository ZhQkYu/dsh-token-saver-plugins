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
.dsflow-editor__side { width: 380px; flex: none; overflow: auto; padding: 12px; border-left: 1px solid var(--dsw-alias-border-l3); box-sizing: border-box; }
.dsflow-editor__problems { display: flex; flex-direction: column; max-height: 120px; overflow: auto; padding: 6px 12px; border-top: 1px solid var(--dsw-alias-border-l3); }
.dsflow-problem { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; border: none; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsflow-problem:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsflow-problem[data-severity="error"] .dsflow-problem__code { color: var(--dsw-alias-state-error-primary); }
.dsflow-problem[data-severity="warning"] .dsflow-problem__code { color: var(--dsw-alias-state-warn-primary); }
.dsflow-problem__code { font-weight: 500; white-space: nowrap; }

.dsflow-palette { width: 150px; flex: none; overflow: auto; padding: 8px; border-right: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); }
.dsflow-palette__category { margin-bottom: 10px; }
.dsflow-palette__label { margin: 2px 4px 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsflow-palette__item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 5px 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: grab; }
.dsflow-palette__item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsflow-palette__hint { padding: 4px 4px 10px; line-height: 1.5; }

.dsflow-node, .dsflow-container { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; }
.dsflow-node { min-width: 180px; max-width: 260px; padding: 6px 0; border-left: 3px solid var(--dsflow-accent, var(--dsw-alias-border-l2)); }
.dsflow-container { width: 100%; height: 100%; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 70%, transparent); }
.dsflow-node--selected { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.dsflow-node__head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 10px 4px; }
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
.dsflow-handle { width: 10px; height: 10px; background: var(--dsw-alias-brand-primary); border: 2px solid var(--dsw-alias-bg-layer-1); }
.dsflow-comment { width: 100%; height: 100%; padding: 8px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow: hidden; }
.dsflow-edge--taken .react-flow__edge-path { stroke: var(--dsw-alias-brand-primary); stroke-width: 2; }
.dsflow-edge--idle .react-flow__edge-path { stroke-dasharray: 4 4; opacity: 0.5; }
.react-flow__edge.selected .react-flow__edge-path, .react-flow__edge:hover .react-flow__edge-path { stroke: var(--dsw-alias-brand-primary); stroke-width: 2; }
.dsflow-edge__label { position: absolute; display: flex; align-items: center; gap: 4px; pointer-events: all; font-size: 11px; }
.dsflow-edge__branch { padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.dsflow-edge__delete { width: 18px; height: 18px; padding: 0; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-error-primary); font-size: 13px; line-height: 16px; cursor: pointer; }
.dsflow-edge__delete:hover { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-layer-1); }
.dsflow-trace { display: flex; flex-direction: column; gap: 4px; }
.dsflow-trace--inspector { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l3); }
.dsflow-trace__item { border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; overflow: hidden; }
.dsflow-trace__item[data-status="failed"] { border-color: var(--dsw-alias-state-error-primary); }
.dsflow-trace__head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 8px; font: inherit; color: inherit; text-align: left; background: var(--dsw-alias-fill-l1); border: none; cursor: pointer; }
.dsflow-trace__head--static { cursor: default; }
.dsflow-trace__caret { width: 10px; color: var(--dsw-alias-label-secondary); }
.dsflow-trace__title { font-weight: 500; }
.dsflow-trace__meta { display: flex; align-items: center; gap: 8px; margin-left: auto; font-size: 12px; }
.dsflow-trace__detail { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.dsflow-trace__section .dsflow-pre { max-height: 240px; overflow: auto; }
.dsflow-trace__summary { cursor: pointer; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); padding: 2px 0; user-select: none; }
.dsflow-trace__section[open] > .dsflow-trace__summary { margin-bottom: 4px; }
.dsflow-trace__text { max-height: 320px; overflow: auto; }
.dsflow-json { position: relative; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; line-height: 1.6; overflow: auto; max-height: 420px; }
.dsflow-json__copy { position: sticky; top: 0; float: right; padding: 0 6px; font: inherit; font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l3); border-radius: 4px; cursor: pointer; }
.dsflow-json__row { display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap; }
.dsflow-json__toggle { display: flex; align-items: baseline; gap: 4px; padding: 0; font: inherit; color: inherit; background: none; border: none; cursor: pointer; text-align: left; }
.dsflow-json__caret { width: 10px; color: var(--dsw-alias-label-secondary); }
.dsflow-json__children { margin-left: 7px; padding-left: 10px; border-left: 1px dashed var(--dsw-alias-border-l3); }
.dsflow-json__key { color: var(--dsw-alias-brand-primary); }
.dsflow-json__colon { color: var(--dsw-alias-label-secondary); margin-right: 2px; }
.dsflow-json__summary { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 11px; }
.dsflow-json__string { color: #2f9e44; word-break: break-word; }
.dsflow-json__number { color: #d9480f; }
.dsflow-json__boolean { color: #7048e8; }
.dsflow-json__null { color: var(--dsw-alias-label-secondary); font-style: italic; }
.dsflow-json__block { flex-basis: 100%; white-space: pre-wrap; word-break: break-word; padding: 4px 6px; border-radius: 4px; background: var(--dsw-alias-bg-layer-1); font-family: inherit; }
.dsflow-resizer { flex: none; background: transparent; transition: background 0.15s; z-index: 5; }
.dsflow-resizer--x { width: 5px; margin: 0 -2px; cursor: col-resize; }
.dsflow-resizer--y { height: 5px; margin: -2px 0; cursor: row-resize; }
.dsflow-resizer:hover, .dsflow-resizing .dsflow-resizer:active { background: var(--dsw-alias-brand-primary); }
body.dsflow-resizing { user-select: none; cursor: grabbing; }
.dsflow-editor__bottom { flex: none; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.dsflow-editor__bottom > .dsflow-run { max-height: none; flex: 1; min-height: 0; }
.dsflow-trace__runs { display: flex; flex-wrap: wrap; gap: 4px; }
.dsflow-trace__run { min-width: 26px; height: 22px; padding: 0 6px; font: inherit; font-size: 12px; color: inherit; background: var(--dsw-alias-fill-l1); border: 1px solid var(--dsw-alias-border-l3); border-radius: 4px; cursor: pointer; }
.dsflow-trace__run[data-status="failed"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsflow-trace__run[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dsflow-tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--dsw-alias-border-l3); }
.dsflow-tab { padding: 6px 12px; font: inherit; color: var(--dsw-alias-label-secondary); background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; }
.dsflow-tab[aria-selected="true"] { color: var(--dsw-alias-brand-primary); border-bottom-color: var(--dsw-alias-brand-primary); }

.dsflow-form { display: flex; flex-direction: column; gap: 12px; }
.dsflow-field { display: flex; flex-direction: column; gap: 4px; }
.dsflow-field__label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsflow-input, .dsflow-textarea { box-sizing: border-box; width: 100%; font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; padding: 5px 8px; }
.dsflow-input:focus, .dsflow-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsflow-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.dsflow-input--narrow { width: auto; flex: none; }
.dsflow-textarea { min-height: 96px; resize: vertical; }
.dsflow-textarea--short { min-height: 56px; }
.dsflow-textarea--code { min-height: 220px; }
.dsflow-textarea--mono { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; }
.dsflow-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; white-space: nowrap; }
.dsflow-bind { display: flex; flex-direction: column; gap: 4px; }
.dsflow-bind__row { display: flex; align-items: flex-start; gap: 4px; }
.dsflow-bind__row > * { min-width: 0; }
.dsflow-bind__row > .dsflow-input, .dsflow-bind__row > .dsflow-field { flex: 1; }
.dsflow-bind__row > .dsflow-bind__name, .dsflow-bind__row > .dsflow-input--type, .dsflow-bind__row > .dsflow-input--op, .dsflow-bind__row > .dsflow-input--method { flex: none; }
.dsflow-bind__row > .dsflow-muted { padding-top: 6px; }

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
.dsflow-run__output { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.dsflow-run__output-name { font-size: 12px; font-weight: 600; }

.dsflow-dialog { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 60%, transparent); }
.dsflow-dialog__panel { display: flex; flex-direction: column; gap: 10px; width: 420px; max-width: calc(100% - 32px); padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dsflow-dialog__title { font-size: 15px; font-weight: 600; }
.dsflow-dialog__actions { display: flex; justify-content: flex-end; gap: 8px; }
.dsflow-editor { position: relative; }
.dsh-flow-kind { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px; }
.dsflow-badge--guided { color: var(--dsw-alias-state-success-primary); }
.dsflow-dialog__panel--wide { width: 720px; max-height: calc(100% - 48px); }
.dsflow-pre--tall { max-height: 60vh; }

[data-node-type="start"], [data-node-type="end"] { --dsflow-accent: var(--dsw-alias-brand-primary); }
[data-node-type="llm"], [data-node-type="intent"], [data-node-type="agent"] { --dsflow-accent: #7c5cff; }
[data-node-type="condition"], [data-node-type="loop"], [data-node-type="batch"], [data-node-type="aggregate"], [data-node-type="subflow"],
[data-node-type="break"], [data-node-type="continue"], [data-node-type="assign"] { --dsflow-accent: var(--dsw-alias-state-warn-primary); }
[data-node-type="code"], [data-node-type="text"], [data-node-type="json"], [data-node-type="http"] { --dsflow-accent: #0ea5a4; }
[data-node-type="tool"] { --dsflow-accent: #3b82f6; }
[data-node-type="question"], [data-node-type="message"] { --dsflow-accent: var(--dsw-alias-state-success-primary); }
[data-node-type="comment"] { --dsflow-accent: var(--dsw-alias-border-l2); }
.dsflow-node__dot, .dsflow-palette__dot { flex: none; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsflow-accent, var(--dsw-alias-border-l2)); }
.dsflow-node__summary { padding: 0 10px 4px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsflow-node__line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dsflow-section { display: flex; flex-direction: column; gap: 6px; }
.dsflow-section__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsflow-section__title { font-size: 12px; font-weight: 600; }
.dsflow-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsflow-hint--clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.dsflow-seg { display: inline-flex; flex-wrap: wrap; align-self: flex-start; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; overflow: hidden; }
.dsflow-seg__item { padding: 4px 10px; border: none; border-right: 1px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.dsflow-seg__item:last-child { border-right: none; }
.dsflow-seg__item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsflow-seg__item[data-active="true"] { background: var(--dsw-alias-fill-l1); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dsflow-icon-btn { flex: none; width: 24px; height: 26px; border: none; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 15px; line-height: 1; cursor: pointer; }
.dsflow-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-state-error-primary); }
.dsflow-add { align-self: flex-start; padding: 3px 10px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.dsflow-add:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsflow-add-select { width: auto; align-self: flex-start; border-style: dashed; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsflow-list { display: flex; flex-direction: column; gap: 6px; }
.dsflow-bind__name { width: 108px; flex: none; }
.dsflow-bind__name--fixed { padding: 5px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; }
.dsflow-value { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
.dsflow-value > select[data-kind="ref"] { color: var(--dsw-alias-brand-primary); }
.dsflow-value__literal { display: flex; align-items: flex-start; gap: 4px; }
.dsflow-value__literal > :first-child { flex: 1; min-width: 0; }
.dsflow-input--type { width: auto; max-width: 104px; flex: none; }
.dsflow-input--number { width: 120px; }
.dsflow-input--op { width: auto; max-width: 150px; flex: none; }
.dsflow-input--method { width: 92px; flex: none; }
.dsflow-input--insert { width: 50px; flex: none; padding: 5px 2px; }
.dsflow-input--quiet { font-size: 12px; background: transparent; }
.dsflow-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.dsflow-chip { display: inline-flex; align-items: center; gap: 2px; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 999px; background: var(--dsw-alias-fill-l1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; cursor: pointer; }
.dsflow-chip:hover { border-color: var(--dsw-alias-brand-primary); }
.dsflow-chips .dsflow-add-select { padding: 2px 6px; font-size: 11px; }
.dsflow-card { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.dsflow-card--else { flex-direction: row; align-items: baseline; gap: 8px; border-style: dashed; background: transparent; }
.dsflow-card__head { display: flex; align-items: center; gap: 6px; }
.dsflow-card__index { flex: none; font-size: 12px; font-weight: 600; color: var(--dsw-alias-brand-primary); }
.dsflow-cond { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); }
.dsflow-kv { display: flex; align-items: center; gap: 4px; }
.dsflow-kv__key { width: 108px; flex: none; }
.dsflow-inline-template { display: flex; flex: 1; gap: 4px; min-width: 0; }
.dsflow-advanced { padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l3); }
.dsflow-advanced > summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsflow-advanced > :not(summary) { margin-top: 8px; }
.dsflow-checklist { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow: auto; padding: 4px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; }
.dsflow-inspector__head { display: flex; align-items: center; gap: 8px; }
.dsflow-inspector__title { font-weight: 600; }
.dsflow-type-badge { flex: none; padding: 2px 8px; border-left: 3px solid var(--dsflow-accent); border-radius: 4px; background: var(--dsw-alias-fill-l1); color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }
.dsflow-issues { margin: 0; padding: 6px 8px 6px 22px; border-radius: 6px; background: var(--dsw-alias-fill-l1); font-size: 12px; }
.dsflow-issues li[data-severity="error"] { color: var(--dsw-alias-state-error-primary); }
.dsflow-issues li[data-severity="warning"] { color: var(--dsw-alias-state-warn-primary); }
.dsflow-guide { font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.dsflow-guide ol { margin: 8px 0; padding-left: 18px; }
.dsflow-problem__node { font-weight: 500; }
`
