# @dsh-plugins/flow

A Coze-style **deterministic workflow engine** for DeepSeek Harness. A flow is a typed graph of nodes: `start` → nodes → `end`. Nodes exchange **typed variables** through named input bindings; the engine (not a model) controls the flow, so branches, loops, subflows, and parallel batch nodes are deterministic.

## Status

The data model, validation, storage, Host routes, execution engine, executors, and flow-as-tool registration are implemented. A browser editor lives in `@dsh-plugins/flow-ui`.

## Node types

`start`, `end`, `llm`, `intent`, `agent`, `condition`, `code`, `http`, `tool`, `text`, `json`, `aggregate`, `loop`, `batch`, `break`, `continue`, `assign`, `subflow`, `question`, `message`, `comment`.

- **Data**: `text` (concat/split), `json` (parse/stringify), `code` (TypeScript via `ptcRuntime`), `http` (guarded fetch).
- **Control**: `condition`, `aggregate`, `loop` (array/count/infinite), `batch`, `break`, `continue`, `assign`, `subflow`.
- **AI**: `llm`, `intent`, `agent` (child Agent).
- **Interaction**: `question` (canvas or session), `message`, `comment`.

## Installation

```bash
cd dsh-plugins
pnpm install
pnpm run build
```

Toggle `dsh-flow` on the Plugins page. Storage defaults to `~/.dsh/flow`.

## Workflows as tools

Publishing a flow with the "as tool" option registers a `flow_<name>` tool that runs the published snapshot with the caller's Agent, so approvals and PTC presentation flow through the caller. Dynamic registration is kept in sync on publish/unpublish/delete.

## Configuration

See `cordis.patch.yml`. Every deployment-varying tunable (limits, timeouts, sandbox mode, tool prefix, run-session preset) is a `Config` field.

## Known limitations

- Code nodes run in the Node sandbox (`ptcRuntime`); on Windows a `read-only` sandbox may hit a Win32 ACL error, requiring `icacls` on the workspace directory.
- Flow JSON is stored in plain text under `~/.dsh/flow`; do not put secrets in literal values.
- Dynamic flow-as-tool registration changes the model's system prompt (affects prompt cache).
- `question` waits are process-local only; after a Host restart a running/waiting run is marked `interrupted`.
- LLM structured output relies on prompt constraints plus a one-shot repair retry, not a native JSON schema mode.
