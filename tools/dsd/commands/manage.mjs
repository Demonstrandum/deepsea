/**
 * dsd stop | list | gc | builds | link
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildPaths, buildReady, buildRecord, ensureBuild, harnessRepo, linkHarness, readLock, resolveHarnessCommit } from '../lib/harness.mjs'
import { buildsDir, REPO } from '../lib/paths.mjs'
import { runningAs } from '../lib/processes.mjs'
import { removeVariant } from '../lib/remove.mjs'
import { git, onlyFlags, parseArgs, printJson, usage } from '../lib/util.mjs'
import { lastActivity, listVariants, ownedByCaller, resolveRef } from '../lib/variants.mjs'

/** dsd stop [<ref>] [--keep] */
export async function stop(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['keep'])
  if (args._.length > 1) usage('dsd stop [<variant>] [--keep]')
  const variant = resolveRef(args._[0])
  printJson(await removeVariant(variant.id, { keep: Boolean(args.keep) }))
}

/** Whether a throwaway's app is still the process dsd started (its server may be gone). */
function appAlive(state) {
  return Boolean(state?.app?.pid && runningAs(state.app.pid, state.app.signature))
}

/** dsd list [--builds] [--json] */
export async function list(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['builds', 'json'])
  const rows = args.builds ? builds() : listVariants().map(v => ({
    id: v.id,
    kind: v.throwaway ? 'throwaway' : 'named',
    status: v.running ? 'running' : appAlive(v.state) ? 'app only' : 'stopped',
    port: v.running ? v.state.port : undefined,
    harness: (v.state?.harness ?? v.config?.harness)?.slice(0, 10),
    owner: v.throwaway ? (ownedByCaller(v.config) ? 'me' : (v.config?.ownerSession ?? v.config?.ownerCheckout ?? '?').replace(/^session-/, '').slice(0, 13)) : undefined,
    expires: v.config?.expires,
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

/** How long another agent's stopped throwaway is kept for inspection. */
const FOREIGN_GRACE_MS = 60 * 60_000

/**
 * Which throwaways gc removes, and why: the caller's own once stopped;
 * anyone's once stopped for an hour; anyone's, running or not, past its
 * time limit.
 */
export function gcReason(v, now = Date.now()) {
  if (!v.throwaway) return undefined
  const expires = v.config?.expires ? Date.parse(v.config.expires) : NaN
  if (expires < now) return 'expired'
  // An app still open on a stopped server is in use (the page after a /reboot); its quit removes it.
  if (v.running || appAlive(v.state)) return undefined
  if (ownedByCaller(v.config)) return 'stopped'
  return now - lastActivity(v.id) > FOREIGN_GRACE_MS ? 'stopped over an hour ago' : undefined
}

/** dsd gc [--builds] [--dry-run] */
export async function gc(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['builds', 'dry-run'])
  const dry = Boolean(args['dry-run'])
  const result = { throwaways: [], kept: [], builds: [] }
  for (const v of listVariants()) {
    if (!v.throwaway) continue
    const reason = gcReason(v)
    if (reason === undefined) { if (!v.running) result.kept.push({ id: v.id, reason: 'another agent stopped it under an hour ago' }); continue }
    result.throwaways.push({ id: v.id, reason })
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
    // App compiles and extracted app sources: rebuilt on demand in seconds, so any not used in
    // the last hour (and not an unfinished build beside them) can go.
    const hour = Date.now() - 60 * 60_000
    for (const f of existsSync(buildsDir()) ? readdirSync(buildsDir()) : []) {
      if (!/^macos-(?:src-)?[0-9a-f]{12}$/.test(f)) continue
      const dir = join(buildsDir(), f)
      if (statSync(dir).atimeMs > hour || statSync(dir).mtimeMs > hour) continue
      result.builds.push(f)
      if (!dry) rmSync(dir, { recursive: true, force: true })
    }
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
  printJson(await linkHarness())
}
