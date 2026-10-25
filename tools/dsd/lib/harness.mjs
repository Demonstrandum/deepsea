/**
 * The harness: the pin in harness.lock, and shared immutable builds of
 * harness commits in `_builds/harness-<commit>/` (LAYOUT.md §2).
 *
 * A build is a detached worktree of the harness repository, installed and
 * built once. `harness-<commit>.json` beside it records its status; only a
 * build marked `ready` is ever used. `harness-<commit>.lock/` (holding the
 * builder's pid) keeps two agents from building the same commit at once; a
 * lock whose pid is gone is taken over.
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openRunLog } from './logs.mjs'
import { buildsDir, extrasDir, machineLogDir, mainCheckout, REPO, ROOT_NAME } from './paths.mjs'
import { alive } from './processes.mjs'
import { DsdError, git, isoLocal, note, onPath, sleep, usage } from './util.mjs'

/** Parse harness.lock text: `key value` lines. */
export function parseLock(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = /^([a-z]+)\s+(\S+)\s*$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  if (!out.url || !out.commit) throw new DsdError('harness.lock needs `url` and `commit` lines')
  return out
}

/** The pin of a checkout's working tree (default: this one), or of a commit of it (`ref`). */
export function readLock(ref, checkout = REPO) {
  const text = ref === undefined ? readFileSync(join(checkout, 'harness.lock'), 'utf8') : git(checkout, ['show', `${ref}:harness.lock`])
  return parseLock(text)
}

/** The harness repository a pin names (relative to the main checkout, so worktrees agree). */
export function harnessRepo(lock = readLock()) {
  const path = resolve(mainCheckout(), lock.url)
  if (!existsSync(path)) throw new DsdError(`harness repository ${path} (from harness.lock) not found`)
  return path
}

/**
 * Tag every harness commit a commit of this repository pins (`pin/<12 hex>`,
 * lightweight), so it stays reachable after an integration moves on: every
 * commit of every branch here, and the working tree's pin, keeps a buildable
 * harness. `dry` only reports. `missing`: pins the harness repository lacks.
 */
export function tagPins({ checkout = REPO, repo = harnessRepo(readLock(undefined, checkout)), dry = false } = {}) {
  const pins = new Set()
  try { pins.add(readLock(undefined, checkout).commit) } catch { /* no lock in the working tree */ }
  for (const commit of git(checkout, ['log', '--branches', '--format=%H', '--', 'harness.lock']).split('\n').filter(Boolean)) {
    try { pins.add(readLock(commit, checkout).commit) } catch { /* that commit has no readable lock */ }
  }
  const tags = new Set(git(repo, ['tag', '--list', 'pin/*']).split('\n').filter(Boolean))
  const tagged = [], missing = []
  for (const pin of [...pins].sort()) {
    const name = `pin/${pin.slice(0, 12)}`
    if (tags.has(name)) continue
    try { git(repo, ['cat-file', '-e', `${pin}^{commit}`]) } catch { missing.push(pin.slice(0, 12)); continue }
    if (!dry) git(repo, ['tag', name, pin])
    tagged.push(name)
  }
  return { tagged, missing }
}

/** A full commit id for `ref` in the harness repository. */
export function resolveHarnessCommit(ref, repo = harnessRepo()) {
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])
}

/** Where a commit's build of `kind` (`harness`, `deepsea`), its status record and lock live. */
export function buildPaths(commit, kind = 'harness') {
  const dir = join(buildsDir(), `${kind}-${commit.slice(0, 12)}`)
  return { dir, record: `${dir}.json`, lock: `${dir}.lock` }
}

/** A build's status record, or undefined. */
export function buildRecord(commit, kind = 'harness') {
  const { record } = buildPaths(commit, kind)
  if (!existsSync(record)) return undefined
  try { return JSON.parse(readFileSync(record, 'utf8')) } catch { return undefined }
}

/** Whether a commit's build is ready to run. */
export function buildReady(commit, kind = 'harness') {
  return buildRecord(commit, kind)?.status === 'ready' && existsSync(buildPaths(commit, kind).dir)
}

function writeRecord(commit, kind, record) {
  writeFileSync(buildPaths(commit, kind).record, `${JSON.stringify({ commit, ...record }, null, 2)}\n`)
}

/** Take a lock directory, or report who holds it (a lock whose pid is gone is taken over). */
export function takeLock(lock) {
  try {
    mkdirSync(lock)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const pid = Number(existsSync(join(lock, 'pid')) ? readFileSync(join(lock, 'pid'), 'utf8') : NaN)
    if (Number.isInteger(pid) && alive(pid)) return { held: pid }
    rmSync(lock, { recursive: true, force: true })
    return takeLock(lock)
  }
  writeFileSync(join(lock, 'pid'), String(process.pid))
  return { held: undefined }
}

