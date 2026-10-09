/**
 * dsd run <v> --throwaway-app | --throwaway-server [--visible] [--detach] [--scripted]
 *   [--plugins <names|all>] [--app <checkout | ref>] [--source <ref>] [--harness <ref>]
 *   [--patch <file>[,<file>…]] [--ttl <minutes>] [--keep] [--timeout <s>]
 *
 * Creates `<parent>-<hex>` with an empty home, starts `dsh web` from the
 * shared build of the harness commit, waits until it answers, and with
 * --throwaway-app also builds the app (lib/app.mjs) and opens it on the
 * server: hidden and focus-free unless --visible, with its automation socket.
 * Prints the facts as JSON. `--plugins` loads this checkout's plugins in
 * place (lib/plugins.mjs); `--scripted` adds the scripted model and makes it
 * the default model; `--patch` adds patch files of the caller's own after
 * the plugins' (config overrides, fixture rows).
 *
 * In the foreground (the default) it stops and removes everything on Ctrl-C,
 * SIGTERM, or when the app quits (with no app: when the server exits; an
 * app outlives its server, so the page after a /reboot can be seen). With
 * --detach it returns; a throwaway app is then watched by a small supervisor
 * (`dsd __supervise`) that removes everything when the app quits, and
 * `dsd stop` ends either kind.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { appSocketOf, appSource, buildThrowawayApp, launchApp, waitAppReady } from '../lib/app.mjs'
import { buildPaths, ensureBuild, harnessRepo, linkHarness, readLock, resolveHarnessCommit } from '../lib/harness.mjs'
import { openRunLog } from '../lib/logs.mjs'
import { preparePlugin, selectPlugins, writePluginPatches } from '../lib/plugins.mjs'
import { homeOf, logDirOf, REPO, variantName } from '../lib/paths.mjs'
import { alive, freePort } from '../lib/processes.mjs'
import { removeVariant } from '../lib/remove.mjs'
import { DsdError, isoLocal, note, onlyFlags, parseArgs, printJson, sleep, usage } from '../lib/util.mjs'
import { checkNamedId, currentOwner, displayName, readVariant, writeState, writeVariant } from '../lib/variants.mjs'

/** The server's entry; with the port, the signature dsd checks before signalling. */
const SERVER_ENTRY = 'apps/cli/src/bin.ts'

/**
 * Rows every throwaway's web profile gets: no telemetry leaves the machine,
 * the first-run "Add an API key" dialog does not cover the page (the Models
 * page still offers every key), and the default workspace is made inside the
 * home (`<home>/documents/…`) instead of the user's Documents folder.
 */
const profilePatch = home => `# written by dsd for throwaway variants
- id: session-log-deepseek
  config:
    enabled: false
- id: session-telemetry-otel
  disabled: true
- id: ui-settings-models
  config:
    credentialOnboarding: false
- id: workspace-controller
  config:
    documentsDirectory: ${JSON.stringify(join(home, 'documents'))}
`

/** Rows for --scripted: the scripted model is the default model. */
const SCRIPTED_PATCH = `- id: agent-default-model
  config:
    provider: scripted
    model: script
`

/** A fresh id `<parent>-<hex>` with no home and no logs yet. */
function newThrowawayId(parent) {
  for (;;) {
    const id = `${parent}-${randomBytes(3).toString('hex')}`
    if (!existsSync(homeOf(id)) && !existsSync(logDirOf(id))) return id
  }
}

/** The welcome-notice version the build's client asks about, so a fresh home does not open on it. */
function welcomeNoticeVersion(build) {
  const file = join(build, 'packages/client/ui-settings-models/src/onboarding-copy.ts')
  return existsSync(file) ? /WELCOME_NOTICE_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1] : undefined
}

/** Create the throwaway's home: configuration, profile patch, settings, links. */
function makeHome(id, { parent, commit, build, expires, scripted, mode }) {
  const home = homeOf(id)
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true, mode: 0o700 })
  const owner = currentOwner()
  writeVariant(id, { id, parent, throwaway: true, mode, harness: commit, created: isoLocal(),
    ownerSession: owner.session, ownerCheckout: owner.checkout, expires })
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), profilePatch(home) + (scripted ? SCRIPTED_PATCH : ''), { mode: 0o600 })
  const notice = welcomeNoticeVersion(build)
  if (notice) writeFileSync(join(home, 'settings.yaml'), `ui-onboarding:\n  welcomeNoticeVersion: '${notice}'\n`, { mode: 0o600 })
  mkdirSync(logDirOf(id), { recursive: true, mode: 0o700 })
  symlinkSync(logDirOf(id), join(home, 'logs'))
  symlinkSync(build, join(home, 'source'))
  return home
}

