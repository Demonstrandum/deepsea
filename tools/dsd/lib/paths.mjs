/**
 * Where DeepSea keeps things (LAYOUT.md §1-§6). Every path is derived here.
 */
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The checkout this copy of dsd belongs to. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * The repository's main checkout: REPO itself, or for a worktree the checkout
 * its git directory belongs to. Paths in harness.lock and the worktree
 * directory are relative to it, so every worktree resolves them the same way.
 */
export function mainCheckout() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return common.endsWith('/.git') ? dirname(common) : REPO
  } catch {
    return REPO
  }
}

/** Reverse-DNS root; a variant's name appends `.<id>`. Machine-wide things use the bare root. */
export const ROOT_NAME = 'io.github.taliesinb.deepsea'

/** `~/.deepsea`, or `DEEPSEA_ROOT` (tests, sandboxes). */
export function deepseaRoot() {
  return resolve(process.env.DEEPSEA_ROOT ?? join(homedir(), '.deepsea'))
}

/** Shared immutable builds. */
export function buildsDir() {
  return join(deepseaRoot(), '_builds')
}

/** A variant's home. */
export function homeOf(id) {
  return join(deepseaRoot(), id)
}

/** A variant's name: its app's bundle id and the prefix of everything it owns. */
export function variantName(id) {
  return `${ROOT_NAME}.${id}`
}

/** Parent of the per-variant log directories (LAYOUT.md §5). */
export function logRoot() {
  if (process.env.DEEPSEA_LOG_ROOT) return resolve(process.env.DEEPSEA_LOG_ROOT)
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs')
  return resolve(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'))
}

/** A variant's log directory. */
export function logDirOf(id) {
  return join(logRoot(), variantName(id))
}

/** Machine-wide logs (installers, builds). */
export function machineLogDir() {
  return join(logRoot(), ROOT_NAME)
}

/** The worktree directory: `<main checkout>-worktrees`, or `DEEPSEA_WORKTREES`. */
export function worktreesDir() {
  return resolve(process.env.DEEPSEA_WORKTREES ?? `${mainCheckout()}-worktrees`)
}
