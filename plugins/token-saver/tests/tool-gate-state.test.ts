import { describe, expect, it } from 'vitest'
import { foldToolGate, toolGateInit, type ToolGateState } from '../src/tool-gate/state.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function event(type: string, data: unknown): SessionEvent {
  return { type, seq: 1, time: 1, data } as unknown as SessionEvent
}

describe('foldToolGate', () => {
  it('starts with null enabled and no calls', () => {
    expect(toolGateInit()).toEqual({ enabled: null, calls: {} })
  })

  it('records a tool_gate call', () => {
    const state = toolGateInit()
    const next = foldToolGate(state, event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'tool_gate', arguments: '{}' }))
    expect(next.calls['c1']).toBe(true)
  })

  it('folds an enabled meta from a successful result', () => {
    let state = toolGateInit()
    state = foldToolGate(state, event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'tool_gate', arguments: '{}' }))
    const next = foldToolGate(state, event('tool/result', {
      turn: 1, step: 1,
      message: { toolCallId: 'c1', isError: false, content: [], role: 'tool' },
      meta: { enabled: ['a', 'b'] },
    }))
    expect(next.enabled).toEqual(['a', 'b'])
    expect(next.calls['c1']).toBeUndefined()
  })

  it('does not fold on an error result', () => {
    let state = toolGateInit()
    state = foldToolGate(state, event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'tool_gate', arguments: '{}' }))
    const next = foldToolGate(state, event('tool/result', {
      turn: 1, step: 1,
      message: { toolCallId: 'c1', isError: true, content: [], role: 'tool' },
      meta: { enabled: ['a'] },
    }))
    expect(next).toBe(state)
  })

  it('folds a user/message notice', () => {
    const state = toolGateInit()
    const next = foldToolGate(state, event('user/message', {
      source: { kind: 'token-saver', feature: 'tool-gate', form: 'notice', summary: 'x', enabled: ['a'] },
      content: [], id: 'm1', role: 'user',
    }))
    expect(next.enabled).toEqual(['a'])
  })

  it('returns the same reference for unrelated events', () => {
    const state = toolGateInit()
    expect(foldToolGate(state, event('assistant/message', { turn: 1, step: 1, content: [], usage: undefined }))).toBe(state)
  })
})