/** Wait until the log shows the launch URL and the server answers HTTP. */
async function waitReady(child, logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let launch
  while (Date.now() < deadline) {
    if (child.exitCode !== null || !alive(child.pid)) {
      throw new DsdError(`the server exited before it was ready; log: ${logPath}\n${tail(logPath, 25)}`)
    }
    launch ??= /dsh web: (http:\/\/127\.0\.0\.1:\d+\/)\?token=(\S+)/.exec(readFileSync(logPath, 'utf8')) ?? undefined
    if (launch) {
      try {
        await fetch(launch[1], { redirect: 'manual', signal: AbortSignal.timeout(2000) })
        return { url: launch[1], token: launch[2] }
      } catch { /* not answering yet */ }
    }
    await sleep(500)
  }
  throw new DsdError(`no ready server within ${Math.round(timeoutMs / 1000)} s; log: ${logPath}\n${tail(logPath, 25)}`)
}

function tail(path, lines) {
  try { return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).join('\n') } catch { return '' }
}

export async function run(argv) {
  const args = parseArgs(argv, ['source', 'harness', 'timeout', 'plugins', 'ttl', 'app', 'patch'])
  onlyFlags(args, ['throwaway', 'throwaway-app', 'throwaway-server', 'detach', 'source', 'harness', 'keep', 'timeout', 'plugins', 'ttl', 'scripted', 'visible', 'app', 'patch'])
  const extraPatches = typeof args.patch === 'string' ? args.patch.split(',').filter(Boolean).map(f => resolve(f)) : []
  for (const file of extraPatches) if (!existsSync(file)) usage(`--patch: no file ${file}`)
  const parent = args._[0]
  if (parent === undefined || args._.length > 1) usage('dsd run <variant> --throwaway-app | --throwaway-server [--visible] [--detach]')
  checkNamedId(parent)
  const mode = args['throwaway-app'] ? 'app' : args['throwaway-server'] ? 'server' : undefined
  if (mode === undefined) {
    throw new DsdError(args.throwaway
      ? '--throwaway (server, relay and app) needs the relay, which comes with the tailscale plugin; use --throwaway-app or --throwaway-server'
      : 'running a named variant is not built yet; use --throwaway-app or --throwaway-server')
  }
  if (args['throwaway-app'] && args['throwaway-server']) usage('--throwaway-app and --throwaway-server are alternatives')
  if (mode === 'server' && (args.visible || args.app)) usage('--visible and --app are for --throwaway-app')
  const timeoutMs = Number(args.timeout ?? 180) * 1000

  // Which harness: --harness, else the pin of --source (a commit of this repository), else the
  // parent's recorded source, else this checkout's pin.
  const parentConfig = readVariant(parent)
  const sourceRef = args.source ?? parentConfig?.source
  const lock = readLock(sourceRef)
  const repo = harnessRepo(lock)
  const commit = resolveHarnessCommit(args.harness ?? lock.commit, repo)
  const app = mode === 'app' ? appSource(typeof args.app === 'string' ? args.app : undefined) : undefined
  const build = await ensureBuild(commit, repo)
  const plugins = selectPlugins(args.plugins)
  // Every throwaway gets the test driver (dsd drive; it arms only in a throwaway home) and the
  // server log (plugin log messages into the server's log).
  for (const always of ['test-driver', 'server-log', ...(args.scripted ? ['scripted-model'] : [])]) {
    if (!plugins.some(p => p.name === always)) plugins.push(...selectPlugins(always))
  }
  if (plugins.length > 0) {
    await linkHarness()
    for (const plugin of plugins) preparePlugin(plugin)
  }

  // A detached throwaway lives until `dsd stop`, or `dsd gc` after its time limit (--ttl minutes;
  // default 120, none for a visible app: a person's window does not vanish under them).
  const ttl = args.ttl !== undefined ? Number(args.ttl) : args.detach && !args.visible ? 120 : undefined
  if (ttl !== undefined && !(ttl > 0)) usage('--ttl takes a number of minutes')
  const expires = ttl === undefined ? undefined : isoLocal(new Date(Date.now() + ttl * 60_000))
  const id = newThrowawayId(parent)
  const home = makeHome(id, { parent, commit, build, expires, scripted: Boolean(args.scripted), mode })
  const cleanup = async () => removeVariant(id, { keep: Boolean(args.keep) })
  let bundle
  if (app) {
    try { bundle = buildThrowawayApp(id, { source: app, harnessBuild: build }) } catch (error) { await cleanup(); throw error }
  }

  const port = await freePort()
  const log = openRunLog(join(logDirOf(id), 'server'), { tag: 'pending' })
  const env = { ...process.env, DSH_HOME: home }
  // The plugins' own patches, then the caller's: a later layer replaces a row's whole config.
  const patches = [...writePluginPatches(plugins, join(home, 'run', 'plugins')), ...extraPatches]
  const child = spawn(process.execPath, ['--import', 'tsx/esm', SERVER_ENTRY, '--profile', 'web', ...patches.flatMap(p => ['--patch', p]), '--no-open', '--port', String(port)], {
    cwd: build, env, detached: true, stdio: ['ignore', log.fd, log.fd],
  })
  log.identify(`${variantName(id)} server pid ${child.pid} dsh web --port ${port} harness ${commit.slice(0, 10)}${plugins.length ? ` plugins ${plugins.map(p => p.name).join(',')}` : ''}`)
  log.rename(child.pid)
  log.close()
  const signature = [SERVER_ENTRY, `--no-open --port ${port}`]
  const facts = { pid: child.pid, signature, port, log: log.path, started: isoLocal(), harness: commit, build }
  writeState(id, facts)

  let ready
  try {
    ready = await waitReady(child, log.path, timeoutMs)
  } catch (error) {
    await cleanup()
    throw error
  }
  const login = `${ready.url}?token=${ready.token}`
  Object.assign(facts, { url: ready.url, token: ready.token })
  writeState(id, facts)

  let appChild
  let hello
  if (bundle) {
    const launched = launchApp(id, { executable: bundle.executable, url: login, visible: Boolean(args.visible) })
    appChild = launched.child
    facts.app = { pid: appChild.pid, signature: launched.signature, socket: launched.socket, dir: bundle.dir, path: bundle.app, visible: Boolean(args.visible) }
    writeState(id, facts)
    try {
      hello = await waitAppReady(appChild, launched.socket, timeoutMs)
    } catch (error) {
      await cleanup()
      throw error
    }
    facts.app.log = hello.log
    writeState(id, facts)
  }

  if (args.detach && bundle) {
    // Watch the app, so quitting it removes everything (commands/supervise.mjs).
    const supervisorLog = openRunLog(join(logDirOf(id), 'dsd'), { tag: 'pending' })
    const supervisor = spawn(process.execPath, [join(REPO, 'tools', 'dsd', 'bin', 'dsd.mjs'), '__supervise', id], {
      detached: true, stdio: ['ignore', supervisorLog.fd, supervisorLog.fd], env: process.env,
    })
    supervisorLog.identify(`${variantName(id)} dsd supervisor pid ${supervisor.pid}`)
    supervisorLog.rename(supervisor.pid)
    supervisorLog.close()
    facts.supervisor = { pid: supervisor.pid, signature: ['__supervise', id] }
    writeState(id, facts)
    supervisor.unref()
  }

  printJson({
    id, name: variantName(id), display: displayName(id), home, mode,
    url: ready.url, login, token: ready.token,
    pid: child.pid, port, log: log.path, harness: commit.slice(0, 10), plugins: plugins.map(p => p.name), detached: Boolean(args.detach), expires,
    ...(bundle ? { app: { path: bundle.app, pid: appChild.pid, socket: appSocketOf(id), log: hello.log, visible: Boolean(args.visible), source: app.describe } } : {}),
  })

  if (args.detach) { child.unref(); appChild?.unref(); return }
  note(`${id} running; Ctrl-C${bundle ? ', quitting the app' : ''} or \`dsd stop ${id}\` stops it${args.keep ? '' : ' and removes it'}`)
  await new Promise((resolve) => {
    let stopping = false
    let watch
    const stop = async () => {
      if (stopping) return
      stopping = true
      clearInterval(watch)
      await cleanup()
      resolve()
    }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop)
    // With an app, the app decides: after a /reboot or /restore its page shows what happened, so
    // the throwaway stays until the app quits. Without one, the server's exit ends it.
    let serverGone = false
    watch = setInterval(() => {
      if (appChild && !alive(appChild.pid)) { note(`${id}: the app quit`); void stop() }
      else if (!serverGone && !alive(child.pid)) {
        serverGone = true
        if (appChild) note(`${id}: the server exited; the app stays until it quits, Ctrl-C or \`dsd stop ${id}\``)
        else { note(`${id}: the server exited`); void stop() }
      }
    }, 1000)
  })
  // `dsd stop` from elsewhere may already have removed the home; nothing else to do.
  if (existsSync(home) && !args.keep) rmSync(home, { recursive: true, force: true })
  process.exit(0)
}
