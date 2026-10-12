/**
 * dsd drive [-v <ref>] <op> … — one operation on a running throwaway, printed
 * as JSON. Server operations go to its test driver (plugins/test-driver), app
 * operations to its app's automation socket (apps/macos, Automation.swift).
 *
 * Server:
 *   health
 *   create-session [--cwd <dir>] [--preset <name>] [--model <provider/model[:effort]>] [--title <t>]
 *   prompt <session> <text | -> [--no-wait] [--steer] [--timeout <s>]
 *   command <session> <line>
 *   wait <session> [--since <seq>] [--timeout <s>]
 *   events <session> [--since <seq>] [--types <a,b/*>] [--limit <n>]
 *   cancel <session>
 *   sessions
 *   invoke <namespace> <method> [<json args>]
 *   url
 *
 * App (a throwaway started with --throwaway-app):
 *   load <url> | reload
 *   wait-page [--selector <css>] [--text <t>] [--expression <js>] [--timeout <s>] [--settle <ms>]
 *   eval <js | ->                         a function body (await allowed); its JSON value
 *   resize <W>x<H> | view desktop|mobile | appearance light|dark|system
 *   click <css> [--nth <n>] [--clicks <n>] | click --text <label> [<css>] | click --x <x> --y <y>
 *   type <text | -> | type --key <Enter | Escape | cmd+k | …>
 *   describe <css> [--nth <n>]            the element inspector's record
 *   snapshot [<css> [--nth <n>]] [--window] [--chrome]
 *   window-info | app-log [--lines <n>] | opened [--clear] | quit
 *
 * <session> is a session id, or `last`: the session the last create-session
 * on this throwaway made. `-` reads the prompt from stdin (a scripted-model
 * script, say). Exit status: 0; 3 when a waited turn ended with an error;
 * 4 when the wait timed out.
 */
import { request } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeOf } from '../lib/paths.mjs'
import { appRequest } from '../lib/appsocket.mjs'
import { alive } from '../lib/processes.mjs'
import { readState, resolveRef } from '../lib/variants.mjs'
import { DsdError, onlyFlags, parseArgs, printJson, sleep, usage } from '../lib/util.mjs'

const USAGE = 'dsd drive [-v <ref>] <op> …  server: health create-session prompt command wait events cancel sessions invoke url; app: load reload wait-page eval resize view appearance click type describe snapshot window-info app-log opened quit (tools/dsd/README.md)'
const APP_OPS = new Set(['load', 'reload', 'wait-page', 'eval', 'resize', 'view', 'appearance', 'click', 'type', 'describe', 'snapshot', 'window-info', 'app-log', 'opened', 'quit'])
const LAST_SESSION = 'run/drive-last-session'

