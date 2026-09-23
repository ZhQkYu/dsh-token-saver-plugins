import { describe, expect, it } from 'vitest'
import { reconcile, type ReconcileEnv, type ReconcileEntry } from '../src/tool-gate/reconcile.ts'
import { resolveGroups, isToolDisabled, type GroupConfig } from '../src/tool-gate/groups.ts'

function makeEnv(initial: string[]): { env: ReconcileEnv; calls: { deny: string[] }[]; change: () => void } {
  const calls: { deny: string[] }[] = []
  let names = [...initial]
  let changeHandler: (() => void) | undefined
  const env: ReconcileEnv = {
    schemas: () => names.map(name => ({ name })),
    restrict: (deny) => {
      calls.push({ deny: [...deny] })
      return () => { /* no-op */ }
    },
  }
  return {
    env,
    calls,
    change: () => {
      names = [...initial]
      changeHandler?.()
    },
  }
}

const groups = resolveGroups(
  { groups: [{ name: 'web', description: 'web tools', tools: ['web_fetch'], enabledByDefault: false }], autoMcpGroups: false, mcpEnabledByDefault: false },
  new Set(),
)

describe('reconcile', () => {
  it('applies a deny for a disabled group', () => {
    const { env, calls } = makeEnv(['web_fetch', 'tool_gate'])
    const entry: ReconcileEntry = { enabled: new Set<string>(), hidden: [], dispose: undefined }
    reconcile(env, entry, (name) => isToolDisabled(name, entry.enabled, groups))
    expect(calls.length).toBe(1)
    expect(calls[0]!.deny).toEqual(['web_fetch'])
  })

  it('never restricts tool_gate or run_code', () => {
    const { env, calls } = makeEnv(['web_fetch', 'tool_gate', 'run_code'])
    const entry: ReconcileEntry = { enabled: new Set<string>(), hidden: [], dispose: undefined }
    reconcile(env, entry, (name) => isToolDisabled(name, entry.enabled, groups))
    expect(calls[0]!.deny).not.toContain('tool_gate')
    expect(calls[0]!.deny).not.toContain('run_code')
  })

  it('does not re-restrict when the deny set is unchanged', () => {
    const { env, calls } = makeEnv(['web_fetch', 'tool_gate'])
    const entry: ReconcileEntry = { enabled: new Set<string>(), hidden: [], dispose: undefined }
    reconcile(env, entry, (name) => isToolDisabled(name, entry.enabled, groups))
    const firstCalls = calls.length
    reconcile(env, entry, (name) => isToolDisabled(name, entry.enabled, groups))
    expect(calls.length).toBe(firstCalls)
  })

  it('removes a deny when a group is enabled', () => {
    const { env, calls } = makeEnv(['web_fetch', 'tool_gate'])
    const entry: ReconcileEntry = { enabled: new Set<string>(), hidden: [], dispose: undefined }
    reconcile(env, entry, (name) => isToolDisabled(name, entry.enabled, groups))
    expect(entry.hidden).toEqual(['web_fetch'])
    entry.enabled = new Set(['web'])
    reconcile(env, entry, (name) => isToolDisabled(name, entry.enabled, groups))
    expect(entry.hidden).toEqual([])
    // Removing a deny disposes the previous restriction; no new restrict is needed.
    expect(calls.length).toBe(1)
  })
})

describe('resolveGroups', () => {
  it('rejects a duplicate name', () => {
    const config = { groups: [{ name: 'a', description: 'x', tools: ['t'], enabledByDefault: true }, { name: 'a', description: 'y', tools: ['u'], enabledByDefault: false }], autoMcpGroups: false, mcpEnabledByDefault: false }
    expect(() => resolveGroups(config, new Set())).toThrow(/duplicated/)
  })

  it('rejects an empty tool list', () => {
    const config = { groups: [{ name: 'a', description: 'x', tools: [], enabledByDefault: true }], autoMcpGroups: false, mcpEnabledByDefault: false }
    expect(() => resolveGroups(config, new Set())).toThrow(/no tools/)
  })

  it('synthesizes MCP groups', () => {
    const config = { groups: [] as GroupConfig[], autoMcpGroups: true, mcpEnabledByDefault: false }
    const resolved = resolveGroups(config, new Set(['github']))
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.name).toBe('mcp-github')
    expect(resolved[0]!.patterns).toEqual(['mcp__github__*'])
  })
})
