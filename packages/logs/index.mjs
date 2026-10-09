/**
 * @deepsea/logs — where DeepSea writes its logs and how (LAYOUT.md §5): the
 * one implementation shared by plugins and dsd. Plain Node, no dependencies,
 * so dsd imports it by path and a plugin links it
 * (`"@deepsea/logs": "link:../../packages/logs"`).
 *
 *   ~/Library/Logs/<variant name>/
 *     server/<ts>-<pid>.log            a run log (openRunLog)
 *     plugins/<name>/<ts>-<pid>.jsonl  a plugin trace (createTrace)
 *
 * `<ts>` is local time `yyyy-MM-ddTHH-mm-ss`. A file's first line names the
 * run; `latest.<ext>` points at the newest file; opening a file prunes its
 * directory to the newest 20 runs plus anything younger than 14 days.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** The bare reverse-DNS root; a variant's name is `<root>.<id>`. */
export const ROOT_NAME = 'io.github.taliesinb.deepsea'
const VARIANT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RUN_FILE = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-[\w.-]+\.(?:log|jsonl)$/
const pad = (n, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, '0')

/** `2026-10-07T19-04-14`: local time, sortable, no colons (file names). */
export function fileStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

/** `2026-10-07T19:04:14+01:00`: local time with its UTC offset; `ms` adds milliseconds. */
export function isoLocal(date = new Date(), { ms = false } = {}) {
  const offset = -date.getTimezoneOffset()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${ms ? `.${pad(date.getMilliseconds(), 3)}` : ''}`
    + `${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`
}

/** A variant's name: `io.github.taliesinb.deepsea.<id>`. */
export function variantName(id) {
  return `${ROOT_NAME}.${id}`
}

/** The directory holding every variant's home: `DEEPSEA_ROOT`, else `~/.deepsea`. */
export function deepseaRoot(env = process.env) {
  return resolve(env.DEEPSEA_ROOT ?? join(homedir(), '.deepsea'))
}

/**
 * The variant id of a home: `DEEPSEA_VARIANT` if set, else the home's
 * directory name when the home sits in the DeepSea root (`~/.deepsea/<v>`);
 * undefined for any other home (a stock DSH home, a test directory).
 */
export function variantOf(home, env = process.env) {
  if (env.DEEPSEA_VARIANT) return VARIANT_ID.test(env.DEEPSEA_VARIANT) ? env.DEEPSEA_VARIANT : undefined
  if (!home) return undefined
  const path = resolve(home)
  const id = basename(path)
  return dirname(path) === deepseaRoot(env) && VARIANT_ID.test(id) ? id : undefined
}

/** The parent of every variant's log directory: `DEEPSEA_LOG_ROOT`, else the platform's. */
export function logRoot(env = process.env, platform = process.platform) {
  if (env.DEEPSEA_LOG_ROOT) return resolve(env.DEEPSEA_LOG_ROOT)
  if (platform === 'darwin') return join(homedir(), 'Library', 'Logs')
  return resolve(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'))
}

/**
 * A home's log directory: `<log root>/<variant name>` for a DeepSea variant,
 * else `<home>/logs` (where DSH writes its own startup reports).
 */
export function variantLogDirectory(home, env = process.env) {
  const id = variantOf(home, env)
  return id ? join(logRoot(env), variantName(id)) : join(resolve(home), 'logs')
}

/** A plugin's log directory: `<variant log directory>/plugins/<name>`. */
export function pluginLogDirectory(name, home, env = process.env) {
  return join(variantLogDirectory(home, env), 'plugins', name)
}

/** Machine-wide logs (installers, builds): `<log root>/io.github.taliesinb.deepsea`. */
export function machineLogDirectory(env = process.env) {
  return join(logRoot(env), ROOT_NAME)
}

/** Delete run files of `dir` beyond the newest `keep`, unless younger than `days`. */
export function prune(dir, { keep = 20, days = 14, now = Date.now() } = {}) {
  if (!existsSync(dir)) return
  const cutoff = now - days * 86_400_000
  const runs = readdirSync(dir).filter(file => RUN_FILE.test(file)).sort().reverse()
  for (const file of runs.slice(keep)) {
    const path = join(dir, file)
    try { if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true }) } catch { /* gone already */ }
  }
}

function pointLatest(dir, path, ext) {
  const latest = join(dir, `latest.${ext}`)
  try { unlinkSync(latest) } catch { /* none yet */ }
  try { symlinkSync(basename(path), latest) } catch { /* another writer won the race */ }
}

/**
 * Open a new run file `<dir>/<ts>-<tag>.<ext>` for appending (directory 0700,
 * file 0600; logs may hold tokens), after pruning the directory, and point
 * `latest.<ext>` at it. `identity` writes the first line now (`<ISO time>
 * <identity>`); otherwise call `identify(text)` once the facts are known
 * (it stamps the current time, so it also serves for later timestamped lines).
 * `rename(tag)` renames the file when its tag (a child's pid) is known only
 * later.
 * @returns {{ fd: number, readonly path: string, identify(text: string): void, write(line: string): void, rename(tag: string | number): void, close(): void }}
 */
export function openRunLog(dir, { tag = process.pid, ext = 'log', identity, keep, days, date = new Date() } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  prune(dir, { keep, days })
  const stamp = fileStamp(date)
  let path = join(dir, `${stamp}-${tag}.${ext}`)
  const fd = openSync(path, 'a', 0o600)
  pointLatest(dir, path, ext)
  const log = {
    fd,
    get path() { return path },
    identify(text) { writeSync(fd, `${isoLocal()} ${text}\n`) },
    write(line) { writeSync(fd, `${line}\n`) },
    rename(next) {
      const renamed = join(dir, `${stamp}-${next}.${ext}`)
      renameSync(path, renamed)
      path = renamed
      pointLatest(dir, path, ext)
    },
    close() { closeSync(fd) },
  }
  if (identity !== undefined) log.identify(identity)
  return log
}

/**
 * A plugin trace (LAYOUT.md §5): `trace(event)` appends one JSON object, with
 * `t` (ISO time with offset and milliseconds), to this process's
 * `<plugin log directory>/<ts>-<pid>.jsonl`, created on first use with a
 * `start` line naming the run. A no-op unless `enabled`; never throws, so a
 * trace cannot break the plugin.
 * @param {{ enabled: boolean, name: string, plugin: string, home?: string, directory?: string, env?: object }} options
 *   `name` is the plugin's directory name, `plugin` its `<package>@<version>`,
 *   `home` the DSH home (pass `resolveDshHome()`; default `DSH_HOME`).
 * @returns {((event: object) => void) & { path?: string }}
 */
export function createTrace({ enabled, name, plugin, home, directory, env = process.env }) {
  const trace = (event) => {
    if (!enabled) return
    try {
      if (trace.path === undefined) {
        const homeDir = home ?? env.DSH_HOME ?? join(deepseaRoot(env), 'release')
        const dir = directory ?? pluginLogDirectory(name, homeDir, env)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        prune(dir)
        const path = join(dir, `${fileStamp()}-${process.pid}.jsonl`)
        const id = variantOf(homeDir, env)
        appendFileSync(path, `${JSON.stringify({ t: isoLocal(new Date(), { ms: true }), event: 'start', pid: process.pid, plugin, variant: id ? variantName(id) : undefined, home: homeDir })}\n`, { mode: 0o600 })
        pointLatest(dir, path, 'jsonl')
        trace.path = path
      }
      appendFileSync(trace.path, `${JSON.stringify({ t: isoLocal(new Date(), { ms: true }), ...event })}\n`)
    } catch { /* a trace never breaks the plugin */ }
  }
  trace.path = undefined
  return trace
}
