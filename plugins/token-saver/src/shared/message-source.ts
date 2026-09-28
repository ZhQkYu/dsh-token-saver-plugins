/**
 * The `token-saver` message source, declared once and used by every plugin that
 * injects or follow-ups a user-role message. Declaration merging extends the
 * merge-extensible {@link MessageSourceMap}; persistence does not validate
 * source kinds, and consumers fall through unknown kinds, so this is the safe
 * channel for plugin-originated context.
 *
 * @module @dsh-plugins/token-saver/shared/message-source
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** The token-saver features that inject a message. */
export type TokenSaverFeature = 'handoff' | 'handoff-suggest' | 'tool-gate'

/** Attribution for a message originated by a token-saver plugin. */
export interface TokenSaverMessageSource {
  readonly kind: 'token-saver'
  readonly feature: TokenSaverFeature
  readonly form: 'notice'
  readonly summary: string
  /** Originating session, for handoff messages. */
  readonly fromSession?: SessionId
  /** Absolute enabled group set, for tool-gate messages. */
  readonly enabled?: readonly string[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'token-saver': TokenSaverMessageSource
  }
}

/**
 * Build a token-saver message source with a bounded one-line summary.
 * @param feature - the feature that produced the message.
 * @param summary - the model-facing one-line account.
 * @param extra - optional feature-specific fields.
 * @returns the source value to pass to `createUserMessage`.
 */
export function tokenSaverSource(feature: TokenSaverFeature, summary: string, extra: Omit<Partial<TokenSaverMessageSource>, 'kind' | 'feature' | 'form' | 'summary'> = {}): TokenSaverMessageSource {
  return { kind: 'token-saver', feature, form: 'notice', summary, ...extra }
}
