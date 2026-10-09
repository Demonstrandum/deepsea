/**
 * dsd run <v> --throwaway-server [--detach] [--plugins <names|all>] [--source <ref>] [--harness <ref>] [--keep] [--timeout <s>]
 *
 * Stage 1: throwaway servers only. Creates `<parent>-<hex>` with an empty
 * home, starts `dsh web` from the shared build of the harness commit, waits
 * until it answers, and prints its facts as JSON. `--plugins` loads this
 * checkout's plugins in place (lib/plugins.mjs). In the foreground (the
 * default) it stops and cleans up on Ctrl-C, SIGTERM or the server's exit;
 * with --detach it returns and `dsd stop` ends it.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { buildPaths, ensureBuild, harnessRepo, linkHarness, readLock, resolveHarnessCommit } from '../lib/harness.mjs'
import { openRunLog } from '../lib/logs.mjs'
import { preparePlugin, selectPlugins, writePluginPatches } from '../lib/plugins.mjs'
import { homeOf, logDirOf, variantName } from '../lib/paths.mjs'
import { alive, freePort } from '../lib/processes.mjs'
import { removeVariant } from '../lib/remove.mjs'
import { DsdError, isoLocal, note, onlyFlags, parseArgs, printJson, sleep, usage } from '../lib/util.mjs'
import { checkNamedId, displayName, readVariant, writeState, writeVariant } from '../lib/variants.mjs'

/** The server's entry; with the port, the signature dsd checks before signalling. */
const SERVER_ENTRY = 'apps/cli/src/bin.ts'

/**
 * Rows every throwaway's web profile gets: no telemetry leaves the machine,
 * and the first-run "Add an API key" dialog does not cover the page (the
 * Models page still offers every key).
 */
const PROFILE_PATCH = `# written by dsd for throwaway variants
- id: session-log-deepseek
  config:
    enabled: false
- id: session-telemetry-otel
  disabled: true
- id: ui-settings-models
  config:
    credentialOnboarding: false
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
function makeHome(id, { parent, commit, build }) {
  const home = homeOf(id)
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true, mode: 0o700 })
  writeVariant(id, { id, parent, throwaway: true, mode: 'server', harness: commit, created: isoLocal() })
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), PROFILE_PATCH, { mode: 0o600 })
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
  const args = parseArgs(argv, ['source', 'harness', 'timeout', 'plugins'])
  onlyFlags(args, ['throwaway', 'throwaway-app', 'throwaway-server', 'detach', 'source', 'harness', 'keep', 'timeout', 'plugins'])
  const parent = args._[0]
  if (parent === undefined || args._.length > 1) usage('dsd run <variant> --throwaway-server [--detach]')
  checkNamedId(parent)
  if (!args['throwaway-server']) {
    throw new DsdError(args.throwaway || args['throwaway-app']
      ? 'only --throwaway-server exists so far (apps and relays come with apps/macos)'
      : 'running a named variant is not built yet; use --throwaway-server')
  }

  // Which harness: --harness, else the pin of --source (a commit of this repository), else the
  // parent's recorded source, else this checkout's pin.
  const parentConfig = readVariant(parent)
  const sourceRef = args.source ?? parentConfig?.source
  const lock = readLock(sourceRef)
  const repo = harnessRepo(lock)
  const commit = resolveHarnessCommit(args.harness ?? lock.commit, repo)
  const build = await ensureBuild(commit, repo)
  const plugins = selectPlugins(args.plugins)
  if (plugins.length > 0) {
    await linkHarness()
    for (const plugin of plugins) preparePlugin(plugin)
  }

  const id = newThrowawayId(parent)
  const home = makeHome(id, { parent, commit, build })
  const port = await freePort()
  const log = openRunLog(join(logDirOf(id), 'server'))
  const env = { ...process.env, DSH_HOME: home }
  const patches = writePluginPatches(plugins, join(home, 'run', 'plugins'))
  const child = spawn(process.execPath, ['--import', 'tsx/esm', SERVER_ENTRY, '--profile', 'web', ...patches.flatMap(p => ['--patch', p]), '--no-open', '--port', String(port)], {
    cwd: build, env, detached: true, stdio: ['ignore', log.fd, log.fd],
  })
  log.identify(`${variantName(id)} server pid ${child.pid} dsh web --port ${port} harness ${commit.slice(0, 10)}${plugins.length ? ` plugins ${plugins.map(p => p.name).join(',')}` : ''}`)
  log.name(child.pid)
  log.close()
  const signature = [SERVER_ENTRY, `--no-open --port ${port}`]
  writeState(id, { pid: child.pid, signature, port, log: log.path, started: isoLocal(), harness: commit, build: buildPaths(commit).dir })

  const cleanup = async () => removeVariant(id, { keep: Boolean(args.keep) })
  let ready
  try {
    ready = await waitReady(child, log.path, Number(args.timeout ?? 180) * 1000)
  } catch (error) {
    await cleanup()
    throw error
  }
  writeState(id, { pid: child.pid, signature, port, url: ready.url, token: ready.token, log: log.path, started: isoLocal(), harness: commit, build })
  printJson({
    id, name: variantName(id), display: displayName(id), home, mode: 'server',
    url: ready.url, login: `${ready.url}?token=${ready.token}`, token: ready.token,
    pid: child.pid, port, log: log.path, harness: commit.slice(0, 10), plugins: plugins.map(p => p.name), detached: Boolean(args.detach),
  })

  if (args.detach) { child.unref(); return }
  note(`${id} running; Ctrl-C or \`dsd stop ${id}\` stops it${args.keep ? '' : ' and removes its home'}`)
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
    watch = setInterval(() => {
      if (!alive(child.pid)) { note(`${id}: the server exited`); void stop() }
    }, 1000)
  })
  // `dsd stop` from elsewhere may already have removed the home; nothing else to do.
  if (existsSync(home) && !args.keep) rmSync(home, { recursive: true, force: true })
  process.exit(0)
}
