/**
 * The provider simulator (tools/provider-sim): one per machine and account,
 * shared by every throwaway and agent, started on demand and left running.
 *
 *   ~/.deepsea/_sim/sim.sqlite   accounts and generations (the simulator's store)
 *   ~/.deepsea/_sim/sim.json     { pid, url, started } of the running simulator
 *   <machine logs>/sim/          its run logs
 *
 * Test accounts (tools/provider-sim/accounts.json) are named starting points:
 * `--accounts openrouter,deepseek-empty` gives a throwaway fresh accounts in
 * those states, its credentials suffixed with the throwaway's id so no two
 * throwaways share one; `name=<credential>` uses that credential as it is (a
 * persistent account, created on first use).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { takeLock } from './harness.mjs'
import { openRunLog } from './logs.mjs'
import { deepseaRoot, machineLogDir, REPO } from './paths.mjs'
import { alive } from './processes.mjs'
import { DsdError, isoLocal, note, sleep } from './util.mjs'

export const simDir = () => join(deepseaRoot(), '_sim')
const stateFile = () => join(simDir(), 'sim.json')
const SERVER = () => join(REPO, 'tools', 'provider-sim', 'server.mjs')
const FIXTURES = () => join(REPO, 'tools', 'provider-sim', 'accounts.json')

/** The running simulator's facts, or undefined. */
export async function simStatus() {
  if (!existsSync(stateFile())) return undefined
  let state
  try { state = JSON.parse(readFileSync(stateFile(), 'utf8')) } catch { return undefined }
  if (!alive(state.pid)) return undefined
  try {
    const response = await fetch(`${state.url}/_sim/status`, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return undefined
    return { ...state, ...(await response.json()) }
  } catch { return undefined }
}

/** pi-ai's generated catalog in a harness build: the models and prices the simulator serves. */
function catalogDir(harnessBuild) {
  const dir = join(harnessBuild, 'packages', 'llm', 'llm-pi-ai', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers')
  return existsSync(dir) ? dir : undefined
}

/** Make sure the simulator runs (starting it with the catalog of `harnessBuild`); returns its facts. */
export async function ensureSim(harnessBuild) {
  const running = await simStatus()
  if (running) return running
  mkdirSync(simDir(), { recursive: true, mode: 0o700 })
  const lock = join(simDir(), 'start.lock')
  for (let i = 0; ; i++) {
    const { held } = takeLock(lock)
    if (held === undefined) break
    if (i > 60) throw new DsdError(`another dsd (pid ${held}) has been starting the simulator for a minute`)
    await sleep(1000)
    const started = await simStatus()
    if (started) return started
  }
  try {
    const again = await simStatus()
    if (again) return again
    const log = openRunLog(join(machineLogDir(), 'sim'), { tag: 'pending', identity: `provider simulator started by dsd pid ${process.pid}` })
    const catalog = harnessBuild ? catalogDir(harnessBuild) : undefined
    const args = [SERVER(), '--db', join(simDir(), 'sim.sqlite'), '--port', '0', ...(catalog ? ['--catalog', catalog] : [])]
    const out = join(simDir(), 'start.out')
    rmSync(out, { force: true })
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', openSync(out, 'w'), log.fd] })
    child.unref()
    log.rename(child.pid)
    log.close()
    let url
    for (let i = 0; i < 100 && !url; i++) {
      await sleep(100)
      if (child.exitCode !== null) throw new DsdError(`the simulator exited at start; log: ${log.path}`)
      url = existsSync(out) ? readFileSync(out, 'utf8').split('\n')[0].trim() || undefined : undefined
    }
    if (!url) throw new DsdError(`the simulator did not start; log: ${log.path}`)
    writeFileSync(stateFile(), `${JSON.stringify({ pid: child.pid, url, started: isoLocal(), log: log.path }, null, 2)}\n`, { mode: 0o600 })
    note(`provider simulator on ${url} (log: ${log.path})`)
    return await simStatus()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** Stop the simulator, if it runs. */
export async function stopSim() {
  const running = await simStatus()
  if (!running) return false
  process.kill(running.pid, 'SIGTERM')
  for (let i = 0; i < 50 && alive(running.pid); i++) await sleep(100)
  rmSync(stateFile(), { force: true })
  return true
}

/** The named test accounts. */
export function fixtures() {
  return JSON.parse(readFileSync(FIXTURES(), 'utf8')).accounts
}

/**
 * Accounts for a throwaway: each `name` or `name=<credential>` resolved,
 * created (or reset to the fixture's state when fresh) in the simulator.
 * @returns {Promise<Array<{ name, provider, credential, env, settings? }>>}
 */
export async function provisionAccounts(sim, spec, suffix) {
  const known = fixtures()
  const out = []
  for (const item of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    const [name, given] = item.split('=')
    const fixture = known[name]
    if (!fixture) throw new DsdError(`no test account "${name}" (have: ${Object.keys(known).join(', ')})`)
    const credential = given ?? `${fixture.credential}-${suffix}`
    const response = await fetch(`${sim.url}/_sim/account`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: fixture.provider, kind: 'key', credential, ...(given === undefined && fixture.state ? { state: fixture.state } : {}) }),
    })
    if (!response.ok) throw new DsdError(`the simulator refused account ${name}: ${await response.text()}`)
    out.push({ name, provider: fixture.provider, credential, env: fixture.env, settings: fixture.settings })
  }
  return out
}
