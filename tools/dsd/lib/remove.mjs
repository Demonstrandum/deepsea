/**
 * Stopping a throwaway and removing it: its supervisor, app and server, then
 * its home, its log directory, its app bundle (unregistered from
 * LaunchServices) and anything macOS keeps under its variant name.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deepseaRoot, homeOf, logDirOf, variantName } from './paths.mjs'
import { appDirOf, quitApp, removeAppBundle } from './app.mjs'
import { alive, runningAs, stopGroup } from './processes.mjs'
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
  // Not here: WebKit's empty $TMPDIR/com.apple.WebKit.<process>+<bundle id> directories, which System
  // Integrity Protection guards (com.apple.rootless); macOS clears them with its temporary directory.
  return found
}

/**
 * Stop a throwaway and, unless `keep`, delete everything it owns.
 * @returns {Promise<{ id: string, stopped: boolean, removed: string[] }>}
 */
export async function removeVariant(id, { keep = false } = {}) {
  if (!parseThrowaway(id)) throw new DsdError(`${id} is a named variant; only throwaways are stopped and removed by dsd so far`)
  refuseOwnHome(id)
  const state = readState(id)
  // The supervisor first, so it does not race this removal (unless it is the caller).
  const supervisor = state?.supervisor
  if (supervisor?.pid && supervisor.pid !== process.pid && alive(supervisor.pid) && runningAs(supervisor.pid, supervisor.signature)) {
    try { process.kill(supervisor.pid, 'SIGTERM') } catch { /* gone */ }
  }
  const appStopped = await quitApp(state?.app)
  const stopped = await stopServer(id)
  const removed = []
  const failed = []
  if (removeAppBundle(state?.app?.dir ?? appDirOf(id))) removed.push(state?.app?.dir ?? appDirOf(id))
  if (!keep) {
    // Preferences go through cfprefsd, which caches them: delete the domain, then any file left.
    if (process.platform === 'darwin') try { execFileSync('/usr/bin/defaults', ['delete', variantName(id)], { stdio: 'ignore' }) } catch { /* no such domain */ }
    for (const path of [homeOf(id), logDirOf(id), join(deepseaRoot(), '_backups', id), ...macosLeftovers(variantName(id))]) {
      if (!existsSync(path)) continue
      // One path that cannot go (a protected file) must not keep the rest.
      try { rmSync(path, { recursive: true, force: true }); removed.push(path) } catch (error) { failed.push(`${path}: ${error.code ?? error.message}`) }
    }
  }
  return { id, stopped: stopped || appStopped, removed, ...(failed.length ? { failed } : {}) }
}
