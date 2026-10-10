/**
 * Integration branches, built in memory: `git merge-tree --write-tree` makes
 * each merge's tree and `git commit-tree` its commit, so no working tree is
 * touched and nothing moves when a merge conflicts.
 *
 * An integration is `base`, then one `Merge <topic>` commit per topic in
 * order (first parent: the integration so far; second: the topic's tip). A
 * merge whose two parents are those of a commit already on the branch reuses
 * that commit, so an unchanged integration keeps its commit ids (and a pin to
 * it stays valid).
 */
import { spawnSync } from 'node:child_process'
import { DsdError, git } from './util.mjs'

/** The first-parent merges on `branch`, keyed by `<first parent> <second parent>`. */
function existingMerges(repo, branch) {
  const merges = new Map()
  let lines
  try { lines = git(repo, ['rev-list', '--first-parent', '--parents', `refs/heads/${branch}`]).split('\n') } catch { return merges }
  for (const line of lines) {
    const [commit, first, second, extra] = line.split(' ')
    if (second && !extra) merges.set(`${first} ${second}`, commit)
  }
  return merges
}

/** Merge `ours` and `theirs` in memory: `{ tree }` or `{ conflicts: [paths] }`. */
export function mergeTrees(repo, ours, theirs) {
  const result = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  if (result.status === 0) return { tree: lines[0] }
  if (result.status === 1) return { conflicts: lines.slice(1) }
  throw new DsdError(`git merge-tree ${ours} ${theirs} (in ${repo}): ${result.stderr.trim().split('\n')[0]}`)
}

const isAncestor = (repo, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo }).status === 0

/**
 * Plan the integration of `topics` (branch names, in order) onto `base`, as
 * branch `branch`. Writes commit objects but moves no ref.
 * @returns {{ tip: string, steps: Array<{ topic, tip, commit?, reused?, skipped? }>, conflict?: { topic: string, files: string[] } }}
 */
export function planIntegration(repo, base, topics, branch) {
  const existing = existingMerges(repo, branch)
  let current = git(repo, ['rev-parse', '--verify', `${base}^{commit}`])
  const steps = []
  for (const topic of topics) {
    const tip = git(repo, ['rev-parse', '--verify', `refs/heads/${topic}^{commit}`])
    if (isAncestor(repo, tip, current)) { steps.push({ topic, tip, skipped: 'already in' }); continue }
    const reuse = existing.get(`${current} ${tip}`)
    if (reuse) { current = reuse; steps.push({ topic, tip, commit: reuse, reused: true }); continue }
    const merged = mergeTrees(repo, current, tip)
    if (merged.conflicts) return { tip: current, steps, conflict: { topic, files: merged.conflicts } }
    current = git(repo, ['commit-tree', merged.tree, '-p', current, '-p', tip, '-m', `Merge ${topic}`])
    steps.push({ topic, tip, commit: current, reused: false })
  }
  return { tip: current, steps }
}

/** The worktree that has `branch` checked out, or undefined. */
export function checkedOutAt(repo, branch) {
  let path
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9)
    else if (line === `branch refs/heads/${branch}`) return path
  }
  return undefined
}

/**
 * Point `branch` at `tip`. A branch checked out in a worktree is moved there
 * with `git reset --keep`, which refuses when that worktree has changes the
 * move would touch; anything else is a plain ref update. Returns the previous
 * tip, or undefined for a new branch.
 */
export function moveBranch(repo, branch, tip) {
  let previous
  try { previous = git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]) } catch { /* new branch */ }
  if (previous === tip) return previous
  const worktree = checkedOutAt(repo, branch)
  if (worktree) {
    if (git(worktree, ['status', '--porcelain', '--untracked-files=no'])) throw new DsdError(`${branch} is checked out in ${worktree} with uncommitted changes; commit or stash them first`)
    git(worktree, ['reset', '--keep', tip])
  } else {
    git(repo, ['update-ref', `refs/heads/${branch}`, tip, ...(previous ? [previous] : [])])
  }
  return previous
}
