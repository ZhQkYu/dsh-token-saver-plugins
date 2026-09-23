import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readMemory, writeMemory, resolveWithin } from '../src/session-handoff/memory.ts'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ts-memory-'))
}

describe('resolveWithin', () => {
  it('rejects an absolute path', () => {
    expect(() => resolveWithin('/tmp', '/etc/passwd')).toThrow(/relative/)
  })

  it('rejects a path escaping the cwd', () => {
    expect(() => resolveWithin('/tmp', '../secret')).toThrow(/escapes/)
  })

  it('accepts a nested relative path', () => {
    expect(resolveWithin('/tmp', '.dsh/memory.md')).toBe(path.resolve('/tmp', '.dsh', 'memory.md'))
  })
})

describe('readMemory', () => {
  it('returns empty for a missing file', () => {
    const dir = tmpDir()
    const logger = { warn: () => {} }
    expect(readMemory(dir, '.dsh/memory.md', 16384, logger)).toBe('')
  })

  it('reads file content', () => {
    const dir = tmpDir()
    writeMemory(dir, '.dsh/memory.md', 'hello')
    const logger = { warn: () => {} }
    expect(readMemory(dir, '.dsh/memory.md', 16384, logger)).toBe('hello')
  })

  it('truncates on a byte cap with a UTF-8 boundary', () => {
    const dir = tmpDir()
    const content = '你'.repeat(100) // 3 bytes each
    writeMemory(dir, '.dsh/memory.md', content)
    const logger = { warn: () => {} }
    const out = readMemory(dir, '.dsh/memory.md', 10, logger)
    expect(out).toContain('[memory truncated at 10 bytes]')
    expect(out.length).toBeLessThan(content.length + 100)
  })

  it('returns empty for a directory path', () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'subdir'))
    const logger = { warn: () => { throw new Error('should not log for a non-file path') } }
    expect(readMemory(dir, 'subdir', 100, logger)).toBe('')
  })
})
