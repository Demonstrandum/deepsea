/**
 * dsd topics [list] [--json] | check | integrate [--dry-run]
 *
 * The topics of both repositories. Harness topics and their order come from
 * the [harness] section of topics.txt. This repository's topics are its
 * `topic/*` branches (other than topic/base); each declares the harness
 * topics it needs in its plugins' package.json (`"deepsea": { "requires":
 * [...] }`), so registering a topic edits no shared file.
 *
 * `check` merges in memory (lib/integrate.mjs): every pair of topics of each
 * repository, and each repository's full integration, reporting conflicts
 * and missing requirements. `integrate` builds the integration branches,
 * `integration/<upstream>` in the harness repository (its baseline
 * topic/base, then its topics in order) and `integration/base` here
 * (topic/base, then every topic in name order), and
 * moves them only when every merge succeeded. Run a throwaway on the result
 * with `dsd run <v> --source integration/base`.
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { harnessRepo, readLock, takeLock } from '../lib/harness.mjs'
import { checkedOutAt, mergeTrees, moveBranch, planIntegration } from '../lib/integrate.mjs'
import { restack } from '../lib/restack.mjs'
import { execFileSync } from 'node:child_process'
import { buildsDir, mainCheckout, worktreesDir } from '../lib/paths.mjs'
import { DsdError, git, note, onlyFlags, parseArgs, printJson, usage } from '../lib/util.mjs'

/** Parse topics.txt: per section, its base and its `topic <branch> [<parent>]` lines. */
export function parseTopics(text) {
  const sections = {}
  let section
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const header = /^\[([a-z]+)\]$/.exec(line)
    if (header) { section = sections[header[1]] = { base: undefined, upstream: undefined, topics: [] }; continue }
    const [kind, name, parent] = line.split(/\s+/)
    if (!section) continue
    if (kind === 'base') section.base = name
    else if (kind === 'upstream') section.upstream = name
    else if (kind === 'topic') section.topics.push({ name, parent })
  }
  return sections
}

