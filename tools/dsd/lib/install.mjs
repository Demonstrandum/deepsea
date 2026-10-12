/**
 * Installing a named variant on macOS (LAYOUT.md §6): its app in
 * ~/Applications, its server host and relay link in Application Support, its
 * relay LaunchAgent, an optional Dock tile, and the choice of its port block
 * and Tailscale Serve path. Pure parts (plist text, Dock entries, choices)
 * are exported for tests; everything that acts goes through `launchctl`,
 * `lsregister`, `defaults` and the file system here.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { variantName } from './paths.mjs'
import { DsdError, note, sleep } from './util.mjs'
import { displayName } from './variants.mjs'

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const TAILSCALE = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']

export const PORT_BASE = 3200
export const PORT_BLOCK = 10
/** Offsets in a port block (LAYOUT.md §7). */
export const OFFSETS = { dsh: 0, relay: 3, proxy: 4 }

export const applicationsDir = () => join(homedir(), 'Applications')
export const appPathOf = id => join(applicationsDir(), `${displayName(id)}.app`)
export const supportDirOf = id => join(homedir(), 'Library', 'Application Support', variantName(id))
export const relayLabelOf = id => `${variantName(id)}.relay`
export const launchAgentOf = id => join(homedir(), 'Library', 'LaunchAgents', `${relayLabelOf(id)}.plist`)
export const serverHostNameOf = id => `${displayName(id)} Server`
const domain = () => `gui/${userInfo().uid}`

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The relay LaunchAgent's plist: started at login and kept alive, its own stdout/stderr file. */
export function relayPlist({ label, programArguments, launchdLog, environment = {} }) {
  const env = Object.entries(environment)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map(arg => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(launchdLog)}</string>
  <key>StandardErrorPath</key><string>${xml(launchdLog)}</string>
${env.length ? `  <key>EnvironmentVariables</key>\n  <dict>\n${env.map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}\n  </dict>\n` : ''}</dict>
</plist>
`
}

const launchctl = args => spawnSync('/bin/launchctl', args, { encoding: 'utf8' })

/** Whether a job is loaded, and its pid when running. */
export function jobStatus(label) {
  const result = launchctl(['print', `${domain()}/${label}`])
  if (result.status !== 0) return { loaded: false }
  const pid = /\bpid = (\d+)/.exec(result.stdout)?.[1]
  return { loaded: true, pid: pid ? Number(pid) : undefined }
}

/** Unload a job (stops the relay and, with it, its server) and wait until it is gone. */
export async function bootout(label) {
  if (!jobStatus(label).loaded) return false
  launchctl(['bootout', `${domain()}/${label}`])
  for (let i = 0; i < 100 && jobStatus(label).loaded; i++) await sleep(100)
  return true
}

/** Load a plist (retrying launchd's transient EIO while a previous job of the label winds down). */
export async function bootstrap(plist, label) {
  let last
  for (let attempt = 0; attempt < 10; attempt++) {
    last = launchctl(['bootstrap', domain(), plist])
    if (last.status === 0 || jobStatus(label).loaded) return
    await sleep(500)
  }
  throw new DsdError(`launchctl bootstrap ${plist} failed: ${(last.stderr || last.stdout).trim()}`)
}

/** Start a loaded job if it is not running. */
export function kickstart(label) {
  const result = launchctl(['kickstart', `${domain()}/${label}`])
  if (result.status !== 0) throw new DsdError(`launchctl kickstart ${label} failed: ${(result.stderr || result.stdout).trim()}`)
}

/** Whether something accepts connections on 127.0.0.1:<port>. */
export function listening(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (ok) => { socket.destroy(); clearTimeout(timer); resolve(ok) }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * The first port block from 3200 that no other variant of this account records and on which
 * nothing listens (another account's variants show up as listeners).
 */
export async function choosePortBlock(recorded) {
  for (let base = PORT_BASE; base < 65000; base += PORT_BLOCK) {
    if (recorded.has(base)) continue
    let busy = false
    for (let port = base; port < base + PORT_BLOCK && !busy; port++) busy = await listening(port, 150)
    if (!busy) return base
  }
  throw new DsdError('no free port block')
}

/** The tailscale CLI, or undefined. */
export function tailscaleCli() {
  for (const candidate of TAILSCALE) if (existsSync(candidate)) return candidate
  const which = spawnSync('/usr/bin/which', ['tailscale'], { encoding: 'utf8' })
  return which.status === 0 ? which.stdout.trim() : undefined
}

/** This node's MagicDNS name and the Serve mappings (path → target), read-only; undefined without Tailscale. */
export function tailnetFacts() {
  const cli = tailscaleCli()
  if (!cli) return undefined
  try {
    const status = JSON.parse(execFileSync(cli, ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }))
    const dnsName = String(status?.Self?.DNSName ?? '').replace(/\.$/, '')
    let serve = {}
    try { serve = JSON.parse(execFileSync(cli, ['serve', 'status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }) || '{}') } catch { /* nothing served */ }
    const mappings = {}
    for (const web of Object.values(serve?.Web ?? {})) {
      for (const [path, handler] of Object.entries(web?.Handlers ?? {})) mappings[path] = handler?.Proxy ?? handler?.Path ?? handler?.Text ?? '?'
    }
    return { dnsName, running: status?.BackendState === 'Running', mappings }
  } catch {
    return undefined
  }
}

/**
 * The Serve path for a variant (LAYOUT.md §7): `/deepsea` for release, `/deepsea-<v>` otherwise; when another
 * target (another account's variant) already holds it, the same with `-<account>` appended.
 */
export function chooseServePath(id, block, facts, account = userInfo().username) {
  const base = id === 'release' ? '/deepsea' : `/deepsea-${id}`
  const ours = target => new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${block + OFFSETS.relay}/?$`).test(String(target))
  const taken = path => facts?.mappings?.[path] !== undefined && !ours(facts.mappings[path])
  if (!taken(base)) return base
  const own = `${base}-${account.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
  if (taken(own)) throw new DsdError(`the Serve paths ${base} and ${own} are both taken by others`)
  return own
}

/** Copy a built app into ~/Applications, replacing only this variant's own app; register it. */
export function installApp(id, builtApp) {
  const target = appPathOf(id)
  if (existsSync(target)) {
    const existing = spawnSync('/usr/bin/defaults', ['read', join(target, 'Contents', 'Info.plist'), 'CFBundleIdentifier'], { encoding: 'utf8' }).stdout.trim()
    if (existing !== variantName(id)) throw new DsdError(`${target} belongs to ${existing || 'something else'}, not ${variantName(id)}; move it away first`)
  }
  mkdirSync(applicationsDir(), { recursive: true })
  const staging = `${target}.staging-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  cpSync(builtApp, staging, { recursive: true, verbatimSymlinks: true })
  rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
  spawnSync(LSREGISTER, ['-f', target], { stdio: 'ignore' })
  return target
}

