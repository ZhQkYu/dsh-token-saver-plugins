---
name: flow-debugging
description: How to debug a Flow workflow with flow_design — reading validation issues and run traces, running one node with sample inputs, and fixing common failures. Load when a save reports errors or a test run fails.
---

# Debugging Flow workflows

## Tools

- `flow_design validate|save` — issues as `severity CODE node=<id> field=<path>: message`. Fix every `error`; warnings are advisory.
- `flow_design debug_node { flowId, nodeId, inputs }` — runs one node alone. `inputs` is keyed by the node's binding names; references to upstream nodes are replaced by these values, and literal bindings keep their configured value unless overridden. If an input is missing, the error lists the node's inputs. Not available for `start`, `end`, `loop`, `batch`, `subflow`, `assign`, `break`, `continue`, `comment`.
- `flow_design test { flowId, inputs }` — runs the saved draft and returns every node's `in`, `out`, ports taken, and errors. Values are truncated.
- `flow_design run { runId }` — reads a past run, including runs the user started in the editor.
- `flow_design answer { runId, execKey, answer }` — when `test` stops at a `question` node it returns `status waiting` with the execKey and options; answer with `{"optionId": "..."}` or `{"text": "..."}` to continue. `flow_design cancel { runId }` stops a paused run. Never leave a test run paused.

## Method

1. Find the first failing node in the trace, not the last one.
2. Compare its `in` with what you expected. A `null` input means the upstream reference path is wrong or the upstream node did not succeed.
3. Reproduce with `debug_node` using the exact inputs from the trace, change one thing, and repeat until it passes.
4. `save` the fix, then `test` the whole flow again.

## Common issues

| Symptom | Cause and fix |
|---|---|
| `DANGLING_REF` / `NOT_ANCESTOR` | The reference points at a node that does not run earlier in this scope or an enclosing one. Reconnect edges or move the reference. |
| `TYPE_MISMATCH` | The binding schema disagrees with the source. Make them match, or use `any`. |
| `TEMPLATE_UNKNOWN_VAR` | The template uses a name that is not a binding of the same node. Add the binding. |
| `UNKNOWN_PORT` | The edge `sourceHandle` is not a port of the source. Use the ids from `reference` or the node's branch/intent/option ids. |
| `UNREACHABLE` / `END_UNREACHABLE` | Missing edges; every branch needs a path to `end`. |
| `TOOL_UNKNOWN` | The tool name is not in `catalog`. |
| `CROSS_SCOPE_EDGE` / `BAD_PARENT` | Loop/batch children must set `parentId`; only the `body` edge enters a container. |
| `END_NOT_REACHED` at run time | A condition or intent took a branch with no path to `end`, or a node failed with `onError: default` and its branch stopped. Check `took:` in the trace. |
| `llm` JSON mode fails | The prompt does not describe the fields clearly. List every field with its type and an example; keep `fields` small. |
| `code` fails | Read `logs`. Inputs are in `params`; return an object with every declared output. |
| `http` returns `status` 4xx/5xx | The request, not the flow, is wrong. Check URL, headers, and body in the trace `in`. |
| Loop hits `LOOP_LIMIT` | Raise `maxIterations`, or add a `break` under a condition. |
| A `question` node waits | `test` returns at the question; call `answer` for each branch you need to check, or `cancel`. |
| `HTTP_BLOCKED: no public addresses for <host>` | The host resolved only to private addresses (a local proxy with fake-IP DNS does this for every domain) or is on a private network. This is the machine's network setup, not the flow: tell the user the `http.allowedHosts` (or `http.allowPrivateNetwork`) plugin setting controls it and stop retrying. Do not replace the http node with shell or code workarounds. |
| TLS certificate errors | A proxy intercepts HTTPS. Report it to the user; the fix is outside the flow. |

When an external service is unreachable, keep the flow correct and test the downstream nodes with `debug_node` using realistic sample data. Do not add demo modes or sample-data switches to the flow unless the user asks, and delete any scratch flows you create for probing.
