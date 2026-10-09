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
import { buildsDir, machineLogDir, mainCheckout, REPO, ROOT_NAME } from './paths.mjs'
import { alive } from './processes.mjs'
import { DsdError, git, isoLocal, note, sleep, usage } from './util.mjs'

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

/** A full commit id for `ref` in the harness repository. */
export function resolveHarnessCommit(ref, repo = harnessRepo()) {
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])
}

/** Where a commit's build, status record and lock live. */
export function buildPaths(commit) {
  const dir = join(buildsDir(), `harness-${commit.slice(0, 12)}`)
  return { dir, record: `${dir}.json`, lock: `${dir}.lock` }
}

/** A build's status record, or undefined. */
export function buildRecord(commit) {
  const { record } = buildPaths(commit)
  if (!existsSync(record)) return undefined
  try { return JSON.parse(readFileSync(record, 'utf8')) } catch { return undefined }
}

/** Whether a commit's build is ready to run. */
export function buildReady(commit) {
  return buildRecord(commit)?.status === 'ready' && existsSync(buildPaths(commit).dir)
}

function writeRecord(commit, record) {
  writeFileSync(buildPaths(commit).record, `${JSON.stringify({ commit, ...record }, null, 2)}\n`)
}

/** Take the build lock, or report who holds it. */
function takeLock(lock) {
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

function runStep(label, command, args, cwd, log) {
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
 * Make sure `commit` has a ready build, building it if needed (or waiting for
 * another agent's build of it). Returns the build directory.
 */
export async function ensureBuild(commit, repo = harnessRepo()) {
  const { dir, lock } = buildPaths(commit)
  mkdirSync(buildsDir(), { recursive: true })
  let waited = false
  for (;;) {
    if (buildReady(commit)) return dir
    const { held } = takeLock(lock)
    if (held === undefined) break
    if (!waited) note(`waiting for build of harness ${commit.slice(0, 10)} (pid ${held})`)
    waited = true
    await sleep(5000)
  }
  try {
    if (buildReady(commit)) return dir
    const started = Date.now()
    const log = openRunLog(join(machineLogDir(), 'builds'), { tag: `harness-${commit.slice(0, 12)}-${process.pid}`, keep: 50, days: 30 })
    log.identify(`${ROOT_NAME} build harness ${commit} pid ${process.pid}`)
    writeRecord(commit, { status: 'building', started: isoLocal(), log: log.path })
    try {
      if (!existsSync(dir)) {
        note(`checking out harness ${commit.slice(0, 10)}`)
        git(repo, ['worktree', 'prune'])
        git(repo, ['worktree', 'add', '--detach', dir, commit])
      }
      note(`installing dependencies (log: ${log.path})`)
      await runStep('install', 'pnpm', ['install', '--frozen-lockfile'], dir, log)
      note('building (several minutes the first time)')
      await runStep('build', 'pnpm', ['run', 'build'], dir, log)
    } catch (error) {
      writeRecord(commit, { status: 'failed', started: isoLocal(new Date(started)), error: error.message, log: log.path })
      throw error
    } finally {
      log.close()
    }
    writeRecord(commit, { status: 'ready', started: isoLocal(new Date(started)), finished: isoLocal(), seconds: Math.round((Date.now() - started) / 1000), log: log.path })
    note(`harness ${commit.slice(0, 10)} built in ${Math.round((Date.now() - started) / 1000)} s`)
    return dir
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
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
