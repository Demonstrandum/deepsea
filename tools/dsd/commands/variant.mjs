/**
 * Named variants (LAYOUT.md §1, §6, §7):
 *
 *   dsd new <v> [--source <ref>] [--color <hex>] [--plugins <names|all>] [--no-serve]
 *   dsd build <v> [--install [--dock]] [--self]
 *   dsd remove <v> [--home] [--self]
 *
 * `new` writes the home, its variant.yml (port block, Serve path, source) and
 * its links. `build` makes the immutable build of its source commit, writes
 * its plugins into its profile as bundles, and builds its app; with `--install` it installs the
 * app (~/Applications), the server host and relay link (Application
 * Support) and the relay LaunchAgent, and with `--dock` a Dock tile.
 * `remove` uninstalls all of that and, with `--home`, deletes the home.
 * `dsd run <v>` / `dsd stop <v>` start and stop an installed variant.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OFFSETS, addDockTile, appPathOf, bootout, chooseServePath, choosePortBlock, installApp, installLaunchAgent, jobStatus, kickstart,
  launchAgentOf, linkRelayNode, listening, relayLabelOf, removeApp, removeDockTile, removeLaunchAgent, removeServePath, serverHostNameOf, supportDirOf, tailnetFacts,
} from '../lib/install.mjs'
import { buildsDir, homeOf, logDirOf, variantName } from '../lib/paths.mjs'
import { installBundles, selectPlugins } from '../lib/plugins.mjs'
import { macosLeftovers, refuseOwnHome } from '../lib/remove.mjs'
import { ensureSourceBuild, resolveSourceCommit } from '../lib/source.mjs'
import { DsdError, isoLocal, note, onlyFlags, parseArgs, printJson, sleep, usage } from '../lib/util.mjs'
import { checkNamedId, displayName, listVariants, readVariant, writeVariant } from '../lib/variants.mjs'

/** Plugins only throwaways get: a named variant loads them only when named in its list. */
const TEST_ONLY = new Set(['test-driver', 'scripted-model'])

function namedConfig(id) {
  checkNamedId(id)
  const config = readVariant(id)
  if (!config) throw new DsdError(`no variant ${id} (dsd new ${id})`)
  return config
}

const ports = config => ({ dsh: Number(config.ports) + OFFSETS.dsh, relay: Number(config.ports) + OFFSETS.relay, proxy: Number(config.ports) + OFFSETS.proxy })

function relink(link, target) {
  try { unlinkSync(link) } catch { /* none */ }
  symlinkSync(target, link)
}

/** dsd new <v> */
export async function newVariant(argv) {
  const args = parseArgs(argv, ['source', 'color', 'plugins'])
  onlyFlags(args, ['source', 'color', 'plugins', 'no-serve'])
  const id = args._[0]
  if (id === undefined || args._.length > 1) usage('dsd new <v> [--source <ref>] [--color <hex>] [--plugins <names|all>] [--no-serve]')
  printJson(await createVariant(id, { source: args.source, color: args.color, plugins: args.plugins, noServe: args['no-serve'] }))
}

/** Create a named variant (dsd new; dsd adopt for a variant that does not exist yet). */
export async function createVariant(id, { source = 'integration/base', color, plugins = 'all', noServe = false } = {}) {
  checkNamedId(id)
  if (existsSync(homeOf(id))) throw new DsdError(`${homeOf(id)} exists already`)
  if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) usage('--color takes #rrggbb')
  resolveSourceCommit(source)
  const recorded = new Set(listVariants().filter(v => !v.throwaway && v.config?.ports).map(v => Number(v.config.ports)))
  const block = await choosePortBlock(recorded)
  const facts = noServe ? undefined : tailnetFacts()
  const serve = Boolean(facts?.dnsName)
  const servePath = serve ? chooseServePath(id, block, facts) : undefined
  const home = homeOf(id)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeVariant(id, {
    id, display: displayName(id), ...(color ? { color } : {}), ports: block, source,
    plugins, serve, ...(servePath ? { servePath } : {}), created: isoLocal(),
  })
  mkdirSync(logDirOf(id), { recursive: true, mode: 0o700 })
  relink(join(home, 'logs'), logDirOf(id))
  relink(join(home, 'support'), supportDirOf(id))
  if (!serve && !noServe) note('Tailscale is not available: the variant is local only (its app talks to the relay on this machine)')
  return { id, name: variantName(id), display: displayName(id), home, ports: { block, ...ports({ ports: block }) }, source, serve, servePath }
}

