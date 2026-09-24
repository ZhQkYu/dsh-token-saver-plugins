/** Page styles; colors come from the host theme's `--dsw-alias-*` tokens so light and dark themes both work. */

export const PAGE_CSS = `
.ts-canvas { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.ts-canvas-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l3); }
.ts-canvas-bar .ts-spacer { flex: 1; }
.ts-canvas-notice { color: var(--dsw-alias-label-secondary); }
.ts-canvas-notice[data-kind="error"] { color: var(--dsw-alias-state-error-primary); }
.ts-canvas-body { display: flex; flex: 1; min-height: 0; }
.ts-canvas-list { width: 200px; overflow: auto; padding: 8px; border-right: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); }
.ts-canvas-list h3 { margin: 4px 4px 8px; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.ts-canvas-list-item { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.ts-canvas-list-item button.ts-graph { flex: 1; min-width: 0; justify-content: flex-start; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ts-canvas-list-item[data-active="true"] button.ts-graph { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); font-weight: 500; }
.ts-canvas-flow { flex: 1; min-width: 0; position: relative; }
.ts-canvas-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--dsw-alias-label-tertiary); }
.ts-canvas-inspector { width: 280px; overflow: auto; padding: 12px; border-left: 1px solid var(--dsw-alias-border-l3); display: flex; flex-direction: column; gap: 6px; }
.ts-canvas-inspector label { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 6px; }
.ts-canvas-inspector textarea, .ts-canvas-inspector select, .ts-canvas-bar select, .ts-canvas-inspector > input, .ts-branch-edit input, .ts-rule input {
  font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; padding: 5px 8px;
}
.ts-canvas-inspector textarea:focus, .ts-canvas-inspector select:focus, .ts-canvas-inspector > input:focus, .ts-branch-edit input:focus, .ts-rule input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.ts-canvas-inspector textarea { min-height: 120px; resize: vertical; }
.ts-canvas-inspector textarea.ts-short { min-height: 56px; }
.ts-branch-edit { display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; }
.ts-branch-edit-row { display: flex; align-items: center; gap: 4px; }
.ts-branch-edit-row input { flex: 1; min-width: 0; }
.ts-rule { display: flex; gap: 4px; }
.ts-rule select { flex: none; }
.ts-rule input { flex: 1; min-width: 0; }
.ts-canvas-summary[data-warning="true"] { color: var(--dsw-alias-state-error-primary); }
.ts-graph-name { overflow: hidden; text-overflow: ellipsis; }
.ts-graph-badge { flex: none; margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-fill-l1); }
.ts-canvas-inspector .ts-danger { margin-top: 12px; }
.ts-danger { color: var(--dsw-alias-state-error-primary); }
.ts-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.ts-field-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.ts-field-hint[data-warning="true"] { color: var(--dsw-alias-state-warn-primary); }
.ts-canvas-summary { white-space: pre-wrap; padding: 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.ts-canvas-progress { padding: 6px 12px; border-top: 1px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
.ts-menu-anchor { position: fixed; width: 0; height: 0; pointer-events: none; }

.ts-kind-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
.ts-kind-chip, .ts-palette-item {
  display: flex; align-items: center; gap: 6px; min-width: 0; padding: 5px 8px; border: 1px solid transparent; border-radius: 6px;
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: transparent; cursor: pointer; text-align: left; white-space: nowrap;
}
.ts-kind-chip { border-color: var(--dsw-alias-border-l3); }
.ts-kind-chip svg, .ts-palette-item svg { flex: none; color: var(--ts-kind); }
.ts-kind-chip:hover, .ts-palette-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ts-kind-chip[aria-checked="true"] { border-color: var(--ts-kind); background: color-mix(in srgb, var(--ts-kind) 12%, transparent); }

.ts-palette { display: flex; flex-direction: column; gap: 2px; padding: 6px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.ts-palette-title { padding: 2px 8px 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.ts-palette-item { cursor: grab; }
.ts-palette-item:active { cursor: grabbing; }
.ts-canvas-hint { max-width: 420px; padding: 8px 12px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); line-height: 1.5; pointer-events: none; }

.ts-tool-picker { display: flex; flex-direction: column; gap: 4px; }
.ts-tool-list { display: flex; flex-direction: column; max-height: 240px; overflow: auto; padding: 2px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }
.ts-tool-list > .ts-field-hint { padding: 6px 8px; }
.ts-tool-row { display: flex; flex-direction: column; gap: 1px; padding: 5px 8px; border: none; border-radius: 4px; font: inherit; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.ts-tool-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ts-tool-row[aria-selected="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.ts-tool-name { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; font-weight: 500; }
.ts-tool-row[aria-selected="true"] .ts-tool-name { color: var(--dsw-alias-brand-primary); }
.ts-tool-description { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

.ts-canvas .react-flow {
  --xy-background-color: var(--dsw-alias-bg-layer-1);
  --xy-background-pattern-color: var(--dsw-alias-border-l3);
  --xy-node-background-color: transparent;
  --xy-node-color: var(--dsw-alias-label-primary);
  --xy-node-border: none;
  --xy-node-boxshadow-selected: none;
  --xy-node-border-radius: 8px;
  --xy-edge-stroke: var(--dsw-alias-label-tertiary);
  --xy-edge-stroke-selected: var(--dsw-alias-brand-primary);
  --xy-connectionline-stroke: var(--dsw-alias-brand-primary);
  --xy-handle-background-color: var(--dsw-alias-bg-layer-1);
  --xy-handle-border-color: var(--dsw-alias-label-tertiary);
  --xy-selection-background-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);
  --xy-selection-border: 1px dashed var(--dsw-alias-brand-primary);
  --xy-minimap-background-color: var(--dsw-alias-bg-layer-2);
  --xy-controls-button-background-color: var(--dsw-alias-bg-layer-2);
  --xy-controls-button-background-color-hover: var(--dsw-alias-interactive-bg-hover-solid);
  --xy-controls-button-color: var(--dsw-alias-label-primary);
  --xy-controls-button-color-hover: var(--dsw-alias-label-primary);
  --xy-controls-button-border-color: var(--dsw-alias-border-l3);
}

.ts-step {
  position: relative; width: 200px; display: flex; flex-direction: column; gap: 4px; padding: 8px 10px 9px;
  border: 1px solid var(--dsw-alias-border-l2); border-left: 3px solid var(--ts-kind); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); box-shadow: 0 1px 4px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  transition: box-shadow 120ms ease, border-color 120ms ease;
}
.react-flow__node:hover .ts-step { border-color: var(--dsw-alias-border-l1); border-left-color: var(--ts-kind); }
.ts-step[data-selected="true"] { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.ts-step-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.ts-step-kind { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ts-step-kind svg { color: var(--ts-kind); }
.ts-step-status { padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-fill-l1); }
.ts-step-status[data-status="running"] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.ts-step-status[data-status="done"] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.ts-step-status[data-status="failed"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }
.ts-step-title { font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; }
.ts-step-detail { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ts-step-detail[data-warning="true"] { color: var(--dsw-alias-state-warn-primary); }
.ts-step[data-status="running"] { animation: ts-pulse 1.2s ease-in-out infinite; }
.ts-step[data-status="done"] { border-color: var(--dsw-alias-state-success-primary); border-left-color: var(--ts-kind); }
.ts-step[data-status="failed"] { border-color: var(--dsw-alias-state-error-primary); border-left-color: var(--ts-kind); }
.ts-step[data-status="skipped"] { opacity: 0.55; border-style: dashed; }
@keyframes ts-pulse { 50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); } }
.ts-step-toolbar { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }

/* Handles sit at a fixed offset from the node top, not at 50% height, so top-aligned nodes of any height connect with a straight line. */
.ts-step .react-flow__handle.ts-handle { top: 20px; width: 12px; height: 12px; border-width: 2px; border-radius: 50%; opacity: 0.6; transition: opacity 120ms ease, transform 120ms ease, background 120ms ease; }
.ts-step .react-flow__handle.ts-handle::after { content: ""; position: absolute; border-radius: 50%; }
/* The enlarged hit area stays on the node side so the edge-end reconnect zone outside the handle remains grabbable. */
.ts-step .react-flow__handle-left.ts-handle::after { inset: -8px -8px -8px 0; }
.ts-step .react-flow__handle-right.ts-handle::after { inset: -8px 0 -8px -8px; }
.react-flow__node:hover .ts-handle, .ts-step[data-selected="true"] .ts-handle, .react-flow__handle.ts-handle.connectingfrom { opacity: 1; }
.ts-step .react-flow__handle.ts-handle:hover { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); transform: translate(var(--ts-handle-shift, 0), -50%) scale(1.25); }
.ts-step .react-flow__handle-left.ts-handle { --ts-handle-shift: -50%; }
.ts-step .react-flow__handle-right.ts-handle { --ts-handle-shift: 50%; }
.react-flow__handle.ts-handle.connectingto.valid { background: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); opacity: 1; }
.react-flow__handle.ts-handle.connectingto:not(.valid) { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); opacity: 1; }

.ts-step-badge { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ts-branches { display: flex; flex-direction: column; gap: 2px; margin: 2px -10px 0 0; }
.ts-branch { position: relative; padding: 2px 14px 2px 0; border-top: 1px dashed var(--dsw-alias-border-l3); font-size: 11px; line-height: 16px; text-align: right; color: var(--dsw-alias-label-secondary); }
.ts-branch[data-else="true"] { color: var(--dsw-alias-label-tertiary); }
.ts-branch[data-taken="true"] { color: var(--ts-kind); font-weight: 500; }
.ts-step .react-flow__handle.ts-branch-handle { top: 50%; }

.react-flow__edge-path.ts-edge { stroke-width: 1.5; transition: stroke 120ms ease; }
.react-flow__edge-path.ts-edge[data-active="true"] { stroke: var(--dsw-alias-brand-primary); stroke-width: 2; }
.ts-edge-delete { position: absolute; z-index: 1001; pointer-events: all; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 0 0 1px var(--dsw-alias-border-l2), 0 2px 6px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent); }
.ts-edge-delete button:hover { color: var(--dsw-alias-state-error-primary); }
`
