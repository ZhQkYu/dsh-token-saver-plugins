/**
 * Fold a run event stream into a {@link RunView}. Shared by the Host `run.get`
 * route and the browser UI, so both render the same folded state from the same
 * event sequence.
 *
 * @module @dsh-plugins/flow/spec/run-view
 */

import type { RunEvent, RunStatus, RunView, RunViewNode, TokenUsageLite } from './types.ts'

/** Fold run events into a view. */
export function foldRunEvents(events: readonly RunEvent[]): RunView {
  const nodes = new Map<string, RunViewNode>()
  const messages: { execKey: string; text: string }[] = []
  let runId = ''
  let status: RunStatus = 'running'
  let outputs: RunView['outputs']
  let error: RunView['error']
  let usage: TokenUsageLite = { inputTokens: 0, outputTokens: 0 }
  let durationMs = 0

  for (const event of events) {
    switch (event.type) {
      case 'run.started':
        runId = event.runId
        break
      case 'node.started': {
        const existing = nodes.get(event.execKey)
        nodes.set(event.execKey, {
          execKey: event.execKey,
          nodeId: event.nodeId,
          path: event.path,
          attempt: event.attempt,
          status: 'running',
          ...(existing?.attempts === undefined ? {} : { attempts: existing.attempts }),
          ...(event.inputs === undefined ? {} : { inputs: event.inputs }),
        })
        break
      }
      case 'node.finished': {
        const existing = nodes.get(event.execKey)
        nodes.set(event.execKey, {
          execKey: event.execKey,
          nodeId: event.nodeId,
          path: event.path,
          attempt: event.attempt,
          attempts: (existing?.attempts ?? 0) + 1,
          status: event.status,
          ...(existing?.inputs === undefined ? {} : { inputs: existing.inputs }),
          ...(event.outputs === undefined ? {} : { outputs: event.outputs }),
          ...(event.firedPorts === undefined ? {} : { firedPorts: event.firedPorts }),
          ...(event.error === undefined ? {} : { error: event.error }),
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
          ...(event.logs === undefined ? {} : { logs: event.logs }),
          ...(event.warnings === undefined ? {} : { warnings: event.warnings }),
          ...(event.rendered === undefined ? {} : { rendered: event.rendered }),
        })
        break
      }
      case 'run.message':
        messages.push({ execKey: event.execKey, text: event.text })
        break
      case 'run.waiting':
        status = 'waiting'
        break
      case 'run.resumed':
        status = 'running'
        break
      case 'run.finished':
        status = event.status
        outputs = event.outputs
        error = event.error
        usage = event.usage
        durationMs = event.durationMs
        break
    }
  }

  return {
    runId,
    status,
    nodes: [...nodes.values()],
    ...(outputs === undefined ? {} : { outputs }),
    ...(error === undefined ? {} : { error }),
    usage,
    durationMs,
    messages,
  }
}
