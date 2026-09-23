import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeHandoff } from '../src/session-handoff/handoff.ts'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ts-handoff-'))
}

describe('writeHandoff', () => {
  it('writes a timestamped file with the session id', () => {
    const dir = tmpDir()
    const file = writeHandoff(dir, '.dsh/handoffs', 'sess-123', 'summary body')
    expect(fs.existsSync(file)).toBe(true)
    expect(path.basename(file)).toMatch(/^\d{8}-\d{6}-sess-123\.md$/)
    const content = fs.readFileSync(file, 'utf8')
    expect(content).toContain('sess-123')
    expect(content).toContain('summary body')
  })

  it('rejects a handoff dir escaping cwd', () => {
    const dir = tmpDir()
    expect(() => writeHandoff(dir, '../escape', 's', 'x')).toThrow(/escapes/)
  })
})