const short = branch => branch.replace(/^topic\//, '')
const count = (repo, range) => { try { return Number(git(repo, ['rev-list', '--count', range])) } catch { return undefined } }

/** The harness topics of the topic list, with their state in the harness repository. */
function harnessTopics(section, repo) {
  return section.topics.map(t => ({
    repo: 'harness', topic: short(t.name), parent: short(t.parent ?? section.base),
    commits: count(repo, `${t.parent ?? section.base}..${t.name}`),
  }))
}

/** This repository's topics: branches, the harness topics their plugins require, how far behind base. */
function deepseaTopics(section, harnessNames) {
  const main = mainCheckout()
  const base = section?.base ?? 'topic/base'
  const branches = git(main, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/topic/']).split('\n').filter(b => b && b !== base)
  return branches.map((branch) => {
    const requires = new Set()
    const changed = git(main, ['diff', '--name-only', `${base}...${branch}`]).split('\n')
    for (const file of changed.filter(f => /^plugins\/[^/]+\/package\.json$/.test(f))) {
      try {
        const pkg = JSON.parse(git(main, ['show', `${branch}:${file}`]))
        for (const r of pkg.deepsea?.requires ?? []) requires.add(short(r))
      } catch { /* deleted or unreadable */ }
    }
    const required = [...requires].sort()
    return {
      repo: 'deepsea', topic: short(branch), parent: short(base),
      commits: count(main, `${base}..${branch}`), behind: count(main, `${branch}..${base}`),
      requires: required, missing: required.filter(r => !harnessNames.has(r)),
    }
  })
}

/** The branch an integration of this repository's topics is built on. */
export const DEEPSEA_INTEGRATION = 'integration/base'

/** Both repositories' integration inputs: repository, base, branch, topics in order. */
function integrations(sections, deepseaRows) {
  const harness = sections.harness
  return [
    { repo: 'harness', path: harnessRepo(readLock()), base: harness.base, branch: `integration/${harness.upstream ?? harness.base}`, topics: harness.topics.map(t => t.name) },
    { repo: 'deepsea', path: mainCheckout(), base: sections.deepsea?.base ?? 'topic/base', branch: DEEPSEA_INTEGRATION, topics: deepseaRows.map(r => `topic/${r.topic}`).sort() },
  ]
}

/** Every pair of a repository's topics that conflicts when merged. */
function pairConflicts(path, topics) {
  const found = []
  for (let i = 0; i < topics.length; i++) {
    for (let j = i + 1; j < topics.length; j++) {
      const merged = mergeTrees(path, `refs/heads/${topics[i]}`, `refs/heads/${topics[j]}`)
      if (merged.conflicts) found.push({ topics: [short(topics[i]), short(topics[j])], files: merged.conflicts })
    }
  }
  return found
}

/** Topic worktrees with uncommitted changes (they are integrated as committed). */
function dirtyWorktrees(topicNames) {
  const dirty = []
  for (const name of topicNames) {
    const path = join(worktreesDir(), name)
    try { if (git(path, ['status', '--porcelain'])) dirty.push(name) } catch { /* no worktree */ }
  }
  return dirty
}

async function integrateOrCheck(sections, deepseaRows, { move, dry }) {
  const missing = deepseaRows.filter(r => r.missing.length).map(r => `${r.topic} requires ${r.missing.join(', ')}`)
  const report = { missing, dirty: dirtyWorktrees(deepseaRows.map(r => r.topic)), repos: [] }
  for (const integration of integrations(sections, deepseaRows)) {
    const plan = planIntegration(integration.path, integration.base, integration.topics, integration.branch)
    let current
    try { current = git(integration.path, ['rev-parse', '--verify', `refs/heads/${integration.branch}`]) } catch { /* none yet */ }
    report.repos.push({
      repo: integration.repo, branch: integration.branch, base: integration.base,
      tip: plan.conflict ? undefined : plan.tip, current, changed: !plan.conflict && plan.tip !== current,
      merged: plan.steps.map(s => short(s.topic) + (s.skipped ? ` (${s.skipped})` : s.reused ? '' : ' (new merge)')),
      conflict: plan.conflict ? { topic: short(plan.conflict.topic), files: plan.conflict.files } : undefined,
      pairs: move ? undefined : pairConflicts(integration.path, integration.topics),
    })
  }
  const pinned = readLock().commit
  const harness = report.repos.find(r => r.repo === 'harness')
  if (harness.tip && harness.tip !== pinned) report.pin = { pinned: pinned.slice(0, 10), integration: harness.tip.slice(0, 10), note: 'harness.lock pins another commit: pin the integration on topic/base to run it' }
  const failed = missing.length > 0 || report.repos.some(r => r.conflict)
  if (move && !failed && !dry) {
    for (const r of report.repos) {
      const path = r.repo === 'harness' ? harnessRepo(readLock()) : mainCheckout()
      if (r.changed) { moveBranch(path, r.branch, r.tip); note(`${r.repo}: ${r.branch} -> ${r.tip.slice(0, 10)}${checkedOutAt(path, r.branch) ? ' (checked out; moved with reset --keep)' : ''}`) }
      else note(`${r.repo}: ${r.branch} unchanged at ${r.tip.slice(0, 10)}`)
    }
  }
  for (const r of report.repos) { r.tip = r.tip?.slice(0, 10); r.current = r.current?.slice(0, 10) }
  printJson({ ...report, ok: !failed, ...(move ? { moved: !failed && !dry } : {}) })
  if (failed) throw new DsdError(missing.length ? `missing harness topics: ${missing.join('; ')}` : `conflict: ${report.repos.filter(r => r.conflict).map(r => `${r.repo} ${r.conflict.topic} (${r.conflict.files.join(', ')})`).join('; ')}`)
}

/**
 * Rebase every topic onto its parent's current tip (lib/restack.mjs): the
 * harness topics in topic-list order, then this repository's onto its base;
 * each rebased worktree of this repository is relinked to its pin's build.
 */
async function rebaseTopics(sections, which, dry) {
  const out = {}
  if (which !== 'deepsea') {
    const h = sections.harness
    out.harness = restack(harnessRepo(readLock()), h.topics.map(t => ({ topic: t.name, parent: t.parent ?? h.base })), { dry })
  }
  if (which !== 'harness') {
    const main = mainCheckout()
    const base = sections.deepsea?.base ?? 'topic/base'
    const branches = git(main, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/topic/']).split('\n').filter(b => b && b !== base)
    out.deepsea = restack(main, branches.map(topic => ({ topic, parent: base })), { dry })
    for (const row of out.deepsea.filter(r => r.state === 'rebased')) {
      const path = join(worktreesDir(), short(row.topic))
      try { execFileSync(process.execPath, [join(path, 'tools', 'dsd', 'bin', 'dsd.mjs'), 'link'], { cwd: path, stdio: 'ignore' }); row.linked = true } catch { /* no worktree, or no build yet */ }
    }
  }
  for (const rows of Object.values(out)) for (const r of rows) { r.topic = short(r.topic); r.parent = short(r.parent) }
  const trouble = Object.values(out).flat().filter(r => ['dirty', 'conflict', 'blocked'].includes(r.state))
  printJson({ ...out, ok: trouble.length === 0 })
  for (const r of trouble) note(`${r.topic}: ${r.state}${r.files ? ` (${r.files.join(', ')})` : ''}${r.path ? ` (${r.path})` : ''}`)
}

export async function topics(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['json', 'dry-run'])
  const sub = args._[0] ?? 'list'
  const USAGE = 'dsd topics [list] [--json] | check | rebase [harness|deepsea] [--dry-run] | integrate [--dry-run]'
  if (!['list', 'check', 'integrate', 'rebase'].includes(sub) || args._.length > (sub === 'rebase' ? 2 : 1)) usage(USAGE)
  const sections = parseTopics(readFileSync(join(mainCheckout(), 'topics.txt'), 'utf8'))
  if (sub === 'rebase') {
    const which = args._[1] ?? 'all'
    if (!['all', 'harness', 'deepsea'].includes(which)) usage(USAGE)
    const lock = join(buildsDir(), 'integrate.lock')
    const { held } = takeLock(lock)
    if (held !== undefined) throw new DsdError(`another dsd (pid ${held}) is integrating or rebasing; try again when it is done`)
    try { return await rebaseTopics(sections, which, Boolean(args['dry-run'])) } finally { rmSync(lock, { recursive: true, force: true }) }
  }
  if (sub === 'check' || sub === 'integrate') {
    const harnessNames = new Set(harnessTopics(sections.harness, harnessRepo(readLock())).map(t => t.topic))
    const rows = deepseaTopics(sections.deepsea, harnessNames)
    if (sub === 'check') return integrateOrCheck(sections, rows, { move: false })
    const lock = join(buildsDir(), 'integrate.lock')
    const { held } = takeLock(lock)
    if (held !== undefined) throw new DsdError(`another dsd (pid ${held}) is integrating; try again when it is done`)
    try { return await integrateOrCheck(sections, rows, { move: true, dry: Boolean(args['dry-run']) }) } finally { rmSync(lock, { recursive: true, force: true }) }
  }
  const harness = sections.harness ? harnessTopics(sections.harness, harnessRepo(readLock())) : []
  const deepsea = deepseaTopics(sections.deepsea, new Set(harness.map(t => t.topic)))
  const rows = [...harness, ...deepsea]
  if (args.json) return printJson(rows)
  for (const r of rows) {
    const extra = [
      r.behind ? `${r.behind} behind ${r.parent}: rebase` : '',
      r.requires?.length ? `requires ${r.requires.join(', ')}` : '',
      r.missing?.length ? `MISSING harness topics: ${r.missing.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    process.stdout.write(`${r.repo.padEnd(8)} ${r.topic.padEnd(28)} on ${String(r.parent).padEnd(26)} ${String(r.commits ?? '?').padStart(3)} commits${extra ? `  ${extra}` : ''}\n`)
  }
}
