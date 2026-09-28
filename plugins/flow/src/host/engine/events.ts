/**
 * EventHub: live per-run event subscribers. `run.events` subscribes here and
 * reads an NDJSON stream; the engine emits into it.
 *
 * @module @dsh-plugins/flow/host/engine/events
 */

import type { RunEvent } from '../../spec/types.ts'

/** A live event fan-out keyed by run id. */
export class EventHub {
  private readonly subscribers = new Map<string, Set<(event: RunEvent) => void>>()

  /** Subscribe to a run's live events; returns an unsubscribe function. */
  subscribe(runId: string, callback: (event: RunEvent) => void): () => void {
    let set = this.subscribers.get(runId)
    if (set === undefined) {
      set = new Set()
      this.subscribers.set(runId, set)
    }
    set.add(callback)
    return () => {
      set.delete(callback)
      if (set.size === 0) this.subscribers.delete(runId)
    }
  }

  /** Emit an event to all live subscribers of a run. */
  emit(runId: string, event: RunEvent): void {
    const set = this.subscribers.get(runId)
    if (set === undefined) return
    for (const callback of [...set]) {
      try {
        callback(event)
      } catch {
        // A subscriber throwing must not break the run.
      }
    }
  }

  /** Whether a run has live subscribers. */
  has(runId: string): boolean {
    return (this.subscribers.get(runId)?.size ?? 0) > 0
  }
}
