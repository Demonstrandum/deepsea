/**
 * Loading plugins into a throwaway in place, from this checkout or a build
 * of a commit (lib/source.mjs): each plugin's own bundle patch
 * (cordis.patch.yml) with its package name replaced by the absolute path of
 * its entry module, passed to the server as a `--patch`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './paths.mjs'
import { DsdError, note, usage } from './util.mjs'

const pluginsDir = (root = REPO) => join(root, 'plugins')

/** A plugin directory's package facts. */
function describe(name, root = REPO) {
  const dir = join(pluginsDir(root), name)
  const file = join(dir, 'package.json')
  if (!existsSync(file)) usage(`no plugin "${name}" in ${pluginsDir(root)}`)
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  return {
    name, dir, pkg,
    entry: join(dir, pkg.main ?? 'index.js'),
    client: pkg.dsh?.client !== undefined,
    machineWide: pkg.deepsea?.machineWide,
  }
}

/** Every plugin directory of a checkout (default: this one). */
export function allPlugins(root = REPO) {
  if (!existsSync(pluginsDir(root))) return []
  return readdirSync(pluginsDir(root), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(pluginsDir(root), entry.name, 'package.json')))
    .map(entry => entry.name).sort()
}

/**
 * The plugins a `--plugins` value selects: names, or `all` (which, for a
 * throwaway, leaves machine-wide plugins out; naming one includes it).
 */
export function selectPlugins(value, root = REPO, { machineWide = false } = {}) {
  if (value === undefined || value === true) return []
  // From a source build (`--source`), a plugin it does not have comes from this checkout: a
  // topic's plugin not integrated yet runs beside the integration.
  const own = name => root !== REPO && !existsSync(join(pluginsDir(root), name, 'package.json')) && existsSync(join(pluginsDir(REPO), name, 'package.json'))
  const from = (name) => {
    if (!own(name)) return describe(name, root)
    note(`plugins/${name} from this checkout (${REPO}): the source build has no such plugin`)
    return describe(name, REPO)
  }
  if (value === 'all') {
    const extra = root === REPO ? [] : allPlugins(REPO).filter(own)
    const picked = [...allPlugins(root).map(name => describe(name, root)), ...extra.map(from)]
    if (machineWide) return picked
    const skipped = picked.filter(p => p.machineWide)
    if (skipped.length) note(`leaving out machine-wide plugins (name them to include): ${skipped.map(p => `${p.name} (${p.machineWide})`).join(', ')}`)
    return picked.filter(p => !p.machineWide)
  }
  return String(value).split(',').map(s => s.trim()).filter(Boolean).map(from)
}

/** The newest modification time among a plugin's own files (not dependencies, output or tests). */
function newestSource(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'lib', 'tests', '.git'].includes(entry.name)) continue
    const path = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs)
  }
  return newest
}

/** Install a plugin that never was, and build its browser half when missing or older than its sources. */
export function preparePlugin(plugin) {
  const run = (args) => {
    const result = spawnSync('pnpm', args, { cwd: plugin.dir, encoding: 'utf8' })
    if (result.status !== 0) throw new DsdError(`pnpm ${args.join(' ')} in plugins/${plugin.name} failed:\n${(result.stderr || result.stdout).trim().split('\n').slice(-15).join('\n')}`)
  }
  if (!existsSync(join(plugin.dir, 'node_modules'))) { note(`installing plugins/${plugin.name}`); run(['install']) }
  if (plugin.client) {
    const bundle = join(plugin.dir, 'lib', 'client.js')
    const stale = !existsSync(bundle) || statSync(bundle).mtimeMs < newestSource(plugin.dir)
    if (stale) { note(`building plugins/${plugin.name}`); run(['run', 'build']) }
  }
}

/**
 * Write one patch per plugin into `dir`: its bundle patch, the package name
 * replaced by the absolute entry path. Returns the patch files.
 */
export function writePluginPatches(plugins, dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return plugins.map((plugin) => {
    const source = join(plugin.dir, 'cordis.patch.yml')
    if (!existsSync(source)) throw new DsdError(`plugins/${plugin.name} has no cordis.patch.yml`)
    const quoted = plugin.pkg.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    const pattern = new RegExp(`(name:\\s*)(["']?)${quoted}\\2(\\s*(#.*)?)$`, 'gm')
    const text = readFileSync(source, 'utf8')
    if (!pattern.test(text)) throw new DsdError(`plugins/${plugin.name}/cordis.patch.yml has no row named ${plugin.pkg.name}`)
    const file = join(dir, `${plugin.name}.patch.yml`)
    writeFileSync(file, `# written by dsd: plugins/${plugin.name} loaded in place\n${text.replace(pattern, (_, key, _q, rest) => `${key}${JSON.stringify(plugin.entry)}${rest}`)}`, { mode: 0o600 })
    return file
  })
}