/** Run one build step, its output into the build log. */
export function runStep(label, command, args, cwd, log) {
  return new Promise((resolvePromise, reject) => {
    log.identify(`step ${label}: ${command} ${args.join(' ')}`)
    const env = { ...process.env }
    delete env.DSH_HOME
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] })
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? resolvePromise()
      : reject(new DsdError(`${label} failed (${signal ?? `exit ${code}`}); log: ${log.path}`)))
  })
}

/**
 * Make sure `commit` has a ready build of `kind`, running `make(dir, log)` under
 * the build lock if not (or waiting for another agent's build of it). A build
 * is made once and never changed; a failed one is retried by the next caller.
 * Returns the build directory.
 */
export async function ensureBuilt(kind, commit, make) {
  const { dir, lock } = buildPaths(commit, kind)
  mkdirSync(buildsDir(), { recursive: true })
  let waited = false
  for (;;) {
    if (buildReady(commit, kind)) return dir
    const { held } = takeLock(lock)
    if (held === undefined) break
    if (!waited) note(`waiting for the build of ${kind} ${commit.slice(0, 10)} (pid ${held})`)
    waited = true
    await sleep(5000)
  }
  try {
    if (buildReady(commit, kind)) return dir
    const started = Date.now()
    const log = openRunLog(join(machineLogDir(), 'builds'), { tag: `${kind}-${commit.slice(0, 12)}-${process.pid}`, keep: 50, days: 30 })
    log.identify(`${ROOT_NAME} build ${kind} ${commit} pid ${process.pid}`)
    writeRecord(commit, kind, { status: 'building', started: isoLocal(), log: log.path })
    try {
      await make(dir, log)
    } catch (error) {
      writeRecord(commit, kind, { status: 'failed', started: isoLocal(new Date(started)), error: error.message, log: log.path })
      throw error
    } finally {
      log.close()
    }
    const seconds = Math.round((Date.now() - started) / 1000)
    writeRecord(commit, kind, { status: 'ready', started: isoLocal(new Date(started)), finished: isoLocal(), seconds, log: log.path })
    note(`${kind} ${commit.slice(0, 10)} built in ${seconds} s`)
    return dir
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/**
 * Make sure harness `commit` has a ready build: a detached worktree of the
 * harness repository, `pnpm install --frozen-lockfile`, `pnpm run build`.
 * Returns the build directory.
 */
export function ensureBuild(commit, repo = harnessRepo()) {
  return ensureBuilt('harness', commit, async (dir, log) => {
    // Its build compiles native/system with `cc` (on macOS the Command Line Tools have it).
    if (process.platform !== 'win32' && !onPath('cc')) throw new DsdError('the harness build compiles native code with cc, and there is none on PATH: install a C compiler (gcc or clang)')
    if (!existsSync(dir)) {
      note(`checking out harness ${commit.slice(0, 10)}`)
      git(repo, ['worktree', 'prune'])
      git(repo, ['worktree', 'add', '--detach', dir, commit])
    }
    note(`installing dependencies (log: ${log.path})`)
    await runStep('install', 'pnpm', ['install', '--frozen-lockfile'], dir, log)
    note('building (several minutes the first time)')
    await runStep('build', 'pnpm', ['run', 'build'], dir, log)
  })
}

/**
 * Point a checkout's `harness` (default: this one) at the build of its pinned
 * commit, building it if needed. Returns the link, the build and the commit.
 */
export async function linkHarness(checkout = REPO) {
  const lock = readLock(undefined, checkout)
  const repo = harnessRepo(lock)
  const commit = resolveHarnessCommit(lock.commit, repo)
  const dir = await ensureBuild(commit, repo)
  const path = join(checkout, 'harness')
  try {
    const stat = lstatSync(path)
    if (!stat.isSymbolicLink()) usage(`${path} exists and is not a link; move it away first`)
    if (readlinkSync(path) === dir) return { link: path, build: dir, commit }
    unlinkSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  symlinkSync(dir, path)
  note(`harness -> ${dir}`)
  return { link: path, build: dir, commit }
}

/**
 * Point the extras repository's `harness` (its plugins' `link:` dependencies
 * go through it) at a build, when the repository exists. The main checkout's
 * `dsd link` keeps it on the main checkout's pin.
 */
export function linkExtras(build) {
  const extras = extrasDir()
  if (!existsSync(join(extras, 'plugins'))) return undefined
  const path = join(extras, 'harness')
  try {
    if (readlinkSync(path) === build) return path
    unlinkSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EINVAL') throw error
  }
  symlinkSync(build, path)
  note(`extras: harness -> ${build}`)
  return path
}
