/**
 * The simulated providers: every module in this directory but this one. A
 * provider module exports `name`, `hosts` (the hosts it serves, as the harness
 * puts them first in the path), `initialState(kind, credential)` (a new
 * account's state; kind `key` or `email`) and `create(ctx, catalog)`, which
 * returns the request handler `(req, res, path, body, host)`, optionally with
 * `signIn({ email, plan? })` for providers whose Plan is signed into with an
 * email (dsd uses it to start a throwaway signed in). Its test accounts are
 * in `fixtures/<name>.json`.
 */
import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Every provider module, by name. */
export async function loadProviders() {
  const providers = new Map()
  for (const file of readdirSync(here).filter(f => f.endsWith('.mjs') && f !== 'index.mjs').sort()) {
    const module = (await import(pathToFileURL(`${here}/${file}`).href)).default
    if (!module?.name || !Array.isArray(module.hosts) || typeof module.create !== 'function' || typeof module.initialState !== 'function') {
      throw new Error(`providers/${file} does not export { name, hosts, initialState, create }`)
    }
    for (const other of providers.values()) {
      const shared = module.hosts.filter(h => other.hosts.includes(h))
      if (shared.length > 0) throw new Error(`${module.name} and ${other.name} both serve ${shared.join(', ')}`)
    }
    providers.set(module.name, module)
  }
  return providers
}
