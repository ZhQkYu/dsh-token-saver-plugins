/** Page styles; colors come from the host theme's `--dsw-alias-*` tokens so light and dark themes both work. */

export const PAGE_CSS = `
.ts-canvas { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.ts-canvas-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l3); }
.ts-canvas-bar .ts-spacer { flex: 1; }
.ts-canvas-notice { color: var(--dsw-alias-label-secondary); }
.ts-canvas-notice[data-kind="error"] { color: var(--dsw-alias-state-error-primary); }
.ts-canvas-body { display: flex; flex: 1; min-height: 0; }
.ts-canvas-list { width: 200px; overflow: auto; padding: 8px; border-right: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); }
.ts-canvas-list h3 { margin: 4px 4px 8px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.ts-canvas-list-item { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.ts-canvas-list-item button.ts-graph { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ts-canvas-list-item[data-active="true"] button.ts-graph { color: var(--dsw-alias-brand-primary); font-weight: 600; }
.ts-canvas-flow { flex: 1; min-width: 0; position: relative; }
.ts-canvas-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--dsw-alias-label-tertiary); }
.ts-canvas-inspector { width: 260px; overflow: auto; padding: 12px; border-left: 1px solid var(--dsw-alias-border-l3); display: flex; flex-direction: column; gap: 6px; }
.ts-canvas-inspector label { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 6px; }
.ts-canvas-inspector textarea, .ts-canvas-inspector select, .ts-canvas-bar select, .ts-canvas-inspector input {
  font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; padding: 4px 6px;
}
.ts-canvas-inspector textarea { min-height: 120px; resize: vertical; }
.ts-canvas-summary { white-space: pre-wrap; padding: 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.ts-canvas-progress { padding: 6px 12px; border-top: 1px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
.ts-canvas .react-flow {
  --xy-background-color: var(--dsw-alias-bg-layer-1);
  --xy-background-pattern-color: var(--dsw-alias-border-l3);
  --xy-node-background-color: var(--dsw-alias-bg-layer-2);
  --xy-node-color: var(--dsw-alias-label-primary);
  --xy-node-border-radius: 8px;
  --xy-edge-stroke: var(--dsw-alias-label-tertiary);
  --xy-minimap-background-color: var(--dsw-alias-bg-layer-2);
  --xy-controls-button-background-color: var(--dsw-alias-bg-layer-2);
  --xy-controls-button-color: var(--dsw-alias-label-primary);
  --xy-controls-button-border-color: var(--dsw-alias-border-l3);
}
.ts-node { display: flex; flex-direction: column; gap: 2px; text-align: left; }
.ts-node-kind { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ts-node-title { font-weight: 600; overflow-wrap: anywhere; }
.ts-node-status { font-size: 11px; }
.react-flow__node.ts-status-running { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); animation: ts-pulse 1.2s ease-in-out infinite; }
.react-flow__node.ts-status-done { box-shadow: 0 0 0 2px var(--dsw-alias-state-success-primary); }
.react-flow__node.ts-status-failed { box-shadow: 0 0 0 2px var(--dsw-alias-state-error-primary); }
.react-flow__node.ts-status-skipped { opacity: 0.55; border-style: dashed; }
@keyframes ts-pulse { 50% { box-shadow: 0 0 0 4px var(--dsw-alias-brand-primary); } }
`