/** POST one operation to the throwaway's test driver; resolve its value or throw its error. */
export function post(driver, op, body) {
  const url = new URL(`${driver.channel}/${op}`, driver.baseUrl)
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { authorization: `Bearer ${driver.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let reply
        try { reply = JSON.parse(text) } catch { reject(new DsdError(`test driver answered ${res.statusCode} with non-JSON: ${text.slice(0, 200)}`)); return }
        if (reply.ok) resolve(reply.value)
        else reject(new DsdError(`${op}: ${reply.error?.code ?? res.statusCode}: ${reply.error?.message ?? text}`))
      })
    })
    req.on('error', error => reject(new DsdError(`cannot reach the test driver at ${url.origin}: ${error.message}`)))
    req.end(payload)
  })
}

/** The test driver's endpoint file, when the server that wrote it is still running. */
function currentDriver(file) {
  try {
    const driver = JSON.parse(readFileSync(file, 'utf8'))
    return driver.pid !== undefined && alive(driver.pid) ? driver : undefined
  } catch {
    return undefined
  }
}

/**
 * The test driver of a running throwaway. Behind a relay the server comes and goes (`/reboot`,
 * `/restore`, a crash): each start writes a new endpoint with a new token, and the relay starts
 * the server on the next connection, so the driver is asked for after a knock on the relay.
 */
export async function driverOf(variant, timeoutMs = 90_000) {
  if (!variant.throwaway) throw new DsdError(`${variant.id} is not a throwaway; dsd drive only drives throwaways`)
  if (!variant.running) throw new DsdError(`${variant.id} is not running`)
  const file = join(homeOf(variant.id), 'run', 'test-driver.json')
  const relay = variant.state?.relay
  if (relay === undefined) {
    if (!existsSync(file)) throw new DsdError(`${variant.id} has no test driver (${file} missing): it started without plugins/test-driver, or the plugin failed to load (see its log)`)
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const driver = currentDriver(file)
    if (driver !== undefined) return driver
    if (Date.now() > deadline) throw new DsdError(`${variant.id}: no test driver within ${Math.round(timeoutMs / 1000)} s of asking the relay to start the server (see dsd logs ${variant.id})`)
    try { await fetch(relay.url, { method: 'HEAD', signal: AbortSignal.timeout(2000) }) } catch { /* the relay answers or starts it either way */ }
    await sleep(500)
  }
}

const readStdin = () => readFileSync(0, 'utf8')
const seconds = (value, name) => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!(n > 0)) usage(`--${name} takes seconds`)
  return n * 1000
}

export async function drive(argv) {
  // `-v <ref>` is short for `--variant <ref>`.
  const valued = ['variant', 'cwd', 'preset', 'model', 'title', 'timeout', 'since', 'types', 'limit', 'nth', 'clicks', 'x', 'y', 'key', 'selector', 'text', 'expression', 'settle', 'lines']
  const args = parseArgs(argv.map(a => (a === '-v' ? '--variant' : a)), valued)
  onlyFlags(args, [...valued, 'no-wait', 'steer', 'window', 'chrome', 'clear'])
  const [op, ...rest] = args._
  if (op === undefined) usage(USAGE)
  const variant = resolveRef(args.variant)
  const home = homeOf(variant.id)
  const session = (value) => {
    if (value === undefined) usage(`dsd drive ${op} <session id | last>`)
    if (value !== 'last') return value
    const file = join(home, LAST_SESSION)
    if (!existsSync(file)) throw new DsdError('no session made by dsd drive create-session on this throwaway yet')
    return readFileSync(file, 'utf8').trim()
  }
  if (APP_OPS.has(op)) return printJson(await appOp(variant, op, rest, args))
  if (op === 'url') {
    const state = readState(variant.id)
    return printJson({ id: variant.id, url: state?.url, login: state?.url && state?.token ? `${state.url}?token=${state.token}` : undefined })
  }
  const driver = await driverOf(variant)
  switch (op) {
    case 'health': return printJson(await post(driver, 'health', {}))
    case 'sessions': return printJson(await post(driver, 'sessions', {}))
    case 'create-session': {
      const value = await post(driver, 'create-session', {
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.preset === undefined ? {} : { preset: args.preset }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.title === undefined ? {} : { title: args.title }),
      })
      writeFileSync(join(home, LAST_SESSION), `${value.sessionId}\n`, { mode: 0o600 })
      return printJson(value)
    }
    case 'prompt': {
      const sessionId = session(rest[0])
      if (rest.length !== 2) usage('dsd drive prompt <session> <text | -> [--no-wait] [--steer] [--timeout <s>]')
      const text = rest[1] === '-' ? readStdin() : rest[1]
      const value = await post(driver, 'prompt', { sessionId, text, wait: !args['no-wait'], mode: args.steer ? 'steer' : 'queue', ...(args.timeout === undefined ? {} : { timeoutMs: seconds(args.timeout, 'timeout') }) })
      printJson(value)
      return exitFor(value)
    }
    case 'wait': {
      const value = await post(driver, 'wait', { sessionId: session(rest[0]), ...(args.since === undefined ? {} : { since: Number(args.since) }), ...(args.timeout === undefined ? {} : { timeoutMs: seconds(args.timeout, 'timeout') }) })
      printJson(value)
      return exitFor(value)
    }
    case 'command': {
      if (rest.length !== 2) usage('dsd drive command <session> <line>')
      return printJson(await post(driver, 'command', { sessionId: session(rest[0]), line: rest[1] }))
    }
    case 'events': return printJson(await post(driver, 'events', {
      sessionId: session(rest[0]),
      ...(args.since === undefined ? {} : { since: Number(args.since) }),
      ...(args.types === undefined ? {} : { types: String(args.types).split(',') }),
      ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
    }))
    case 'cancel': return printJson(await post(driver, 'cancel', { sessionId: session(rest[0]) }))
    case 'invoke': {
      if (rest.length < 2 || rest.length > 3) usage('dsd drive invoke <namespace> <method> [<json args>]')
      let parsed = {}
      if (rest[2] !== undefined) { try { parsed = JSON.parse(rest[2]) } catch (error) { usage(`invoke args are not JSON: ${error.message}`) } }
      return printJson(await post(driver, 'invoke', { namespace: rest[0], method: rest[1], args: parsed }))
    }
    default: usage(`unknown drive operation "${op}"\n${USAGE}`)
  }
}

/** Exit 3 when a waited turn ended with an error, 4 when the wait timed out. */
function exitFor(value) {
  if (value?.idle === false) process.exitCode = 4
  else if (value?.summary?.turnEnd?.kind === 'error') process.exitCode = 3
}

/** One app operation over the throwaway app's automation socket. */
async function appOp(variant, op, rest, args) {
  const app = readState(variant.id)?.app
  if (!app?.socket) throw new DsdError(`${variant.id} has no app (it was started with --throwaway-server)`)
  const one = (what) => { if (rest.length !== 1) usage(`dsd drive ${op} <${what}>`); return rest[0] }
  const count = (name) => {
    if (args[name] === undefined) return {}
    const n = Number(args[name])
    if (!Number.isInteger(n)) usage(`--${name} takes a whole number`)
    return { [name]: n }
  }
  const target = () => rest.length === 1 ? { selector: rest[0], ...count('nth') } : rest.length === 0 && args.x !== undefined && args.y !== undefined ? { x: Number(args.x), y: Number(args.y) } : usage(`dsd drive ${op} <css selector> [--nth <n>]`)
  const send = (name, body = {}, timeoutMs) => appRequest(app.socket, name, body, timeoutMs ? { timeoutMs } : undefined)
  switch (op) {
    case 'load': return send('load', { url: one('url') })
    case 'reload': return send('reload')
    case 'wait-page': {
      const body = { ...(args.selector ? { selector: args.selector } : {}), ...(args.text ? { text: args.text } : {}), ...(args.expression ? { expression: args.expression } : {}) }
      if (Object.keys(body).length === 0) usage('dsd drive wait-page --selector <css> | --text <t> | --expression <js>')
      const timeout = seconds(args.timeout, 'timeout') ?? 15_000
      return send('wait-page', { ...body, timeoutMs: timeout, ...(args.settle ? { settleMs: Number(args.settle) } : {}) }, timeout + 10_000)
    }
    case 'eval': { const js = one('js | -'); return send('eval', { js: js === '-' ? readStdin() : js }) }
    case 'resize': {
      const m = /^(\d+)x(\d+)$/.exec(one('W>x<H'))
      if (!m) usage('dsd drive resize <width>x<height>, e.g. 1280x860')
      return send('resize', { width: Number(m[1]), height: Number(m[2]) })
    }
    case 'view': return send('view', { mode: one('desktop | mobile') })
    case 'appearance': return send('appearance', { value: one('light | dark | system') })
    case 'click': {
      if (args.text !== undefined) { if (rest.length > 1) usage('dsd drive click --text <label> [<css scope>]'); return send('click', { text: args.text, ...(rest[0] ? { selector: rest[0] } : {}), ...count('nth'), ...count('clicks') }) }
      return send('click', { ...target(), ...count('clicks') })
    }
    case 'type': {
      if (args.key !== undefined) { if (rest.length) usage('dsd drive type --key <key> takes no text'); return send('type', { key: args.key }) }
      const text = one('text | -')
      return send('type', { text: text === '-' ? readStdin() : text })
    }
    case 'describe': return send('describe', target())
    case 'snapshot': {
      if (args.window) { if (rest.length) usage('dsd drive snapshot --window takes no selector'); return send('snapshot', { window: true, ...(args.chrome ? { chrome: true } : {}) }) }
      return send('snapshot', target())
    }
    case 'window-info': return send('window-info')
    case 'app-log': return send('log', count('lines'))
    case 'opened': return send('opened', args.clear ? { clear: true } : {})
    case 'quit': return send('quit')
  }
  return undefined
}
