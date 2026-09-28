import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../src/spec/types.ts'
import { foldRunEvents } from '../src/spec/run-view.ts'

function event(seq: number, type: string, extra: Record<string, unknown>): RunEvent {
  return { seq, time: seq, type, ...extra } as unknown as RunEvent
}

describe('foldRunEvents', () => {
  it('folds node lifecycles by execKey', () => {
    const events = [
      event(1, 'run.started', { runId: 'run-1', flowId: 'flow-1', version: 'draft', inputs: {} }),
      event(2, 'node.started', { execKey: 'a', nodeId: 'a', path: [], attempt: 0, inputs: {} }),
      event(3, 'node.finished', { execKey: 'a', nodeId: 'a', path: [], attempt: 0, status: 'succeeded', outputs: { text: 'x' }, firedPorts: ['next'], usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 5 }),
      event(4, 'run.finished', { status: 'succeeded', outputs: { text: 'x' }, usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 10 }),
    ]
    const view = foldRunEvents(events)
    expect(view.status).toBe('succeeded')
    expect(view.nodes).toHaveLength(1)
    expect(view.nodes[0]?.status).toBe('succeeded')
    expect(view.nodes[0]?.outputs).toEqual({ text: 'x' })
  })

  it('keeps a node running when only node.started is present', () => {
    const events = [
      event(1, 'run.started', { runId: 'run-1', flowId: 'flow-1', version: 'draft', inputs: {} }),
      event(2, 'node.started', { execKey: 'a', nodeId: 'a', path: [], attempt: 0, inputs: {} }),
    ]
    const view = foldRunEvents(events)
    expect(view.nodes[0]?.status).toBe('running')
  })

  it('records waiting and resumed transitions', () => {
    const events = [
      event(1, 'run.started', { runId: 'run-1', flowId: 'flow-1', version: 'draft', inputs: {} }),
      event(2, 'run.waiting', { execKey: 'a', question: 'q', answer: { kind: 'text' } }),
      event(3, 'run.resumed', { execKey: 'a' }),
    ]
    const view = foldRunEvents(events)
    expect(view.status).toBe('running')
  })

  it('collects messages', () => {
    const events = [
      event(1, 'run.started', { runId: 'run-1', flowId: 'flow-1', version: 'draft', inputs: {} }),
      event(2, 'run.message', { execKey: 'a', text: 'hi' }),
    ]
    const view = foldRunEvents(events)
    expect(view.messages).toEqual([{ execKey: 'a', text: 'hi' }])
  })
})
