/**
 * Variants: ids, display names, the files in a home, and resolving a
 * reference typed on the command line to one variant.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { deepseaRoot, homeOf, REPO } from './paths.mjs'
import { alive, runningAs } from './processes.mjs'
import { DsdError, formatFlatYaml, parseFlatYaml, usage } from './util.mjs'

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const THROWAWAY = /^([a-z0-9]+(?:-[a-z0-9]+)*)-([0-9a-f]{6})$/

/** A throwaway id's parent and hex, or undefined for a named id. */
export function parseThrowaway(id) {
  const m = THROWAWAY.exec(id)
  return m ? { parent: m[1], hex: m[2] } : undefined
}

/** Check a named variant id: lowercase `[a-z0-9-]`, not ending in `-` plus six hex digits. */
export function checkNamedId(id) {
  if (typeof id !== 'string' || !ID.test(id)) usage(`"${String(id)}" is not a variant id (lowercase letters, digits and single dashes)`)
  if (THROWAWAY.test(id)) usage(`"${id}" ends in - and six hex digits, which only throwaway ids do`)
}

/** `release` → DeepSea; `personal` → DeepSea Personal; `personal-3f9a1c` → DeepSea Personal 3f9a1c. */
export function displayName(id) {
  const t = parseThrowaway(id)
  if (t) return `${displayName(t.parent)} ${t.hex}`
  if (id === 'release') return 'DeepSea'
  return `DeepSea ${id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')}`
}

const variantFile = id => join(homeOf(id), 'variant.yml')
const stateFile = id => join(homeOf(id), 'run', 'state.json')

/** A variant's configuration, or undefined when it has none. */
export function readVariant(id) {
  const file = variantFile(id)
  return existsSync(file) ? parseFlatYaml(readFileSync(file, 'utf8')) : undefined
}

/** Write a variant's configuration. */
export function writeVariant(id, config) {
  writeFileSync(variantFile(id), formatFlatYaml(config, `${displayName(id)}: written by dsd`), { mode: 0o600 })
}

/** A running variant's process facts (`run/state.json`), or undefined. */
export function readState(id) {
  const file = stateFile(id)
  if (!existsSync(file)) return undefined
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

/** Record a running variant's process facts. */
export function writeState(id, state) {
  mkdirSync(join(homeOf(id), 'run'), { recursive: true, mode: 0o700 })
  writeFileSync(stateFile(id), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

/** Whether a variant's recorded server is still the process it started. */
export function isRunning(state) {
  return state?.pid !== undefined && alive(state.pid) && runningAs(state.pid, state.signature)
}

/** Who is creating a variant: the calling agent's session (when it runs in one) and this checkout. */
export function currentOwner() {
  return { session: process.env.DSH_SESSION_ID || undefined, checkout: REPO }
}

/** Whether a variant was created by the caller (same session, or same checkout outside any session). */
export function ownedByCaller(config) {
  const me = currentOwner()
  if (config?.ownerSession || me.session) return config?.ownerSession === me.session
  return config?.ownerCheckout === me.checkout
}

/** When a variant last showed activity: its run state, else its configuration. */
export function lastActivity(id) {
  for (const file of [join(homeOf(id), 'run', 'state.json'), join(homeOf(id), 'variant.yml')]) {
    try { return statSync(file).mtimeMs } catch { /* next */ }
  }
  return 0
}

/** Every variant with a home: id, configuration, state, running. */
export function listVariants() {
  const root = deepseaRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && existsSync(variantFile(entry.name)))
    .map((entry) => {
      const id = entry.name
      const state = readState(id)
      return { id, throwaway: parseThrowaway(id) !== undefined, config: readVariant(id), state, running: isRunning(state) }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Resolve a reference to one variant: a full id, a unique part of a
 * throwaway's hex, or nothing when exactly one throwaway is running.
 * @param {string | undefined} ref
 */
export function resolveRef(ref) {
  const all = listVariants()
  const names = list => list.map(v => `${v.id}${v.running ? ' (running)' : ''}`).join(', ')
  if (ref === undefined) {
    // Only the caller's own: with several agents at work, another agent's
    // throwaway is never picked by default.
    const running = all.filter(v => v.throwaway && v.running && ownedByCaller(v.config))
    if (running.length === 1) return running[0]
    if (running.length === 0) throw new DsdError('none of your throwaways is running; name a variant')
    throw new DsdError(`several of your throwaways are running (${names(running)}); name one`)
  }
  const exact = all.find(v => v.id === ref)
  if (exact) return exact
  if (/^[0-9a-f]{2,6}$/.test(ref)) {
    const matches = all.filter(v => v.throwaway && parseThrowaway(v.id).hex.includes(ref))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw new DsdError(`"${ref}" matches several throwaways (${names(matches)})`)
  }
  throw new DsdError(`no variant "${ref}"${all.length ? ` (have: ${names(all)})` : ''}`)
}
