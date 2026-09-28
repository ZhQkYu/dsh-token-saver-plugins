/**
 * Atomic file write (temp + rename) and a per-file write lock, so concurrent
 * writes to one file never interleave or leave a half-written file.
 *
 * @module @dsh-plugins/flow/host/store/atomic
 */

import fs from 'node:fs'

/** Atomically write a file (temp + rename). */
export function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, 'utf8')
  renameWithRetry(tmp, filePath)
}

/** Max rename retries on transient EPERM/EBUSY (e.g. a short-lived lock). */
export const RENAME_RETRY_COUNT = 5
/** Delay between rename retries. */
export const RENAME_RETRY_DELAY_MS = 20

/** Rename with a bounded retry for transient Windows EPERM/EBUSY errors. */
function renameWithRetry(from: string, to: string): void {
  let attempt = 0
  while (true) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error: unknown) {
      const code = (error as { code?: string }).code
      const transient = code === 'EPERM' || code === 'EBUSY'
      if (!transient || attempt >= RENAME_RETRY_COUNT) {
        try {
          fs.unlinkSync(from)
        } catch {
          // Best effort.
        }
        throw error
      }
      attempt++
      Atomics.wait(SLEEP_CELL, 0, 0, RENAME_RETRY_DELAY_MS)
    }
  }
}

/** A cell nobody notifies, so `Atomics.wait` on it is a plain synchronous sleep without spinning the CPU. */
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4))

/** A per-file write lock so concurrent writes to one file do not interleave. */
export class FileLock {
  private chain: Promise<unknown> = Promise.resolve()
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }
}
