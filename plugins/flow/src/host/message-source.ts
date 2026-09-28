/**
 * The `dsh-flow` message source, declared once and used by flow's run session
 * launch. Declaration merging extends the merge-extensible
 * {@link MessageSourceMap}; persistence does not validate source kinds, and
 * consumers fall through unknown kinds, so this is the safe channel for
 * plugin-originated context.
 *
 * @module @dsh-plugins/flow/host/message-source
 */

/** The flow feature that injects a message. */
export type FlowFeature = 'run'

/** Attribution for a message originated by the flow plugin. */
export interface FlowMessageSource {
  readonly kind: 'dsh-flow'
  readonly feature: FlowFeature
  readonly form: 'notice'
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-flow': FlowMessageSource
  }
}

/**
 * Build a flow message source with a bounded one-line summary.
 * @param feature - the feature that produced the message.
 * @param summary - the model-facing one-line account.
 * @returns the source value to pass to `createUserMessage`.
 */
export function flowSource(feature: FlowFeature, summary: string): FlowMessageSource {
  return { kind: 'dsh-flow', feature, form: 'notice', summary }
}
