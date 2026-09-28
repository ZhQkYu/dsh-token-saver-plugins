/**
 * Read an NDJSON run event stream, split on newlines across chunk boundaries,
 * and optionally resume from a last-seen seq with `after`. Falls back to polling
 * `run.get` when the stream cannot be established.
 *
 * @module @dsh-plugins/flow-ui/client/run/run-stream
 */

/** One raw event line from the run stream. */
export type RunStreamEvent = { seq: number; type: string; [key: string]: unknown }

/** Consume an NDJSON body, invoking `onEvent` per line. */
export async function readNdjson(body: ReadableStream<Uint8Array>, onEvent: (event: RunStreamEvent) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length === 0) continue
      try {
        onEvent(JSON.parse(line) as RunStreamEvent)
      } catch {
        // Ignore malformed lines (e.g. a partial ping).
      }
    }
  }
}

/** Open a run event stream, resuming after `afterSeq`. */
export async function openRunStream(runId: string, afterSeq: number, onEvent: (event: RunStreamEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(`api/dsh-flow/run.events?runId=${encodeURIComponent(runId)}&after=${afterSeq}`, { signal })
  if (!response.ok) throw new Error(`stream failed with ${response.status}`)
  if (response.body === null) throw new Error('stream has no body')
  await readNdjson(response.body, onEvent)
}
