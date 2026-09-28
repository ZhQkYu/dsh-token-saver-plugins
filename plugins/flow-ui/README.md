# @dsh-plugins/flow-ui

The browser half of [`@dsh-plugins/flow`](../flow/README.md): a "Flow" sidebar entry and a main panel with the flow list and the canvas editor. All Host interaction goes through the flow Connection routes.

## Editor

Building a flow needs no JSON:

1. Click **Start** and add the inputs a run needs (name, type, required, default).
2. Select a node and click a node type in the palette: the new node goes after the selected one and is connected; when the selected node already leads somewhere, the new node is inserted in between. With a loop or batch selected, it goes inside, after the last body node. Nothing selected places it in the middle of the view. Dragging from the palette drops it where you release it.
3. Fill in the node on the right. Every value is either typed in or picked from a dropdown of the upstream variables in scope (grouped by node, including object fields and loop `item`/`index`). In prompts and other text, **Reference a variable** inserts `{{name}}` and adds the input in one step; the chips insert existing inputs.
4. On **End**, pick the variables to return, then **Run** at the bottom.

**New flow** asks for the kind: a **deterministic flow** run by the engine, or a **guided flow** that a model follows step by step (see [Guided flows](../flow/README.md#guided-flows)).

- **Guided flows.** The palette offers only the node types a guided flow supports, and a step is written in plain language: what to do and which tools to prefer. A condition asks a question and lists the answers as branches; a loop states its bound and when to stop; **End** describes the result. **Step preview** shows the numbered step list the model receives. **Run** opens a new session that follows the flow, and the canvas shows each step's progress.
- **Web AI.** When the `web_ai_ask` tool is available, the palette offers a **Web AI** item: a tool node preset for asking a web AI chat.
- **Canvas.** Cards show a one-line summary (prompt, URL, tool, inputs/outputs). Every output port is its own handle, so condition, intent, question, and error branches connect individually; connections are checked while dragging (same scope, existing port, no cycle, no duplicate). Deleting a node in a chain reconnects its neighbors. **Tidy up** arranges each scope left to right by execution order and fits containers to their bodies. Edits autosave; `Ctrl/⌘+S` saves immediately; a save conflict offers "load latest" or "overwrite".
- **Inspector.** A form per node type: model picker, prompt templates, JSON output fields, condition branches with operators chosen by the left value's type, loop mode/list/variables/collected outputs, HTTP method/URL/headers/query/body, tool picker whose required parameters appear automatically, subflow picker whose inputs follow the subflow's start fields, question options, and failure handling (stop, defaults, or error exit; retries; timeout). "More" holds the description and the raw JSON for advanced edits.
- **Problems.** The flow is validated locally with the shared spec on every change; messages are localized, name the field, and clicking one selects its node.
- **Run panel.** Pick a workspace, fill the start inputs, run the saved draft, and follow it live: node status and taken edges on the canvas, outputs, messages, the failing node, and an answer box for waiting `question` nodes. The stream reconnects from the last event and falls back to polling.
- **Publish.** Publishing never enables the tool by default; the dialog sets the version note and the optional `flow_<name>` tool.

The tool picker lists tools registered globally, tools of the default Agent preset, and tools visible to an open session's Agent; other tools can be typed in by name. Tool parameters with a fixed set of values are picked from a dropdown.

Not yet available: dragging nodes into or out of an existing container, undo/redo, copy/paste, a code editor with highlighting, and run history.

## Build

```bash
pnpm run build   # bundles src/client/index.tsx into lib/client.js
```
