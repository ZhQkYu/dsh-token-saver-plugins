import { describe, expect, it } from 'vitest'
import { matchesGlob, mcpServerOf, mcpToolName } from '../src/shared/glob.ts'

describe('matchesGlob', () => {
  it('matches an exact name without a wildcard', () => {
    expect(matchesGlob('web_fetch', 'web_fetch')).toBe(true)
    expect(matchesGlob('web_fetch', 'web_search')).toBe(false)
  })

  it('matches with a trailing wildcard', () => {
    expect(matchesGlob('mcp__github__*', 'mcp__github__list_repos')).toBe(true)
    expect(matchesGlob('mcp__github__*', 'mcp__other__list_repos')).toBe(false)
  })

  it('matches with a leading wildcard', () => {
    expect(matchesGlob('*_fetch', 'web_fetch')).toBe(true)
  })

  it('matches an interior wildcard', () => {
    expect(matchesGlob('web_*', 'web_fetch')).toBe(true)
  })

  it('treats an empty pattern as matching only an empty name', () => {
    expect(matchesGlob('', '')).toBe(true)
    expect(matchesGlob('', 'x')).toBe(false)
  })
})

describe('mcpServerOf', () => {
  it('parses the server segment', () => {
    expect(mcpServerOf('mcp__github__list_repos')).toBe('github')
    expect(mcpServerOf('mcp__a__b__c')).toBe('a')
  })

  it('returns undefined for non-MCP names', () => {
    expect(mcpServerOf('web_fetch')).toBeUndefined()
  })
})

describe('mcpToolName', () => {
  it('builds the mcp tool name', () => {
    expect(mcpToolName('github', 'list_repos')).toBe('mcp__github__list_repos')
  })
})