/** Unregister and delete this variant's app. */
export function removeApp(id) {
  const target = appPathOf(id)
  if (!existsSync(target)) return undefined
  spawnSync(LSREGISTER, ['-u', target], { stdio: 'ignore' })
  rmSync(target, { recursive: true, force: true })
  return target
}

/** `<support>/deepsea-relay`: a link to node, so the relay shows by that name. Node is found on the PATH (a stable link, not a versioned path). */
export function linkRelayNode(supportDir) {
  const which = spawnSync('/bin/sh', ['-lc', 'command -v node'], { encoding: 'utf8' }).stdout.trim()
  const node = which || process.execPath
  const link = join(supportDir, 'deepsea-relay')
  mkdirSync(supportDir, { recursive: true })
  try { if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === node) return { link, node } } catch { /* none */ }
  try { unlinkSync(link) } catch { /* none */ }
  symlinkSync(node, link)
  return { link, node }
}

/** Write the plist and (re)load the job. */
export async function installLaunchAgent(id, programArguments, launchdLog) {
  const label = relayLabelOf(id)
  const plist = launchAgentOf(id)
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  await bootout(label)
  writeFileSync(plist, relayPlist({ label, programArguments, launchdLog }))
  await bootstrap(plist, label)
  return { label, plist }
}

/** Unload and delete the job's plist. */
export async function removeLaunchAgent(id) {
  const stopped = await bootout(relayLabelOf(id))
  const plist = launchAgentOf(id)
  const existed = existsSync(plist)
  rmSync(plist, { force: true })
  return { stopped, plist: existed ? plist : undefined }
}

// ---- the Dock (opt-in) --------------------------------------------------------

/** A persistent-apps entry for an app, as `defaults` takes it. */
export function dockTile(appPath) {
  return `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${xml(`file://${encodeURI(appPath)}/`)}</string><key>_CFURLStringType</key><integer>15</integer></dict></dict><key>tile-type</key><string>file-tile</string></dict>`
}

/** Whether the Dock's persistent apps (`defaults export com.apple.dock -` XML) include an app. */
export function dockHas(dockXml, appPath) {
  return String(dockXml).includes(xml(`file://${encodeURI(appPath)}/`))
}

const dockXml = () => spawnSync('/usr/bin/defaults', ['export', 'com.apple.dock', '-'], { encoding: 'utf8' }).stdout

/** Add a Dock tile for an app unless it has one. */
export function addDockTile(appPath) {
  if (dockHas(dockXml(), appPath)) return false
  execFileSync('/usr/bin/defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', dockTile(appPath)])
  spawnSync('/usr/bin/killall', ['Dock'], { stdio: 'ignore' })
  return true
}

/** Remove an app's Dock tile, if any (through a plist round trip, leaving every other tile as it is). */
export function removeDockTile(appPath) {
  const exported = dockXml()
  if (!dockHas(exported, appPath)) return false
  const python = `import plistlib,sys
d=plistlib.loads(sys.stdin.buffer.read())
url=sys.argv[1]
d['persistent-apps']=[t for t in d.get('persistent-apps',[]) if t.get('tile-data',{}).get('file-data',{}).get('_CFURLString')!=url]
sys.stdout.buffer.write(plistlib.dumps(d))`
  const filtered = execFileSync('/usr/bin/python3', ['-c', python, `file://${encodeURI(appPath)}/`], { input: exported })
  execFileSync('/usr/bin/defaults', ['import', 'com.apple.dock', '-'], { input: filtered })
  spawnSync('/usr/bin/killall', ['Dock'], { stdio: 'ignore' })
  return true
}

/** Remove a Serve path, only when it points at this variant's relay. */
export function removeServePath(path, relayPort) {
  const facts = tailnetFacts()
  const target = facts?.mappings?.[path]
  if (target === undefined) return false
  if (!new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${relayPort}/?$`).test(String(target))) {
    note(`Serve path ${path} points at ${target}, not this variant's relay; left as it is`)
    return false
  }
  execFileSync(tailscaleCli(), ['serve', '--https=443', `--set-path=${path}`, 'off'], { stdio: 'ignore', timeout: 15000 })
  return true
}

