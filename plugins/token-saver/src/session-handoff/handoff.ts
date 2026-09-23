/**
 * Handoff-file helpers: write the handoff summary into a timestamped Markdown
 * file under the session cwd's handoff directory, atomically.
 *
 * @module @dsh-plugins/token-saver/session-handoff/handoff
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveWithin } from './memory.ts'

/** Format a date as `YYYYMMDD-HHmmss` for the handoff filename. */
function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Write a handoff Markdown file under `<cwd>/<handoffDir>/`.
 * @param cwd - the old session's cwd.
 * @param handoffDir - the relative handoff directory.
 * @param sessionId - the old session id (used in the filename and header).
 * @param summary - the handoff document body.
 * @returns the absolute path of the written file.
 */
export function writeHandoff(cwd: string, handoffDir: string, sessionId: string, summary: string): string {
  const dirPath = resolveWithin(cwd, handoffDir)
  fs.mkdirSync(dirPath, { recursive: true })
  const stamp = timestamp(new Date())
  const filePath = path.join(dirPath, `${stamp}-${sessionId}.md`)
  const content = `# Session handoff\n\n- Source session: ${sessionId}\n- Created: ${stamp}\n\n${summary}\n`
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, filePath)
  return filePath
}
