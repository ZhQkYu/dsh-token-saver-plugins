import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@dsh-plugins/flow/spec'
import { followRun, readNdjson } from '../src/client/run/run-stream.ts'

function body(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

const event = (seq: number, type: RunEvent['type'] = 'node.started'): string => `${JSON.stringify(type === 'run.finished'
  ? { seq, time: 0, type, status: 'succeeded', usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 }
  : { seq, time: 0, type, execKey: 'a', nodeId: 'a', path: [], attempt: 0, inputs: {} })}\n`

describe('run stream', () => {
  it('splits NDJSON lines across chunk boundaries', async () => {
    const lines: unknown[] = []
    const whole = event(1) + event(2)
    await readNdjson(body([whole.slice(0, 7), whole.slice(7, 40), whole.slice(40)]), value => { lines.push(value) })
    expect(lines).toHaveLength(2)
  })

  it('reconnects with the last seq and delivers each event once', async () => {
    const requested: string[] = []
    const responses = [body([event(1), event(2)]), body([event(2), event(3), event(4, 'run.finished')])]
    const fetchImpl: typeof fetch = async (input) => {
      requested.push(String(input))
      return new Response(responses.shift() ?? body([]))
    }
    const seen: number[] = []
    await followRun('run-1', e => { seen.push(e.seq) }, new AbortController().signal, { fetchImpl, pollMs: 1 })
    expect(seen).toEqual([1, 2, 3, 4])
    expect(requested[1]).toContain('after=2')
  })

  it('falls back to polling run.get after repeated stream failures', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes('run.events')) throw new Error('offline')
      return Response.json({ summary: { status: 'succeeded' }, events: [JSON.parse(event(1)), JSON.parse(event(2, 'run.finished'))] })
    }
    const seen: string[] = []
    await followRun('run-1', e => { seen.push(e.type) }, new AbortController().signal, { fetchImpl, maxStreamFailures: 1, pollMs: 1 })
    expect(seen).toEqual(['node.started', 'run.finished'])
  })
})
