/**
 * Per-agent tool-gate reconcile: compute one Agent's deny set and apply it via
 * `agent.ctx.tools.restrict`. Kept over a small environment so it is unit
 * tested with fake tools that record calls.
 *
 * @module @dsh-plugins/token-saver/tool-gate/reconcile
 */

/** The tools surface a reconcile uses; a fake in tests. */
export interface ReconcileEnv {
  /** Return the tool schemas currently visible to the Agent. */
  schemas(): readonly { name: string }[]
  /** Apply a deny restriction for the Agent; returns the disposer. Throws for names it cannot restrict. */
  restrict(deny: readonly string[]): () => void
}

/** Restriction state for one Agent. */
export interface ReconcileEntry {
  /** The names currently denied by this plugin. */
  hidden: string[]
  /** Names `restrict` rejected (the Agent's own registrations); never retried. */
  unrestrictable: Set<string>
  /** The disposer of the current restriction. */
  dispose?: (() => void) | undefined
}

/** Tool names that must never be gated away. */
export const RESERVED_TOOLS: ReadonlySet<string> = new Set(['tool_gate', 'run_code'])

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every(name => set.has(name))
}

/**
 * Every name this Agent can see or that the gate currently hides from it.
 * @param env - the Agent's tools surface.
 * @param entry - the Agent's restriction state, when tracked.
 * @returns the pre-gate tool-name universe.
 */
export function universeOf(env: Pick<ReconcileEnv, 'schemas'>, entry: ReconcileEntry | undefined): Set<string> {
  const universe = new Set<string>(env.schemas().map(schema => schema.name))
  if (entry !== undefined) for (const name of entry.hidden) universe.add(name)
  return universe
}

/**
 * Reconcile one Agent's restriction with the current group state. The caller
 * guards reentrancy, because `restrict` and its disposer emit `tools/change`
 * synchronously.
 * @param env - the Agent's tools surface.
 * @param entry - the Agent's restriction state, updated in place.
 * @param isDisabled - whether a tool name belongs only to disabled groups.
 * @param onReject - called once per name `restrict` refused.
 * @returns whether the applied restriction changed.
 */
export function reconcile(
  env: ReconcileEnv,
  entry: ReconcileEntry,
  isDisabled: (name: string) => boolean,
  onReject: (name: string, error: unknown) => void,
): boolean {
  const wanted = (names: Iterable<string>): string[] =>
    [...names].filter(name => !RESERVED_TOOLS.has(name) && !entry.unrestrictable.has(name) && isDisabled(name))
  if (sameSet(wanted(universeOf(env, entry)), entry.hidden)) return false

  entry.dispose?.()
  entry.dispose = undefined
  entry.hidden = []
  // Re-read after disposal: a hidden name may have been unregistered, and `restrict` rejects unknown names.
  const deny = wanted(env.schemas().map(schema => schema.name))
  if (deny.length === 0) return true
  let batch: (() => void) | undefined
  try {
    batch = env.restrict(deny)
  } catch (batchError: unknown) {
    // One refused name fails the whole batch; restrict per name below to keep the restrictable ones.
  }
  if (batch !== undefined) {
    entry.dispose = batch
    entry.hidden = deny
    return true
  }
  const disposers: (() => void)[] = []
  for (const name of deny) {
    try {
      disposers.push(env.restrict([name]))
      entry.hidden.push(name)
    } catch (error: unknown) {
      entry.unrestrictable.add(name)
      onReject(name, error)
    }
  }
  if (disposers.length > 0) entry.dispose = () => { for (const dispose of disposers) dispose() }
  return true
}
