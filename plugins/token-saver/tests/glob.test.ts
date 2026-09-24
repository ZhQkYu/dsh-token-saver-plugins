import { describe, expect, it } from 'vitest'
import { matchesGlob, mcpServerOf } from '../src/shared/glob.ts'

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

  it('honours every wildcard in a pattern', () => {
    expect(matchesGlob('mcp__*__read*', 'mcp__fs__read_file')).toBe(true)
    expect(matchesGlob('mcp__*__read*', 'mcp__fs__write_file')).toBe(false)
    expect(matchesGlob('*a*', 'bab')).toBe(true)
    expect(matchesGlob('*a*a*', 'aa')).toBe(true)
    expect(matchesGlob('*a*a*', 'a')).toBe(false)
    expect(matchesGlob('ab*ba', 'aba')).toBe(false)
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
