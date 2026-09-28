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
  fs.renameSync(tmp, filePath)
}

/** A per-file write lock so concurrent writes to one file do not interleave. */
export class FileLock {
  private chain: Promise<unknown> = Promise.resolve()
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }
}
