import { describe, expect, it } from 'vitest'
import { ToolCatalog } from '../src/host/known-tools.ts'

describe('ToolCatalog', () => {
  it('combines global, preset-scoped, and live-Agent tools, once per name, sorted', async () => {
    const agent = { id: 'a' }
    const lease = { key: 'preset-scope', [Symbol.asyncDispose]: async () => {} }
    const schema = (name: string, description = name) => ({ name, description, parameters: {} })
    const ctx = {
      logger: { debug: () => {} },
      tools: {
        schemas: (scope?: unknown) => scope === agent ? [schema('live'), schema('global', 'scoped copy')] : scope === lease.key ? [schema('read')] : [schema('global')],
      },
      agents: { roots: () => [agent] },
      agentPresets: { acquireScope: async (preset?: string) => { expect(preset).toBe('standard'); return lease } },
    }
    const catalog = new ToolCatalog(ctx as never, 'standard')
    expect(catalog.schemas().map(tool => tool.name)).toEqual(['global', 'live'])
    await catalog.refresh()
    expect(catalog.schemas().map(tool => [tool.name, tool.description])).toEqual([['global', 'global'], ['live', 'live'], ['read', 'read']])
    expect(catalog.names()).toEqual(new Set(['global', 'live', 'read']))
  })

  it('keeps the previous list when the preset cannot be read', async () => {
    const ctx = {
      logger: { debug: () => {} },
      tools: { schemas: () => [] },
      agents: { roots: () => [] },
      agentPresets: { acquireScope: async () => { throw new Error('no preset') } },
    }
    const catalog = new ToolCatalog(ctx as never, undefined)
    await catalog.refresh()
    expect(catalog.schemas()).toEqual([])
  })
})
