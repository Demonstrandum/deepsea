/**
 * Restacking topics after a parent moved: each topic is rebased onto its
 * parent's current tip, replaying only its own commits (`git rebase --onto
 * <parent> <fork point> <topic>`, the fork point read from the parent's
 * reflog, so a rewritten parent's old commits are not replayed). Parents go
 * before children. A topic whose worktree has uncommitted work, or whose
 * rebase conflicts, is left as it was, and so are the topics stacked on it.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './util.mjs'

/** Branch → worktree path, for every worktree of the repository with a branch checked out. */
export function worktreesOf(repo) {
  const out = new Map()
  let path
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9)
    else if (line.startsWith('branch refs/heads/')) out.set(line.slice(18), path)
  }
  return out
}

const tryGit = (cwd, args) => { try { return git(cwd, args) } catch { return undefined } }

/** Where `topic` left `parent`: the fork point in the parent's history (reflog), else the merge base. */
export function forkPoint(repo, parent, topic) {
  return tryGit(repo, ['merge-base', '--fork-point', parent, topic]) ?? git(repo, ['merge-base', parent, topic])
}

/**
 * Rebase each topic onto its parent, in order.
 * @param {string} repo - the repository (any of its worktrees).
 * @param {{ topic: string, parent: string }[]} stack - branches, parents before children.
 * @param {{ dry?: boolean }} options
 * @returns {{ topic, parent, state: 'current'|'rebased'|'would rebase'|'dirty'|'conflict'|'blocked', commits?, files?, path? }[]}
 */
export function restack(repo, stack, { dry = false } = {}) {
  const worktrees = worktreesOf(repo)
  const stuck = new Set()
  const report = []
  for (const { topic, parent } of stack) {
    if (stuck.has(parent)) { stuck.add(topic); report.push({ topic, parent, state: 'blocked' }); continue }
    const parentTip = git(repo, ['rev-parse', parent])
    if (tryGit(repo, ['merge-base', '--is-ancestor', parentTip, topic]) !== undefined) {
      report.push({ topic, parent, state: 'current' })
      continue
    }
    const from = forkPoint(repo, parent, topic)
    const commits = Number(git(repo, ['rev-list', '--count', `${from}..${topic}`]))
    const path = worktrees.get(topic)
    if (path && git(path, ['status', '--porcelain'])) { stuck.add(topic); report.push({ topic, parent, state: 'dirty', path }); continue }
    if (dry) { report.push({ topic, parent, state: 'would rebase', commits }); continue }
    // A branch checked out in a worktree is rebased there; any other in a scratch worktree.
    const scratch = path ? undefined : mkdtempSync(join(tmpdir(), 'deepsea-restack-'))
    const where = path ?? scratch
    try {
      if (scratch) git(repo, ['worktree', 'add', '--detach', '--quiet', scratch, topic])
      try {
        execFileSync('git', ['rebase', '--quiet', '--onto', parent, from, topic], { cwd: where, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true' } })
        report.push({ topic, parent, state: 'rebased', commits })
      } catch {
        const files = (tryGit(where, ['diff', '--name-only', '--diff-filter=U']) ?? '').split('\n').filter(Boolean)
        tryGit(where, ['rebase', '--abort'])
        stuck.add(topic)
        report.push({ topic, parent, state: 'conflict', files })
      }
    } finally {
      if (scratch) { tryGit(repo, ['worktree', 'remove', '--force', scratch]); rmSync(scratch, { recursive: true, force: true }) }
    }
  }
  return report
}
