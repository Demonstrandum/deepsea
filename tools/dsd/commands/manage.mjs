/**
 * dsd stop | list | gc | builds | link
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { buildPaths, buildReady, buildRecord, ensureBuild, harnessRepo, readLock, resolveHarnessCommit } from '../lib/harness.mjs'
import { buildsDir, REPO } from '../lib/paths.mjs'
import { removeVariant } from '../lib/remove.mjs'
import { git, note, onlyFlags, parseArgs, printJson, usage } from '../lib/util.mjs'
import { listVariants, resolveRef } from '../lib/variants.mjs'

/** dsd stop [<ref>] [--keep] */
export async function stop(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['keep'])
  if (args._.length > 1) usage('dsd stop [<variant>] [--keep]')
  const variant = resolveRef(args._[0])
  printJson(await removeVariant(variant.id, { keep: Boolean(args.keep) }))
}

/** dsd list [--builds] [--json] */
export async function list(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['builds', 'json'])
  const rows = args.builds ? builds() : listVariants().map(v => ({
    id: v.id,
    kind: v.throwaway ? 'throwaway' : 'named',
    status: v.running ? 'running' : 'stopped',
    port: v.running ? v.state.port : undefined,
    harness: (v.state?.harness ?? v.config?.harness)?.slice(0, 10),
    url: v.running ? v.state.url : undefined,
  }))
  if (args.json) return printJson(rows)
  if (rows.length === 0) return void process.stdout.write(args.builds ? 'no builds\n' : 'no variants\n')
  const columns = Object.keys(rows[0])
  const cell = (row, c) => String(row[c] ?? '-')
  const width = columns.map(c => Math.max(c.length, ...rows.map(r => cell(r, c).length)))
  const line = values => values.map((v, i) => v.padEnd(width[i])).join('  ').trimEnd()
  process.stdout.write(`${[line(columns.map(c => c.toUpperCase())), ...rows.map(r => line(columns.map(c => cell(r, c))))].join('\n')}\n`)
}

/** Every harness build: commit, status, and what uses it. */
function builds() {
  const dir = buildsDir()
  if (!existsSync(dir)) return []
  const users = buildUsers()
  return readdirSync(dir).filter(f => /^harness-[0-9a-f]{12}\.json$/.test(f)).map((f) => {
    const short = f.slice('harness-'.length, -'.json'.length)
    const record = buildRecord(short) ?? {}
    const commit = record.commit ?? short
    return {
      commit: commit.slice(0, 10),
      status: record.status ?? 'unknown',
      seconds: record.seconds,
      users: (users.get(buildPaths(commit).dir) ?? []).join(',') || undefined,
    }
  })
}

/**
 * What uses each build: variants (configured or running) and `harness`
 * links in this checkout and its worktrees. A build in use is never collected.
 */
function buildUsers() {
  const users = new Map()
  const add = (dir, who) => users.set(dir, [...(users.get(dir) ?? []), who])
  for (const v of listVariants()) {
    if (v.state?.build) add(v.state.build, v.id)
    else if (v.config?.harness) add(buildPaths(v.config.harness).dir, v.id)
  }
  const checkouts = git(REPO, ['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
  for (const checkout of checkouts) {
    const link = join(checkout, 'harness')
    try { if (lstatSync(link).isSymbolicLink()) add(readlinkSync(link), checkout === REPO ? 'harness link' : `harness link (${checkout})`) } catch { /* none */ }
  }
  try { add(buildPaths(readLock().commit).dir, 'pin') } catch { /* no lock readable */ }
  return users
}

/** dsd gc [--builds] [--dry-run] */
export async function gc(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['builds', 'dry-run'])
  const dry = Boolean(args['dry-run'])
  const result = { throwaways: [], builds: [] }
  for (const v of listVariants()) {
    if (!v.throwaway || v.running) continue
    result.throwaways.push(v.id)
    if (!dry) await removeVariant(v.id)
  }
  if (args.builds) {
    const users = buildUsers()
    const repo = harnessRepo()
    for (const f of existsSync(buildsDir()) ? readdirSync(buildsDir()) : []) {
      const m = /^(harness-[0-9a-f]{12})\.json$/.exec(f)
      if (!m) continue
      const dir = join(buildsDir(), m[1])
      if (users.has(dir) || existsSync(`${dir}.lock`)) continue
      result.builds.push(m[1])
      if (dry) continue
      if (existsSync(dir)) git(repo, ['worktree', 'remove', '--force', dir])
      rmSync(join(buildsDir(), f), { force: true })
    }
    if (!dry) git(repo, ['worktree', 'prune'])
  }
  printJson({ ...result, dryRun: dry })
}

/** dsd builds [make [<harness ref>]] */
export async function buildsCommand(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, [])
  if (args._[0] === undefined || args._[0] === 'list') return list(['--builds'])
  if (args._[0] !== 'make' || args._.length > 2) usage('dsd builds [list | make [<harness commit or ref>]]')
  const lock = readLock()
  const repo = harnessRepo(lock)
  const commit = resolveHarnessCommit(args._[1] ?? lock.commit, repo)
  const dir = buildReady(commit) ? buildPaths(commit).dir : await ensureBuild(commit, repo)
  printJson({ commit, dir, ...buildRecord(commit) })
}

/** dsd link — point this checkout's `harness` at the build of its pinned commit. */
export async function link(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, [])
  if (args._.length > 0) usage('dsd link')
  const lock = readLock()
  const repo = harnessRepo(lock)
  const commit = resolveHarnessCommit(lock.commit, repo)
  const dir = await ensureBuild(commit, repo)
  const path = join(REPO, 'harness')
  try {
    const stat = lstatSync(path)
    if (!stat.isSymbolicLink()) usage(`${path} exists and is not a link; move it away first`)
    unlinkSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  symlinkSync(dir, path)
  note(`harness -> ${dir}`)
  printJson({ link: path, build: dir, commit })
}
