# @dsh-plugins/flow-ui

The browser half of [`@dsh-plugins/flow`](../flow/README.md): a "Flow" sidebar entry and a main panel with the flow list and the canvas editor. All Host interaction goes through the flow Connection routes.

## Editor

- **Canvas.** Drag nodes from the palette (or click to add; with a loop/batch selected, new nodes go inside it). Every output port is its own handle, so condition, intent, question, and error branches connect individually. Connections are checked while dragging (same scope, existing port, no cycle, no duplicate). Moves, resizes, connections, and deletions are written to the flow document and autosaved; `Ctrl/⌘+S` saves immediately. A save conflict offers "load latest" or "overwrite".
- **Inspector.** Title, description, input bindings (a value, or a reference picked from the upstream variables in scope), and the full node settings as JSON (applied with the button or `Ctrl/⌘+Enter`).
- **Problems.** The flow is validated locally with the shared spec on every change; click an issue to select its node.
- **Run panel.** Pick a workspace, fill the start inputs, run the saved draft, and follow it live: node status and taken edges on the canvas, outputs, messages, and an answer box for waiting `question` nodes. The stream reconnects from the last event and falls back to polling.
- **Publish.** Publishing never enables the tool by default; the dialog sets the version note and the optional `flow_<name>` tool.

Not yet available: dragging nodes into or out of an existing container, undo/redo, copy/paste, auto layout, a code editor with highlighting, and run history.

## Build

```bash
pnpm run build   # bundles src/client/index.tsx into lib/client.js
```
