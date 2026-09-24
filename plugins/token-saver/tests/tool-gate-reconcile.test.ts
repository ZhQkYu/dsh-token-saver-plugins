import { describe, expect, it } from 'vitest'
import { reconcile, universeOf, type ReconcileEnv, type ReconcileEntry } from '../src/tool-gate/reconcile.ts'
import { resolveGroups, isToolDisabled, type GroupConfig } from '../src/tool-gate/groups.ts'
import { mcpServerOf } from '../src/shared/glob.ts'

/** A fake tools surface whose `schemas` omits denied names, like the real registry. */
function makeEnv(initial: string[], refuse: ReadonlySet<string> = new Set()): { env: ReconcileEnv; calls: string[][]; names: string[] } {
  const calls: string[][] = []
  const names = [...initial]
  const denied = new Map<number, readonly string[]>()
  let next = 0
  const env: ReconcileEnv = {
    schemas: () => {
      const hidden = new Set([...denied.values()].flat())
      return names.filter(name => !hidden.has(name)).map(name => ({ name }))
    },
    restrict: (deny) => {
      const refused = deny.find(name => refuse.has(name) || !names.includes(name))
      if (refused !== undefined) throw new Error(`unknown global tool "${refused}"`)
      calls.push([...deny])
      const id = next++
      denied.set(id, [...deny])
      return () => { denied.delete(id) }
    },
  }
  return { env, calls, names }
}

function entry(): ReconcileEntry {
  return { hidden: [], unrestrictable: new Set() }
}

const webGroups = resolveGroups(
  { groups: [{ name: 'web', description: 'web tools', tools: ['web_fetch'], enabledByDefault: false }], autoMcpGroups: false, mcpEnabledByDefault: false },
  new Map(),
)

const noReject = (): void => { throw new Error('unexpected rejection') }

describe('reconcile', () => {
  it('applies a deny for a disabled group', () => {
    const { env, calls } = makeEnv(['web_fetch', 'tool_gate'])
    const state = entry()
    expect(reconcile(env, state, name => isToolDisabled(name, new Set(), webGroups), noReject)).toBe(true)
    expect(calls).toEqual([['web_fetch']])
    expect(state.hidden).toEqual(['web_fetch'])
  })

  it('never restricts tool_gate or run_code', () => {
    const { env, calls } = makeEnv(['web_fetch', 'tool_gate', 'run_code'])
    reconcile(env, entry(), () => true, noReject)
    expect(calls).toEqual([['web_fetch']])
  })

  it('does not re-restrict when the deny set is unchanged, even though hidden names left schemas', () => {
    const { env, calls } = makeEnv(['web_fetch', 'tool_gate'])
    const state = entry()
    const disabled = (name: string): boolean => isToolDisabled(name, new Set(), webGroups)
    reconcile(env, state, disabled, noReject)
    expect(reconcile(env, state, disabled, noReject)).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('lifts the deny when the group is enabled', () => {
    const { env, calls } = makeEnv(['web_fetch', 'tool_gate'])
    const state = entry()
    reconcile(env, state, name => isToolDisabled(name, new Set(), webGroups), noReject)
    reconcile(env, state, name => isToolDisabled(name, new Set(['web']), webGroups), noReject)
    expect(state.hidden).toEqual([])
    expect(state.dispose).toBeUndefined()
    expect(env.schemas().map(schema => schema.name)).toContain('web_fetch')
    expect(calls).toHaveLength(1)
  })

  it('drops a hidden name that was unregistered instead of failing', () => {
    const { env, names } = makeEnv(['a', 'b'])
    const state = entry()
    reconcile(env, state, () => true, noReject)
    names.splice(names.indexOf('a'), 1)
    reconcile(env, state, name => name === 'b' || name === 'c', noReject)
    expect(state.hidden).toEqual(['b'])
  })

  it('falls back to per-name restriction and never retries a refused name', () => {
    const { env, calls } = makeEnv(['own_tool', 'web_fetch'], new Set(['own_tool']))
    const state = entry()
    const rejected: string[] = []
    reconcile(env, state, () => true, name => { rejected.push(name) })
    expect(rejected).toEqual(['own_tool'])
    expect(state.hidden).toEqual(['web_fetch'])
    expect(state.unrestrictable.has('own_tool')).toBe(true)
    reconcile(env, state, () => true, name => { rejected.push(name) })
    expect(rejected).toEqual(['own_tool'])
    expect(calls).toEqual([['web_fetch']])
  })
})

describe('MCP rediscovery', () => {
  const config = { groups: [] as GroupConfig[], autoMcpGroups: true, mcpEnabledByDefault: false }

  function discover(names: Iterable<string>): Map<string, Set<string>> {
    const servers = new Map<string, Set<string>>()
    for (const name of names) {
      const server = mcpServerOf(name)
      if (server === undefined) continue
      servers.set(server, new Set([...(servers.get(server) ?? []), name]))
    }
    return servers
  }

  it('keeps a gated server group once its tools are hidden', () => {
    const { env, calls } = makeEnv(['mcp__github__list', 'mcp__github__get', 'read'])
    const state = entry()
    let groups = resolveGroups(config, discover(universeOf(env, state)))
    reconcile(env, state, name => isToolDisabled(name, new Set(), groups), noReject)
    expect(env.schemas().map(schema => schema.name)).toEqual(['read'])

    groups = resolveGroups(config, discover(universeOf(env, state)))
    expect(groups.map(group => group.name)).toEqual(['mcp-github'])
    expect(reconcile(env, state, name => isToolDisabled(name, new Set(), groups), noReject)).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe('resolveGroups', () => {
  it('rejects a duplicate name', () => {
    const config = { groups: [{ name: 'a', description: 'x', tools: ['t'], enabledByDefault: true }, { name: 'a', description: 'y', tools: ['u'], enabledByDefault: false }], autoMcpGroups: false, mcpEnabledByDefault: false }
    expect(() => resolveGroups(config, new Map())).toThrow(/duplicated/)
  })

  it('rejects an empty tool list', () => {
    const config = { groups: [{ name: 'a', description: 'x', tools: [], enabledByDefault: true }], autoMcpGroups: false, mcpEnabledByDefault: false }
    expect(() => resolveGroups(config, new Map())).toThrow(/no tools/)
  })

  it('synthesizes MCP groups', () => {
    const config = { groups: [] as GroupConfig[], autoMcpGroups: true, mcpEnabledByDefault: false }
    const resolved = resolveGroups(config, new Map([['github', new Set(['mcp__github__list'])]]))
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.name).toBe('mcp-github')
    expect(resolved[0]!.patterns).toEqual(['mcp__github__*'])
  })

  it('skips a server an explicit group covers or whose name it owns, without throwing', () => {
    const config = {
      groups: [
        { name: 'code-host', description: 'GitHub', tools: ['mcp__github__*'], enabledByDefault: true },
        { name: 'mcp-fs', description: 'explicit fs', tools: ['read'], enabledByDefault: true },
      ],
      autoMcpGroups: true,
      mcpEnabledByDefault: false,
    }
    const servers = new Map([['github', new Set(['mcp__github__list'])], ['fs', new Set(['mcp__fs__read'])], ['web', new Set(['mcp__web__get'])]])
    expect(resolveGroups(config, servers).map(group => group.name)).toEqual(['code-host', 'mcp-fs', 'mcp-web'])
  })
})
