/**
 * Per-agent tool-gate reconcile. Given a group-resolution function, compute the
 * deny set for one Agent and apply it via `agent.ctx.tools.restrict`. Kept as a
 * pure-ish function over a small environment so it can be unit tested with fake
 * tools that record calls and synchronously trigger change callbacks.
 *
 * @module @dsh-plugins/token-saver/tool-gate/reconcile
 */

/** The tools surface a reconcile uses; a fake in tests. */
export interface ReconcileEnv {
  /** Return the tool names currently visible to the Agent. */
  schemas(): readonly { name: string }[]
  /** Apply a deny restriction for the Agent; returns the disposer. */
  restrict(deny: readonly string[]): () => void
}

/** Live state for one Agent. */
export interface ReconcileEntry {
  /** Enabled group names for this Agent. */
  enabled: Set<string>
  /** The deny set currently applied, or `[]` when none. */
  hidden: string[]
  /** The disposer of the current restriction. */
  dispose?: (() => void) | undefined
}

/** Tool names that must never be gated away. */
export const RESERVED_TOOLS = new Set(['tool_gate', 'run_code'])

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every(name => set.has(name))
}

/**
 * Reconcile one Agent's restriction to match the current enabled set. The
 * reentrancy guard (if `tools/change` fires synchronously during a
 * restrict/dispose) is the caller's responsibility.
 * @param env - the Agent's tools surface.
 * @param entry - the Agent's live entry.
 * @param isDisabled - whether a tool name belongs to a disabled group.
 */
export function reconcile(env: ReconcileEnv, entry: ReconcileEntry, isDisabled: (name: string) => boolean): void {
  // The universe is everything visible plus everything already hidden (hidden
  // names are absent from `schemas` but must remain in the deny set until a
  // change removes them).
  const universe = new Set<string>(env.schemas().map(schema => schema.name))
  for (const name of entry.hidden) universe.add(name)
  const deny = [...universe].filter(name => !RESERVED_TOOLS.has(name) && isDisabled(name))
  if (sameSet(deny, entry.hidden)) return

  entry.dispose?.()
  entry.dispose = undefined
  // Re-read after disposal: names may have been unregistered, and `restrict`
  // throws for names it does not know.
  const live = env.schemas().map(schema => schema.name)
  const newDeny = live.filter(name => !RESERVED_TOOLS.has(name) && isDisabled(name))
  if (newDeny.length > 0) entry.dispose = env.restrict(newDeny)
  entry.hidden = newDeny
}
