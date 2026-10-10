/**
 * A commit of this repository as an immutable build (LAYOUT.md §2):
 * `_builds/deepsea-<12 hex>/`, a detached worktree of the main checkout at
 * that commit, its `harness` link to the build of the pin it carries, and
 * every plugin installed (`pnpm install --frozen-lockfile`) and its browser
 * half built. Made once under the build lock (lib/harness.mjs), never changed;
 * `dsd run --source <ref>` runs throwaways from it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureBuilt, linkHarness, runStep } from './harness.mjs'
import { buildsDir, mainCheckout } from './paths.mjs'
import { DsdError, git, note } from './util.mjs'

/** The full commit a ref of this repository names. */
export function resolveSourceCommit(ref) {
  try { return git(mainCheckout(), ['rev-parse', '--verify', `${ref}^{commit}`]) } catch {
    throw new DsdError(`"${ref}" is not a commit of this repository`)
  }
}

/** The plugin directories of a checkout, sorted. */
function pluginDirs(checkout) {
  const dir = join(checkout, 'plugins')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json')))
    .map(entry => entry.name).sort()
}

/** Make sure `commit` has a ready build; returns its directory. */
export function ensureSourceBuild(commit) {
  return ensureBuilt('deepsea', commit, async (dir, log) => {
    const main = mainCheckout()
    if (!existsSync(dir)) {
      note(`checking out deepsea ${commit.slice(0, 10)}`)
      git(main, ['worktree', 'prune'])
      git(main, ['worktree', 'add', '--detach', dir, commit])
    }
    await linkHarness(dir)
    for (const name of pluginDirs(dir)) {
      const plugin = join(dir, 'plugins', name)
      const pkg = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'))
      const frozen = existsSync(join(plugin, 'pnpm-lock.yaml')) ? ['--frozen-lockfile'] : []
      note(`installing plugins/${name}`)
      await runStep(`install ${name}`, 'pnpm', ['install', ...frozen], plugin, log)
      if (pkg.dsh?.client !== undefined && pkg.scripts?.build) {
        note(`building plugins/${name}`)
        await runStep(`build ${name}`, 'pnpm', ['run', 'build'], plugin, log)
      }
    }
  })
}

/** Whether a path is a build (so not a topic worktree). */
export const isBuild = path => path.startsWith(`${buildsDir()}/`)