/**
 * The plugins a named variant loads, from its build: its list, or all of them (machine-wide ones too:
 * the rule that leaves those out is for throwaways) except the test-only ones. server-log comes first.
 */
function variantPlugins(config, dir) {
  const value = config.plugins ?? 'all'
  const picked = value === 'all'
    ? selectPlugins('all', dir, { machineWide: true }).filter(p => !TEST_ONLY.has(p.name))
    : selectPlugins(value, dir)
  const log = picked.findIndex(p => p.name === 'server-log')
  if (log >= 0) picked.unshift(...picked.splice(log, 1))
  else picked.unshift(...selectPlugins('server-log', dir))
  return picked
}

/** dsd build <v> [--install [--dock]] */
export async function build(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['install', 'dock', 'self', 'throwaway'])
  const id = args._[0]
  if (id === undefined || args._.length > 1) usage('dsd build <v> [--install [--dock]] [--self]')
  if (args.throwaway) usage('throwaway apps are built by dsd run --throwaway-app')
  if (args.dock && !args.install) usage('--dock goes with --install')
  const config = namedConfig(id)
  if (args.install && !args.self) refuseOwnHome(id)
  const home = homeOf(id)
  const commit = resolveSourceCommit(config.source)
  const dir = await ensureSourceBuild(commit)
  const harnessBuild = readlinkSync(join(dir, 'harness'))
  const plugins = variantPlugins(config, dir)
  const port = ports(config)
  installBundles(plugins, home, harnessBuild)
  const facts = config.serve ? tailnetFacts() : undefined
  const url = config.serve && facts?.dnsName ? `https://${facts.dnsName}${config.servePath}/` : `http://127.0.0.1:${port.relay}/`
  const out = mkdtempSync(join(tmpdir(), `deepsea-build-${id}-`))
  const version = (() => { try { return JSON.parse(execFileSync('/bin/cat', [join(harnessBuild, 'package.json')], { encoding: 'utf8' })).version } catch { return '0.0.0' } })()
  const builtApp = JSON.parse(execFileSync(process.execPath, [join(dir, 'apps', 'macos', 'build.mjs'),
    '--out', out, '--name', displayName(id), '--bundle-id', variantName(id), '--glyph', join(harnessBuild, 'apps', 'web', 'public', 'favicon.svg'),
    '--glyph-color', config.color ?? '#000000', '--url', url, '--fallback-url', `http://127.0.0.1:${port.relay}/`,
    '--token-file', join(home, 'relay', 'state.json'), '--version', version, '--build', commit.slice(0, 10), '--cache', buildsDir()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  const result = { id, source: `${config.source} (${commit.slice(0, 10)})`, build: dir, plugins: plugins.map(p => p.name), app: builtApp.app, url }
  if (!args.install) { printJson(result); return }

  const supportDir = supportDirOf(id)
  const app = installApp(id, builtApp.app)
  rmSync(out, { recursive: true, force: true })
  const host = JSON.parse(execFileSync(process.execPath, [join(dir, 'apps', 'macos', 'build.mjs'), 'server-host',
    '--dir', supportDir, '--name', serverHostNameOf(id), '--bundle-id', `${variantName(id)}.server`,
    '--icon', join(app, 'Contents', 'Resources', 'AppIcon.icns'), '--cache', buildsDir()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  const { link, node } = linkRelayNode(supportDir)
  mkdirSync(join(logDirOf(id), 'relay'), { recursive: true, mode: 0o700 })
  const proxy = plugins.some(p => p.name === 'tailscale')
  const programArguments = [host.executable, link, join(dir, 'apps', 'relay', 'relay.mjs'),
    '--variant', id, '--home', home, '--listen', `127.0.0.1:${port.relay}`, '--dsh', `127.0.0.1:${port.dsh}`,
    ...(proxy ? ['--proxy', `127.0.0.1:${port.proxy}`] : []), '--log-dir', logDirOf(id), '--cwd', harnessBuild,
    '--', node, '--import', 'tsx/esm', join(harnessBuild, 'apps', 'cli', 'src', 'bin.ts'), '--profile', 'web',
    '--no-open', '--port', String(port.dsh)]
  const agent = await installLaunchAgent(id, programArguments, join(logDirOf(id), 'relay', 'launchd.log'))
  relink(join(home, 'source'), dir)
  const dock = args.dock ? addDockTile(app) : undefined
  writeVariant(id, { ...config, build: commit.slice(0, 10), installed: isoLocal() })
  printJson({ ...result, app, serverHost: host.bundle, serverHostChanged: host.changed, relay: `http://127.0.0.1:${port.relay}/`, launchAgent: agent.plist, label: agent.label, ...(dock !== undefined ? { dock } : {}) })
}

/** The state of a named variant: installed, relay and server listening. */
export async function namedStatus(id, config) {
  const port = ports(config)
  const [relay, server] = await Promise.all([listening(port.relay), listening(port.dsh)])
  const installed = existsSync(launchAgentOf(id))
  return { installed, job: jobStatus(relayLabelOf(id)).loaded, relay, server, port: port.dsh }
}

/** dsd run <v> for a named variant: load and start its relay, then open its app. */
export async function runNamed(id, args) {
  const config = namedConfig(id)
  if (!existsSync(launchAgentOf(id))) throw new DsdError(`${id} is not installed (dsd build ${id} --install)`)
  if (!jobStatus(relayLabelOf(id)).loaded) {
    execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, launchAgentOf(id)], { stdio: 'ignore' })
  }
  kickstart(relayLabelOf(id))
  const port = ports(config)
  for (let i = 0; i < 50 && !(await listening(port.relay)); i++) await sleep(200)
  if (!args['no-app']) execFileSync('/usr/bin/open', [appPathOf(id)])
  printJson({ id, ...(await namedStatus(id, config)), app: args['no-app'] ? undefined : appPathOf(id) })
}

/** dsd stop <v> for a named variant: unload its relay job, which stops the relay and its server. */
export async function stopNamed(id, args) {
  namedConfig(id)
  if (!args.self) refuseOwnHome(id)
  const stopped = await bootout(relayLabelOf(id))
  printJson({ id, stopped, note: 'the LaunchAgent stays installed: it starts again at login or with dsd run' })
}

/** dsd remove <v> [--home] */
export async function remove(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['home', 'self'])
  const id = args._[0]
  if (id === undefined || args._.length > 1) usage('dsd remove <v> [--home] [--self]')
  const config = namedConfig(id)
  if (!args.self) refuseOwnHome(id)
  const removed = []
  const agent = await removeLaunchAgent(id)
  if (agent.plist) removed.push(agent.plist)
  if (config.serve && config.servePath && removeServePath(config.servePath, ports(config).relay)) removed.push(`Serve path ${config.servePath}`)
  if (removeDockTile(appPathOf(id))) removed.push('Dock tile')
  const app = removeApp(id)
  if (app) removed.push(app)
  try { execFileSync('/usr/bin/defaults', ['delete', variantName(id)], { stdio: 'ignore' }) } catch { /* no preferences */ }
  for (const path of macosLeftovers(variantName(id))) { rmSync(path, { recursive: true, force: true }); removed.push(path) }
  if (args.home) { rmSync(homeOf(id), { recursive: true, force: true }); removed.push(homeOf(id)) }
  printJson({ id, removed, home: args.home ? 'removed' : `kept: ${homeOf(id)}` })
}

