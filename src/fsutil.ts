/**
 * Shared file primitives for the data dir: a cross-process directory lock and
 * atomic whole-file writes. settings.json and updates.json are shared by every
 * OpenCode server (one per project location), so both need the same guarantees
 * from one implementation.
 */
import { mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

// A lock is only ever held across synchronous file reads/writes (milliseconds),
// so a lock older than STALE_MS was abandoned by a crashed process. Waiters
// must keep retrying for LONGER than that: giving up sooner means failing on a
// lock they would have been allowed to clear a moment later.
const STALE_MS = 5_000
const RETRY_MS = 20
const RETRY_BUDGET_MS = 6_000

/** Run `fn` while holding the mkdir lock at `lockPath`; `label` names the resource in the timeout error. */
export async function withDirLock<T>(lockPath: string, label: string, fn: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + RETRY_BUDGET_MS
  for (;;) {
    try {
      mkdirSync(lockPath)
      break
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) rmSync(lockPath, { recursive: true, force: true })
      } catch {
        // lock disappeared between checks
      }
      if (Date.now() >= deadline) throw new Error(`${label} is locked`)
      await Bun.sleep(RETRY_MS)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lockPath, { recursive: true, force: true })
  }
}

/** Write a whole file via temp sibling + rename: readers never see a torn file, and a failed write leaves no stray temp. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing was written
    }
    throw error
  }
}
