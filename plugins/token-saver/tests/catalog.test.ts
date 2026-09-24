import { describe, expect, it } from 'vitest'
import { firstSentence } from '../src/workflow-canvas/catalog.ts'

describe('firstSentence', () => {
  it('keeps the first English or Chinese sentence', () => {
    expect(firstSentence('Search the web. Returns ranked results.')).toBe('Search the web.')
    expect(firstSentence('搜索网页。返回排序后的结果。')).toBe('搜索网页。')
  })

  it('does not split on dots inside names', () => {
    expect(firstSentence('Read package.json files\nfrom disk. Extra.')).toBe('Read package.json files from disk.')
  })

  it('truncates long sentences', () => {
    const result = firstSentence('x'.repeat(400))
    expect(result).toHaveLength(160)
    expect(result.endsWith('…')).toBe(true)
  })
})
