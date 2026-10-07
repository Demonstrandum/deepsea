/**
 * Stopping a variant's server and removing a throwaway: its home, its log
 * directory and anything macOS keeps under its variant name.
 */
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { homeOf, logDirOf, variantName } from './paths.mjs'
import { stopGroup } from './processes.mjs'
import { DsdError } from './util.mjs'
import { isRunning, parseThrowaway, readState } from './variants.mjs'

const real = path => { try { return realpathSync(path) } catch { return path } }

/** Refuse to act on the home the calling process runs in. */
export function refuseOwnHome(id) {
  const own = process.env.DSH_HOME
  if (own && real(own) === real(homeOf(id))) throw new DsdError(`${id} is the variant this process runs in; dsd will not stop it`)
}

/** Stop a variant's recorded server, if it is still the process dsd started. Returns whether it was running. */
export async function stopServer(id) {
  const state = readState(id)
  if (!isRunning(state)) return false
  await stopGroup(state.pid)
  return true
}

/** macOS directories and files kept for a bundle id and its components (`<name>`, `<name>.<component>`). */
export function macosLeftovers(name) {
  if (process.platform !== 'darwin') return []
  const library = join(homedir(), 'Library')
  const matches = entry => entry === name || entry.startsWith(`${name}.`)
  const found = []
  for (const sub of ['Caches', 'WebKit', 'HTTPStorages', 'Saved Application State', 'Logs', 'Application Support']) {
    const dir = join(library, sub)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) if (matches(entry) || matches(entry.replace(/\.savedState$/, ''))) found.push(join(dir, entry))
  }
  const prefs = join(library, 'Preferences')
  if (existsSync(prefs)) for (const entry of readdirSync(prefs)) if (matches(entry.replace(/\.plist$/, ''))) found.push(join(prefs, entry))
  return found
}

/**
 * Stop a throwaway and, unless `keep`, delete everything it owns.
 * @returns {Promise<{ id: string, stopped: boolean, removed: string[] }>}
 */
export async function removeVariant(id, { keep = false } = {}) {
  if (!parseThrowaway(id)) throw new DsdError(`${id} is a named variant; only throwaways are stopped and removed by dsd so far`)
  refuseOwnHome(id)
  const stopped = await stopServer(id)
  const removed = []
  if (!keep) {
    for (const path of [homeOf(id), logDirOf(id), ...macosLeftovers(variantName(id))]) {
      if (existsSync(path)) { rmSync(path, { recursive: true, force: true }); removed.push(path) }
    }
  }
  return { id, stopped, removed }
}
