# @dsh-plugins/flow

A Coze-style **workflow engine** for DeepSeek Harness. A flow is a graph: `start` → nodes → `end`. Each flow has one of two kinds (`kind`):

| Kind | Who runs it | Use for |
|---|---|---|
| `flow` (default) | The engine. Nodes exchange **typed variables** through named input bindings, and the engine decides what runs next, so branches, loops, batches, and subflows behave the same way every time. | Fixed pipelines |
| `guided` | A model. The engine compiles the graph into a numbered step list that a model follows and reports on step by step (see [Guided flows](#guided-flows)). | Tasks that need judgment, such as research or writing |

The browser editor lives in [`@dsh-plugins/flow-ui`](../flow-ui/README.md).

## Installation

```bash
cd dsh-plugins
pnpm install
pnpm run build
```

Enable `dsh-flow` (Host) and `dsh-flow-ui` (Client) on the Plugins page. Flows are stored under `~/.dsh/flow` unless `storageDir` is set.

## Examples

[`examples/`](examples) holds four flows you can import from the editor (`flow.import`):

| File | Shows |
|---|---|
| `topic-outline.json` | LLM JSON output → `batch` expanding each item in parallel |
| `http-check.json` | `http` → `condition` on status → `code` or `message` → `aggregate` |
| `review-loop.json` | `loop` (infinite, max 5) with an LLM review, `break`, and `assign` |
| `read-summarize-confirm.json` | `tool` (`read`) → `agent` → `question`; publish it as a tool and call it from a conversation |

## Nodes

Every input a node uses is a named binding (`inputs` / `args`): a literal value or a reference to an upstream node output, a container's inner variable (`item`, `index`, loop variables), or a field inside either. Templates (`{{name}}`, `{{name.field}}`) may only use the node's own binding names; there are no expressions and no `eval`.

| Type | Ports | Outputs | Runs |
|---|---|---|---|
| `start` | `next` | the declared fields | Validates run inputs and applies defaults |
| `end` | — | the bindings (`variables`) or `{ text }` (`text` template) | Produces the run result |
| `llm` | `next` | `text`, `reasoning`, or the declared JSON fields | One model call; JSON mode retries once with the rejected reply |
| `intent` | one per intent + `other` | `intent` (label), `intentId`, `reason` | LLM classification |
| `agent` | `next` | `text`, or the declared fields | Child Agent (`subagents`), optional tool allow-list |
| `condition` | one per branch + `else` | `branch` | First branch whose `and`/`or` conditions hold |
| `code` | `next` | the declared fields | TypeScript in the `ptcRuntime` sandbox; inputs arrive only through `params` |
| `http` | `next` | `status`, `headers`, `body`, `json` | SSRF-guarded request; non-2xx is data, not failure |
| `tool` | `next` | `text`, `value` | A registered DSH tool, through the normal permission pipeline |
| `text` | `next` | `text` (concat) / `parts` (split) | Pure |
| `json` | `next` | parsed fields / `text` | Pure |
| `aggregate` | `next` | one per group | First executed, non-null, type-compatible candidate |
| `loop` | `next`, `body` | collected arrays + final loop variables | Sequential rounds over an array, a count, or until `break` (`LOOP_LIMIT` at `maxIterations`) |
| `batch` | `next`, `body` | collected arrays (by index) | Parallel items; the first failing item cancels the rest |
| `break` / `continue` / `assign` | — / — / `next` | — | Loop control; allowed only inside a `loop` |
| `subflow` | `next` | the subflow's `end` outputs | Another flow (published or draft) in the same run |
| `question` | `next`, or one per option (+ `other`) | `answer`, `optionId` | Canvas runs wait for an answer in the run panel; tool runs ask in the conversation |
| `message` | `next` | `text` | Emits a run message |
| `comment` | — | — | Annotation only |

Error policy (`onError`) per node: `fail` (default), `default` (use `defaultOutputs`, add `errorMessage`), or `branch` (fire the `error` port). `timeoutMs` and `retries` (0–5) apply to every policy. A timed-out attempt is aborted before the next one starts.

## Runs

- **Validation first.** `run.start` compiles and validates the flow, checks optional services (`ptcRuntime`, `subagents`, `userQuestions`), resolves the workspace, and validates the inputs before anything is written; failures return `400 { issues }` or `400 { error }`.
- **Terminal states.** Every run ends with exactly one `run.finished`: `succeeded`, `failed` (node error, `END_NOT_REACHED`, `RUN_TIMEOUT`, `BUDGET_EXCEEDED`), or `cancelled` (user or plugin unload).
- **Budgets** (`maxNodeExecutionsPerRun`, `maxLlmCallsPerRun`, `maxAgentNodesPerRun`) and the total duration (`maxRunDurationMs`) are run-fatal: no error policy can absorb them.
- **Concurrency.** Independent branches start as soon as their inputs are ready; `maxConcurrentNodes` bounds leaf nodes (containers and subflows never hold a slot).
- **Events.** `run.events` streams NDJSON: persisted events after `after`, then live events, a `ping` every 15 s, and closes after `run.finished`. Only `node.delta` is coalesced under backpressure. Event values are redacted (keys like `authorization`, `cookie`, `token`, `secret`, `password`) and truncated to `recordValueChars`; downstream nodes always receive the full values.
- **Workspace.** Canvas and debug runs use the `workspaceId` from the request. A flow called as a tool runs in the calling session's working directory. Code nodes and the lazily created run session use that directory.

## Guided flows

A guided flow allows `start`, `end`, `agent` (a step), `tool`, `condition`, `loop`, `break`, `continue`, `subflow`, `question`, `message`, and `comment`; other node types fail validation with `GUIDED_UNSUPPORTED`. The engine checks the graph (links, ports, loop nesting) but not variable types, because the model supplies the values.

- **Steps.** Each node except `start` and `comment` becomes a numbered step; loop bodies are numbered under their loop (`3.1`, `3.2`). A step on a branch carries the gate `Only if step N chose "X"`. A condition's description is the question the model answers; its branch labels are the choices. A loop repeats its body once per item, a count of times, or up to `maxIterations`, and stops early once its `until` text holds. The `end` node's `text` template states the required result; its bindings declare structured result fields.
- **Runs.** A guided run records the same `node.started` / `node.finished` events as a deterministic run, so the editor shows its progress on the canvas. A run started from the editor opens a new session (with `runAgentPreset` / `runPermissionPreset`) that follows the flow. A run fails with `RUN_TIMEOUT` when it is not finished within `maxRunDurationMs`. Guided runs live in the Host process; a restart marks them `interrupted`.
- **Inside other flows.** A published guided flow can be a `subflow` step of a deterministic or guided flow, and can be published as a `flow_<name>` tool. In both cases one child Agent (`subagents`) follows the whole step list and returns the result.

## The `flow_workflow` tool

The plugin always registers one tool, `flow_workflow`, whose definition does not change when flows are added or removed, so it does not invalidate the prompt cache:

| `action` | Does |
|---|---|
| `list` | Lists flows with their kind, version, and inputs |
| `run` | Runs a deterministic flow (latest published version, or the draft if never published) with the caller's Agent and returns its outputs |
| `start` | Starts a guided run in the current conversation and returns the step list; the model then does the steps itself |
| `report` | Reports one guided step (`nodeId`, `status` `running`/`done`/`skipped`/`failed`, `summary`, chosen `branch`, and `outputs` for the `end` step) and returns what is left |
| `status` | Returns a guided run's progress |

## Workflows as tools

Publishing with "offer as a tool" registers `flow_<name>` (`name` matches `^[a-z][a-z0-9_]{0,40}$`; the prefix is `tools.prefix`). The tool runs the latest published snapshot with the caller's Agent, so approvals and PTC presentation flow through the caller; cancelling the tool call cancels the run; a failed run fails the tool call with the failing node and error code. Republishing refreshes the tool's schema; publishing with the tool turned off removes it; a taken name is rejected with `409 TOOL_NAME_TAKEN`.

## Configuration

Every tunable is a `Config` field in [`cordis.patch.yml`](cordis.patch.yml):

| Field | Default | Effect |
|---|---|---|
| `storageDir` | `~/.dsh/flow` | Flow, version, and run storage |
| `maxFlowBytes` | 1 MiB | Largest flow document and request body |
| `keepRunsPerFlow` | 50 | Runs kept per flow (older ones are pruned when a run ends) |
| `maxRunEventsBytes` | 8 MiB | Persisted events per run; past it only `run.finished` is written and the summary is marked `eventsTruncated` |
| `recordValueChars` | 20000 | Truncation of recorded values |
| `maxValueBytes` | 4 MiB | Largest node output or run input (`VALUE_TOO_LARGE`) |
| `runAgentPreset` / `runPermissionPreset` | deployment default | Preset of the canvas run session (must use native tool presentation) |
| `archiveRunSessions` | `true` | Archive the canvas run session when the run ends |
| `maxConcurrentNodes` | 8 | Concurrent leaf nodes per run |
| `maxNodeExecutionsPerRun` / `maxLlmCallsPerRun` / `maxAgentNodesPerRun` | 2000 / 200 / 20 | Run budgets |
| `maxRunDurationMs` | 30 min | Total run duration and flow-tool timeout |
| `maxNodeTimeoutMs` | 10 min | Ceiling for node, HTTP, and code timeouts |
| `maxNestingDepth` | 5 | Subflow nesting |
| `maxLoopIterations` / `maxBatchItems` / `maxBatchConcurrency` | 1000 / 500 / 10 | Container ceilings (also enforced at run time) |
| `maxRegexInputChars` | 100000 | `matches` input cap |
| `code.timeoutMs` / `code.sandboxMode` | 30 s / `read-only` | Code node default timeout and sandbox mode |
| `http.timeoutMs` / `http.maxResponseBytes` / `http.maxRedirects` | 30 s / 2 MiB / 5 | HTTP node defaults |
| `http.allowPrivateNetwork` / `http.allowedHosts` | `false` / `[]` | SSRF policy exceptions; `*` in a host pattern matches within one DNS label |
| `agent.provider` | `spawn` | Subagent provider for `agent` nodes |
| `tools.prefix` | `flow_` | Flow tool name prefix |

## Security

- **HTTP.** Only `http`/`https`. Every hop resolves the host once, rejects non-unicast addresses (loopback, private, link-local, CGNAT, NAT64, 6to4, unspecified, …), and connects through an address-pinned agent, so DNS rebinding cannot swap the target. Cross-origin redirects drop `authorization`, `cookie`, and `proxy-authorization`; 303 (and 301/302 for non-GET) become GET. One deadline covers all hops and the body.
- **Code.** Runs in a separate `ptcRuntime` Node process under `code.sandboxMode`, rooted at the run's workspace.
- **Secrets.** Flow JSON is stored in plain text; do not put secrets in literal values. Recorded events are redacted, but the flow document is not.
- **Prompt injection.** LLM output that feeds tool arguments is part of the flow you design; put a `condition` or `question` before side-effecting tools.

## Storage

```
flows/<flowId>.json                 draft (revision checked on save)
flows/<flowId>.meta.json            publish metadata and tool settings
flows/<flowId>/versions/<n>.json    immutable published snapshots (+ <n>.meta.json)
runs/<flowId>/<runId>/summary.json  run summary
runs/<flowId>/<runId>/events.jsonl  persisted run events (no node.delta)
```

Unreadable drafts are listed as broken with the reason instead of being hidden. On restart, runs left `running`/`waiting` are marked `interrupted`.

## Known limitations

- A `question` wait lives in the Host process; a restart marks the run `interrupted`.
- Code nodes in `read-only` mode on Windows may hit a Win32 ACL error; grant the workspace directory full control with `icacls`.
- Registering `flow_<name>` tools changes the main Agent's tool list, which invalidates the prompt cache; `flow_workflow` alone does not.
- A guided flow is followed by a model, so its steps and results can differ between runs.
- LLM JSON output relies on prompt instructions plus one repair attempt; there is no native JSON-schema mode.
- LLM calls made by flow nodes are recorded in the run events, not in a DSH session log; `agent` and `tool` nodes are logged natively.
- Tool names are checked against global tools, the tools of the deployment's default Agent preset, and the tools visible to live root Agents (`catalog.tools` lists the same set); unknown names are warnings.

## DSH surface

| File | DSH APIs |
|---|---|
| `host/engine/engine.ts` | `ctx.llm.stream`, `ctx.tools.execute/schemas`, `ctx.get('ptcRuntime' / 'subagents' / 'userQuestions')`, `ctx.workspaceRegistry.get`, `ctx.agentDefaultModel.currentSelection`, `ctx.sandboxPolicy.resolve` |
| `host/executors/llm.ts`, `intent.ts` | `BlockAssembler`, `ReasoningEffortId` |
| `host/executors/code.ts` | `ptcRuntime.resolve/run` |
| `host/executors/agent.ts` | `subagents.start`, `SubagentRun.dispose` |
| `host/services/run-agent.ts`, `session-launch.ts` | `agents.create`, `agentPresets.resolve/acquireScope/mount`, `workspaceRegistry.create/archiveSession`, `permissionPresets`, `sessionTitle.rename` |
| `host/flow-tools.ts`, `workflow-tool.ts` | `defineTool`, `ctx.tools.register/get` |
| `host/routes/*` | `ctx.connection.fetch.register`, `ctx.llm.listProviders/listModels`, `ctx.workspaceRegistry.list` |
| `host/known-tools.ts` | `ctx.tools.schemas(scope?)`, `ctx.agents.roots`, `agentPresets.acquireScope` |
