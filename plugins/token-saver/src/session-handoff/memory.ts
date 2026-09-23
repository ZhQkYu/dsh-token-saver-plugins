/**
 * Memory-file helpers for session-handoff: read the project memory file with a
 * byte cap, and atomically rewrite it. All paths resolve inside the session cwd
 * and are validated to not escape it.
 *
 * @module @dsh-plugins/token-saver/session-handoff/memory
 */

import fs from 'node:fs'
import path from 'node:path'

/** A minimal logger contract so this module stays testable. */
export interface MemoryLogger {
  warn(message: string): void
}

/** Resolve a relative path inside a cwd, rejecting escapes. */
export function resolveWithin(cwd: string, relative: string): string {
  if (path.isAbsolute(relative)) {
    throw new Error(`expected a relative path, got absolute ${JSON.stringify(relative)}`)
  }
  const resolved = path.resolve(cwd, relative)
  const rel = path.relative(cwd, resolved)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path ${JSON.stringify(relative)} escapes cwd`)
  }
  return resolved
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read at most `maxBytes` bytes, cutting on a UTF-8 boundary. */
function readTruncated(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0)
    let text = buf.subarray(0, bytesRead).toString('utf8')
    // A multibyte sequence cut at the boundary yields a trailing U+FFFD; drop it.
    text = text.replace(/\uFFFD+$/, '')
    return `${text}\n\n[memory truncated at ${maxBytes} bytes]`
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Read the memory file for a session cwd, returning `''` when the file is
 * absent. Content longer than `maxBytes` is truncated on a UTF-8 boundary with
 * a note appended.
 * @param cwd - the session cwd.
 * @param memoryFile - the relative memory file path.
 * @param maxBytes - the byte cap.
 * @param logger - a logger for non-ENOENT read failures.
 * @returns the memory text (possibly truncated), or `''`.
 */
export function readMemory(cwd: string, memoryFile: string, maxBytes: number, logger: MemoryLogger): string {
  let filePath: string
  try {
    filePath = resolveWithin(cwd, memoryFile)
  } catch (error: unknown) {
    logger.warn(`token-saver: memory path rejected: ${errorMessage(error)}`)
    return ''
  }
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return ''
    if (stat.size > maxBytes) return readTruncated(filePath, maxBytes)
    return fs.readFileSync(filePath, 'utf8')
  } catch (error: unknown) {
    if (isEnoent(error)) return ''
    logger.warn(`token-saver: read memory failed: ${errorMessage(error)}`)
    return ''
  }
}

/**
 * Atomically rewrite the memory file (write temp then rename).
 * @param cwd - the session cwd.
 * @param memoryFile - the relative memory file path.
 * @param content - the new content.
 */
export function writeMemory(cwd: string, memoryFile: string, content: string): void {
  const filePath = resolveWithin(cwd, memoryFile)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, filePath)
}
