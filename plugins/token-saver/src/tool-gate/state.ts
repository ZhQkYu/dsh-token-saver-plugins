/**
 * Pure replay fold of the tool-gate's durable state. The fold reads only known
 * session events (`tool/call`, `tool/result`, `user/message`) and is host-only
 * (no wire projection), so it never participates in model-facing views.
 *
 * @module @dsh-plugins/token-saver/tool-gate/state
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '../shared/message-source.ts'

/** Durable tool-gate state folded from the session log. */
export interface ToolGateState {
  /**
   * The absolute set of enabled group names, or `null` when the model has never
   * changed it (so deployment defaults apply).
   */
  enabled: string[] | null
  /** `tool_gate` call ids whose result has not yet been folded. */
  calls: Record<string, true>
}

/** Zod schema for the durable {@link ToolGateState}. */
export const toolGateStateSchema: ZodType<ToolGateState> = zod.object({
  enabled: zod.array(zod.string()).nullable(),
  calls: zod.record(zod.string(), zod.literal(true)),
})

/** Initial projection state: never changed, no in-flight calls. */
export function toolGateInit(): ToolGateState {
  return { enabled: null, calls: {} }
}

/**
 * Narrow an opaque tool-result `meta` to the absolute enabled-group set the
 * `tool_gate` tool attaches.
 * @param meta - the opaque tool/result meta payload.
 * @returns whether `meta` carries `{ enabled: string[] }`.
 */
function isEnabledMeta(meta: unknown): meta is { enabled: string[] } {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return false
  const enabled = (meta as Record<string, unknown>).enabled
  return Array.isArray(enabled) && enabled.every(value => typeof value === 'string')
}

/**
 * Fold one session event into the durable state. Returns the same reference for
 * events that do not change it, so projection replay can skip work.
 * @param state - the previous state.
 * @param event - the next session event.
 * @returns the updated state, or `state` when unchanged.
 */
export function foldToolGate(state: ToolGateState, event: SessionEvent): ToolGateState {
  if (event.type === 'tool/call') {
    if (event.data.name === 'tool_gate') {
      return { enabled: state.enabled, calls: { ...state.calls, [event.data.callId]: true } }
    }
    return state
  }
  if (event.type === 'tool/result') {
    const callId = event.data.message.toolCallId
    if (state.calls[callId] !== true) return state
    const calls = { ...state.calls }
    delete calls[callId]
    const meta = event.data.meta
    return { enabled: event.data.message.isError !== true && isEnabledMeta(meta) ? meta.enabled : state.enabled, calls }
  }
  if (event.type === 'user/message') {
    const source = event.data.source
    if (source.kind === 'token-saver' && source.feature === 'tool-gate' && Array.isArray(source.enabled)) {
      return { enabled: source.enabled, calls: state.calls }
    }
    return state
  }
  return state
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    tokenSaverToolGate: ToolGateState
  }
}
