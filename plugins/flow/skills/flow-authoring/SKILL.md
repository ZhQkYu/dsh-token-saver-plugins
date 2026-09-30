---
name: flow-authoring
description: How to design a Flow workflow document for the flow_design tool — node choice, bindings, references, templates, branches, loops, and outputs. Load before writing or restructuring a flow.
---

# Authoring Flow workflows

A flow is a JSON document: `{ name, description, kind?, nodes: [...], edges: [...] }`. `flow_design save` fills `schemaVersion`, `id`, `revision`, and `updatedAt`, and arranges nodes when you omit `position`. Always send the complete node and edge lists.

## Workflow

1. `flow_design catalog` — real tool names, their argument and `value` schemas, and callable flows.
2. `flow_design reference` (optionally `nodeType`) — each node's default `data`, ports, and outputs. Copy the default data and fill it in.
3. `flow_design create` → `save` → fix every reported error → `debug_node` risky nodes → `test`.

## Document rules

- Exactly one `start` and one `end` at the root. Every node must be reachable from `start`, and `end` must be reachable.
- Node and edge ids match `^[A-Za-z0-9_-]{1,64}$`. Use short readable ids (`fetch`, `classify`, `summary`); titles are for people.
- Edge: `{ id, source, sourceHandle, target }`. `sourceHandle` is a port of the source: `next`, a condition branch id, `else`, an intent id, `other`, a question option id, `error` (with `onError: { onError: "branch" }`), or `body` (container → its first body node).
- No cycles. Repetition uses `loop` or `batch`.
- Container children set `parentId` to the loop/batch id. Edges never cross scopes except `body` from the container to a child.

## Values

Every value is a `ValueSource`:

- literal: `{ "kind": "literal", "value": 42 }`
- node output: `{ "kind": "ref", "node": "fetch", "source": "output", "path": ["json", "items", "0", "title"] }` — `path[0]` is the output name; later segments are object keys or array indices.
- container variable (inside a loop/batch only): `{ "kind": "ref", "node": "<loop id>", "source": "inner", "path": ["item"] }` (`item`, `index`, or a loop variable).

A reference may only point at a node that runs before this one in the same scope or an enclosing scope.

Nodes receive values through **bindings**: `{ "name": "topic", "schema": { "type": "string" }, "value": <ValueSource> }`. Schema types: `string`, `number`, `integer`, `boolean`, `object` (optional `properties: [{ name, schema, required }]`), `array` (optional `items`), `any`. Add `"required": false` when null is acceptable.

## Templates

`llm.system/prompt`, `agent.prompt`, `text.template`, `http.url/headers/body`, `message.template`, `question.question`, `intent.query`, the `end` text template, and literal string tool args are templates. `{{name}}` uses the node's own binding names only, with member paths: `{{user.address.city}}`, `{{items[0].title}}`. Every template variable must be a binding of the same node.

## Choosing nodes

| Need | Node |
|---|---|
| Call a model for text or a JSON object | `llm` (`output.format: "json"` with `fields` for structured output) |
| Pick a route by meaning | `intent` (one port per intent + `other`) |
| Pick a route by value | `condition` (branches with `and`/`or` conditions + `else`) |
| Multi-step reasoning with tools | `agent` (optionally `tools.allow`) — slower and costlier than `llm` |
| Deterministic transform | `code` (TypeScript; `params.<input>`; `return { <output>: ... }`) |
| Web API | `http` (non-2xx is data; check `status`) |
| An existing DSH tool | `tool` (`tool` name, `args` bindings; outputs `text` and `value`) |
| Join text | `text` concat; split with `text` split |
| Parse or print JSON | `json` |
| First non-null of alternatives after branches | `aggregate` |
| Repeat sequentially / in parallel | `loop` / `batch` with body children and collected `outputs` |
| Ask the user mid-run | `question` (text, or options with one port each). Outputs `answer` (the typed text; `""` when an option was picked) and `optionId` (the picked option id; `null` for text). Branch on the option ports, or reference `optionId` — not `answer` — for the choice. |
| Reuse another flow | `subflow` |

## Output typing

- `tool` and `http` accept `outputs: [VarField]` declaring the fields of `value` / `json`, so downstream references can be typed. Copy them from the catalog's `value` schema.
- `llm` JSON mode and `agent`/`code` declare their fields explicitly.
- `loop`/`batch` `outputs` collect one value per iteration into an array.

## Errors

Per node `onError`: `{ "onError": "fail" }` (default), `{ "onError": "default", "defaultOutputs": {...} }`, or `{ "onError": "branch" }` plus an `error` edge. `timeoutMs` and `retries` (0–5) go inside the same object, for example `"onError": { "onError": "default", "timeoutMs": 20000, "retries": 2, "defaultOutputs": {...} }`; they are not node-level fields.

## What flows cannot do

- Flows do not schedule themselves. A run starts from the editor, from `flow_workflow`, or from a published `flow_<name>` tool. For daily runs, tell the user to trigger it externally; do not build timers or loops that wait.
- A `question` node blocks until someone answers. Flows meant to run unattended need a start input that routes around every `question` node.
- Do not put secrets (tokens, cookies) in literals. Ask the user where the secret should come from.
- `aggregate` picks the first non-null input; an empty string is not null. Nodes on an untaken branch are skipped, so a reference to them is null — when several branches reach `end`, join their results with `aggregate` before `end`.
- Keep to the user's request: no demo modes, sample-data switches, or extra probe flows in the delivered flow. Test with `debug_node` sample inputs instead, and delete scratch flows with `delete`.

## Guided flows

`kind: "guided"` flows are step lists a model follows in a conversation. They allow only `start`, `end`, `agent`, `tool`, `condition`, `loop`, `break`, `continue`, `subflow`, `question`, `message`, `comment`. Node descriptions carry the instructions; conditions describe the question in `description` and use branch labels as choices.
