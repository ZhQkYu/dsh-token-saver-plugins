/**
 * Follow a run's NDJSON event stream: split lines across chunk boundaries,
 * reconnect with `after=<last seq>` when the connection drops or goes silent
 * for two heartbeat intervals, and fall back to polling `run.get` after
 * repeated failures. Resolves once `run.finished` has been delivered.
 *
 * @module @dsh-plugins/flow-ui/client/run/run-stream
 */

import type { RunEvent } from '@dsh-plugins/flow/spec'
import { RUN_EVENTS_PING_MS } from '@dsh-plugins/flow/spec'

/** Consume an NDJSON body, invoking `onLine` per parsed line; `onData` fires for every chunk (heartbeat watchdog). */
export async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (value: unknown) => void, onData: () => void = () => {}): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    onData()
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length === 0) continue
      try {
        onLine(JSON.parse(line))
      } catch {
        // A malformed line is skipped; the next reconnect replays persisted events by seq.
      }
    }
  }
}

/** Options for {@link followRun}. */
export interface FollowOptions {
  /** Called when the connection drops and a reconnect is scheduled. */
  onReconnecting?: () => void
  /** Injected fetch, for tests. */
  fetchImpl?: typeof fetch
  /** Reconnect attempts before falling back to polling. */
  maxStreamFailures?: number
  /** Polling interval of the fallback. */
  pollMs?: number
}

/**
 * Follow a run until it finishes.
 * @param runId - the run to follow.
 * @param onEvent - receives every event once, in seq order.
 * @param signal - stops following.
 * @param options - reconnect behavior.
 */
export async function followRun(runId: string, onEvent: (event: RunEvent) => void, signal: AbortSignal, options: FollowOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxFailures = options.maxStreamFailures ?? 3
  let lastSeq = 0
  let finished = false
  const deliver = (event: RunEvent): void => {
    if (event.seq <= lastSeq) return
    lastSeq = event.seq
    onEvent(event)
    if (event.type === 'run.finished') finished = true
  }
  let failures = 0
  while (!finished && !signal.aborted && failures < maxFailures) {
    const attempt = new AbortController()
    const abortAttempt = (): void => { attempt.abort() }
    signal.addEventListener('abort', abortAttempt, { once: true })
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      if (watchdog !== undefined) clearTimeout(watchdog)
      watchdog = setTimeout(abortAttempt, RUN_EVENTS_PING_MS * 2)
    }
    try {
      arm()
      const response = await fetchImpl(`api/dsh-flow/run.events?runId=${encodeURIComponent(runId)}&after=${lastSeq}`, { signal: attempt.signal })
      if (response.status === 404) throw new Error('run not found')
      if (!response.ok || response.body === null) throw new Error(`stream failed with ${response.status}`)
      await readNdjson(response.body, (value) => {
        const event = value as RunEvent | { type: 'ping' }
        if (event.type !== 'ping') deliver(event)
      }, () => { arm(); failures = 0 })
      if (!finished) failures++
    } catch (error: unknown) {
      if (signal.aborted) return
      if (error instanceof Error && error.message === 'run not found') throw error
      failures++
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog)
      signal.removeEventListener('abort', abortAttempt)
    }
    if (!finished && !signal.aborted && failures < maxFailures) {
      options.onReconnecting?.()
      await sleep(Math.min(1000 * failures, 5000), signal)
    }
  }
  while (!finished && !signal.aborted) {
    try {
      const response = await fetchImpl(`api/dsh-flow/run.get?runId=${encodeURIComponent(runId)}`, { signal })
      if (response.ok) {
        const body = await response.json() as { summary: { status: string }; events: RunEvent[] }
        for (const event of body.events.sort((a, b) => a.seq - b.seq)) deliver(event)
        if (!finished && !['running', 'waiting'].includes(body.summary.status)) finished = true
      }
    } catch {
      // Keep polling until the run ends or the caller stops following.
    }
    if (!finished) await sleep(options.pollMs ?? 1000, signal)
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
