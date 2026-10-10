/**
 * dsd worktree add <topic> [--from <ref>] | list | remove <topic>
 *
 * One worktree per topic, in `<main checkout>-worktrees/<topic>/` (LAYOUT.md
 * §2), on branch `topic/<topic>`, with its `harness` linked to the shared
 * build of its pin and the repository's pre-commit check installed.
 */
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { installHook } from './check.mjs'
import { linkHarness } from '../lib/harness.mjs'
import { mainCheckout, worktreesDir } from '../lib/paths.mjs'
import { isBuild } from '../lib/source.mjs'
import { DsdError, git, note, onlyFlags, parseArgs, printJson, usage } from '../lib/util.mjs'

const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function checkTopic(name) {
  if (typeof name !== 'string' || !TOPIC.test(name)) usage(`"${String(name)}" is not a topic name (lowercase letters, digits and single dashes; the branch is topic/<name>)`)
  if (name === 'base') usage('topic/base lives in the main checkout')
}

/** Every worktree of this repository: path, branch, harness link. */
export function worktrees() {
  const out = []
  let current
  for (const line of git(mainCheckout(), ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice(9) }; out.push(current) }
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'detached') current.branch = '(detached)'
  }
  for (const w of out) {
    try { const link = join(w.path, 'harness'); if (lstatSync(link).isSymbolicLink()) w.harness = readlinkSync(link) } catch { /* none */ }
  }
  // Builds of commits (_builds/deepsea-*) are worktrees too, but no one works in them.
  return out.filter(w => !isBuild(w.path))
}

async function add(args) {
  const topic = args._[1]
  checkTopic(topic)
  if (args._.length > 2) usage('dsd worktree add <topic> [--from <ref>]')
  const main = mainCheckout()
  const branch = `topic/${topic}`
  const path = join(worktreesDir(), topic)
  if (existsSync(path)) throw new DsdError(`${path} already exists`)
  const exists = (() => { try { git(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true } catch { return false } })()
  if (exists && args.from) usage(`${branch} exists already; --from only applies to a new topic`)
  git(main, ['worktree', 'add', ...(exists ? [path, branch] : ['-b', branch, path, String(args.from ?? 'topic/base')])])
  note(`${exists ? 'checked out' : 'created'} ${branch} in ${path}`)
  const link = await linkHarness(path)
  installHook()
  printJson({ topic, branch, path, created: !exists, harness: link.build })
}

function remove(args) {
  const topic = args._[1]
  checkTopic(topic)
  const path = join(worktreesDir(), topic)
  if (!existsSync(path)) throw new DsdError(`no worktree at ${path}`)
  const dirty = git(path, ['status', '--porcelain'])
  if (dirty) throw new DsdError(`${path} has uncommitted changes; commit or discard them first:\n${dirty}`)
  git(mainCheckout(), ['worktree', 'remove', path])
  printJson({ topic, removed: path, branch: `topic/${topic}`, branchKept: true })
}

export async function worktree(argv) {
  const args = parseArgs(argv, ['from'])
  onlyFlags(args, ['from'])
  const sub = args._[0] ?? 'list'
  if (sub === 'add') return add(args)
  if (sub === 'remove') return remove(args)
  if (sub === 'list') return printJson(worktrees())
  usage('dsd worktree add <topic> [--from <ref>] | list | remove <topic>')
}
