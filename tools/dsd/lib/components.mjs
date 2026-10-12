/**
 * Where a throwaway's app or relay comes from: `apps/<component>` of, in
 * order, a path given on the command line (a checkout or worktree, or the
 * component's own directory, used as it is), this checkout when it has one,
 * or a commit (default: the topic branch that carries the component),
 * extracted once into `_builds/<component>-src-<12 hex>/` with the other
 * paths it needs (the relay imports `packages/logs`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildsDir, mainCheckout, REPO } from './paths.mjs'
import { DsdError, git } from './util.mjs'

/** The components dsd runs from apps/: their entry, the branch carrying them, and what an extraction takes. */
export const COMPONENTS = {
  macos: { entry: 'build.mjs', marker: 'Sources', branch: 'topic/macos-app', paths: ['apps/macos'], flag: '--app' },
  relay: { entry: 'relay.mjs', marker: 'relay.mjs', branch: 'topic/relay', paths: ['apps/relay', 'packages/logs'], flag: undefined },
}

/**
 * The source of one component: `{ dir, entry, describe, build }`, where `dir` is its `apps/<component>`
 * directory, `entry` its main file and `build` the commit it comes from (`+` when the tree has
 * uncommitted changes there; `local` for a bare directory).
 * @param {'macos' | 'relay'} component
 * @param {string | undefined} choice - a path (absolute, `.` or `~` relative) or a commit of this repository
 */
export function componentSource(component, choice) {
  const spec = COMPONENTS[component]
  if (spec === undefined) throw new DsdError(`no component ${component}`)
  const sub = join('apps', component)
  const has = checkout => existsSync(join(checkout, sub, spec.entry))
  const fromCheckout = (checkout) => {
    let build = 'unknown'
    try {
      build = git(checkout, ['rev-parse', '--short=10', 'HEAD'])
      if (git(checkout, ['status', '--porcelain', '--', ...spec.paths])) build += '+'
    } catch { /* not a git checkout */ }
    const dir = join(checkout, sub)
    return { dir, entry: join(dir, spec.entry), describe: `${checkout}/${sub}`, build }
  }
  if (choice !== undefined && (choice.startsWith('/') || choice.startsWith('.') || choice.startsWith('~'))) {
    const path = resolve(choice.replace(/^~(?=\/)/, process.env.HOME ?? '~'))
    if (has(path)) return fromCheckout(path)
    if (existsSync(join(path, spec.entry)) && existsSync(join(path, spec.marker))) return { dir: path, entry: join(path, spec.entry), describe: path, build: 'local' }
    throw new DsdError(`${path} has no ${sub}`)
  }
  if (choice === undefined && has(REPO)) return fromCheckout(REPO)
  const ref = choice ?? spec.branch
  let commit
  try { commit = git(mainCheckout(), ['rev-parse', '--verify', `${ref}^{commit}`]) } catch {
    throw new DsdError(`no ${component} source: this checkout has no ${sub} and "${ref}" is not a commit${spec.flag ? ` (use ${spec.flag} <checkout | ref>)` : ''}`)
  }
  const target = join(buildsDir(), `${component}-src-${commit.slice(0, 12)}`)
  if (!has(target)) {
    const work = `${target}.tmp-${process.pid}`
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    try {
      execFileSync('/bin/sh', ['-c', 'd="$1" c="$2" w="$3"; shift 3; set -o pipefail; git -C "$d" archive "$c" "$@" | tar -x -C "$w"', 'sh', mainCheckout(), commit, work, ...spec.paths], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      rmSync(work, { recursive: true, force: true })
      throw new DsdError(`${ref} has no ${spec.paths.join(' and ')} (${String(error.stderr ?? error.message).trim()})`)
    }
    try { renameSync(work, target) } catch { rmSync(work, { recursive: true, force: true }) }
  }
  const dir = join(target, sub)
  return { dir, entry: join(dir, spec.entry), describe: `${ref} (${commit.slice(0, 10)})`, build: commit.slice(0, 10) }
}
