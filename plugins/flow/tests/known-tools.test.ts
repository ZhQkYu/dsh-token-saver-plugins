import { describe, expect, it } from 'vitest'
import { knownToolSchemas } from '../src/host/known-tools.ts'

describe('knownToolSchemas', () => {
  it('adds tools visible only to live root Agents, once per name, sorted', () => {
    const agent = { id: 'a' }
    const schema = (name: string, description = name) => ({ name, description, parameters: {} })
    const ctx = {
      tools: { schemas: (scope?: unknown) => scope === agent ? [schema('read'), schema('global', 'scoped copy')] : [schema('global')] },
      agents: { roots: () => [agent] },
    }
    expect(knownToolSchemas(ctx as never).map(tool => [tool.name, tool.description])).toEqual([['global', 'global'], ['read', 'read']])
  })
})
