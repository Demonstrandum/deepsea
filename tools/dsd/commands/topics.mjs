/**
 * dsd topics [list] [--json]
 *
 * The topics of both repositories. Harness topics and their order come from
 * the [harness] section of topics.txt. This repository's topics are its
 * `topic/*` branches (other than topic/base); each declares the harness
 * topics it needs in its plugins' package.json (`"deepsea": { "requires":
 * [...] }`), so registering a topic edits no shared file.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { harnessRepo, readLock } from '../lib/harness.mjs'
import { mainCheckout } from '../lib/paths.mjs'
import { git, onlyFlags, parseArgs, printJson, usage } from '../lib/util.mjs'

/** Parse topics.txt: per section, its base and its `topic <branch> [<parent>]` lines. */
export function parseTopics(text) {
  const sections = {}
  let section
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const header = /^\[([a-z]+)\]$/.exec(line)
    if (header) { section = sections[header[1]] = { base: undefined, topics: [] }; continue }
    const [kind, name, parent] = line.split(/\s+/)
    if (!section) continue
    if (kind === 'base') section.base = name
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

export async function topics(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['json'])
  if (args._.length > 1 || (args._[0] && args._[0] !== 'list')) usage('dsd topics [list] [--json]  (integrate and rebase: not built yet)')
  const sections = parseTopics(readFileSync(join(mainCheckout(), 'topics.txt'), 'utf8'))
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
