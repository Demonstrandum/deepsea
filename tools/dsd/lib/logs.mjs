/**
 * Per-run log files (LAYOUT.md §5): `<dir>/<ts>-<pid>.log`, a `latest.log`
 * link, the identity on the first line, and pruning at start.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileStamp, isoLocal } from './util.mjs'

/**
 * Open a new run log in `dir` (created 0700). The file is named once the pid
 * is known: call `name(pid)`, then `identify(line)` to write the first line.
 */
export function openRunLog(dir, { keep = 20, days = 14 } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  prune(dir, keep, days)
  const stamp = fileStamp()
  let path = join(dir, `${stamp}-pending.log`)
  const fd = openSync(path, 'a', 0o600)
  return {
    fd,
    get path() { return path },
    /** Rename to `<ts>-<pid>.log` and point `latest.log` at it. */
    name(pid) {
      const named = join(dir, `${stamp}-${pid}.log`)
      renameSync(path, named)
      path = named
      const latest = join(dir, 'latest.log')
      try { unlinkSync(latest) } catch { /* none yet */ }
      symlinkSync(basename(named), latest)
    },
    /** Write the identity line: ISO time with offset, then the facts given. */
    identify(facts) {
      writeSync(fd, `${isoLocal()} ${facts}\n`)
    },
    close() { closeSync(fd) },
  }
}

/** Keep the newest `keep` run logs and anything younger than `days`. */
export function prune(dir, keep, days) {
  if (!existsSync(dir)) return
  const cutoff = Date.now() - days * 86_400_000
  const runs = readdirSync(dir).filter(f => /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-[\w-]+\.(log|jsonl)$/.test(f)).sort().reverse()
  for (const file of runs.slice(keep)) {
    const path = join(dir, file)
    if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
  }
}
