/**
 * Where DeepSea keeps things (LAYOUT.md §1-§6). Every path is derived here.
 */
import { execFileSync } from 'node:child_process'
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

/** The reverse-DNS root, the DeepSea root (`~/.deepsea` or `DEEPSEA_ROOT`), variant names and the log root: packages/logs. */
export { deepseaRoot, logRoot, ROOT_NAME, variantName } from '../../../packages/logs/index.mjs'
import { deepseaRoot, logRoot, ROOT_NAME, variantName } from '../../../packages/logs/index.mjs'

/** Shared immutable builds. */
export function buildsDir() {
  return join(deepseaRoot(), '_builds')
}

/** A variant's home. */
export function homeOf(id) {
  return join(deepseaRoot(), id)
}



/** A variant's log directory. */
export function logDirOf(id) {
  return join(logRoot(), variantName(id))
}

/** Machine-wide logs (installers, builds). */
export function machineLogDir() {
  return join(logRoot(), ROOT_NAME)
}

/**
 * The private extras repository (plugins that are not published with this
 * one): `<main checkout>-extras`, or `DEEPSEA_EXTRAS`; it may not exist.
 */
export function extrasDir() {
  return resolve(process.env.DEEPSEA_EXTRAS ?? `${mainCheckout()}-extras`)
}

/** The worktree directory: `<main checkout>-worktrees`, or `DEEPSEA_WORKTREES`. */
export function worktreesDir() {
  return resolve(process.env.DEEPSEA_WORKTREES ?? `${mainCheckout()}-worktrees`)
}
