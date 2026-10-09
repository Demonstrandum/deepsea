/**
 * dsd drive [-v <ref>] <op> … — one operation on a running throwaway, through
 * its test driver (plugins/test-driver), printed as JSON.
 *
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
 * <session> is a session id, or `last`: the session the last create-session
 * on this throwaway made. `-` reads the prompt from stdin (a scripted-model
 * script, say). Exit status: 0; 3 when a waited turn ended with an error;
 * 4 when the wait timed out.
 */
import { request } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeOf } from '../lib/paths.mjs'
import { readState, resolveRef } from '../lib/variants.mjs'
import { DsdError, onlyFlags, parseArgs, printJson, usage } from '../lib/util.mjs'

const USAGE = 'dsd drive [-v <ref>] health | create-session | prompt | command | wait | events | cancel | sessions | invoke | url (tools/dsd/README.md)'
const LAST_SESSION = 'run/drive-last-session'

/** POST one operation to the throwaway's test driver; resolve its value or throw its error. */
function post(driver, op, body) {
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

/** The test driver of a running throwaway. */
function driverOf(variant) {
  if (!variant.throwaway) throw new DsdError(`${variant.id} is not a throwaway; dsd drive only drives throwaways`)
  if (!variant.running) throw new DsdError(`${variant.id} is not running`)
  const file = join(homeOf(variant.id), 'run', 'test-driver.json')
  if (!existsSync(file)) throw new DsdError(`${variant.id} has no test driver (${file} missing): it started without plugins/test-driver, or the plugin failed to load (see its log)`)
  return JSON.parse(readFileSync(file, 'utf8'))
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
  const args = parseArgs(argv.map(a => (a === '-v' ? '--variant' : a)), ['variant', 'cwd', 'preset', 'model', 'title', 'timeout', 'since', 'types', 'limit'])
  onlyFlags(args, ['variant', 'cwd', 'preset', 'model', 'title', 'timeout', 'since', 'types', 'limit', 'no-wait', 'steer'])
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
  if (op === 'url') {
    const state = readState(variant.id)
    return printJson({ id: variant.id, url: state?.url, login: state?.url && state?.token ? `${state.url}?token=${state.token}` : undefined })
  }
  const driver = driverOf(variant)
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
