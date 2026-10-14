/**
 * Z.ai (GLM), as DeepSea's stack calls it: pi-ai's `zai` provider
 * (`openai-completions` at the GLM Coding Plan endpoint, `ZAI_API_KEY`) and
 * `zai-coding-cn` (the same at open.bigmodel.cn, `ZAI_CODING_CN_API_KEY`),
 * with pi-ai's Z.ai options: `thinking: { type }`, `reasoning_effort`, and
 * `tool_stream` (`zaiToolStream`), which streams tool arguments in pieces.
 *
 * api.z.ai, open.bigmodel.cn  POST /api/coding/paas/v4/chat/completions (streamed
 *                  and whole), GET /api/coding/paas/v4/models.
 *
 * A key names an account with a balance in micro-dollars, spent at the
 * catalog's prices (pi-ai prices the coding endpoint's models; none left:
 * Z.ai's 429 code 1113), and a GLM Coding Plan: every request counts against
 * its five-hour prompt quota (full: 429 code 1308, "Usage limit reached for 5
 * hour…"), which is all the catalog's free models (the `-highspeed` ones) need.
 * Errors are Z.ai's: `{ error: { code, message } }`, the code a string.
 */
import { bearer, STARTING_MICROS } from '../common.mjs'
import { playCompletion } from '../wire-completions.mjs'

/** GLM Coding Plans: prompts per five hours, as Z.ai publishes them. */
export const PLANS = { lite: { label: 'Lite', prompts: 120 }, pro: { label: 'Pro', prompts: 600 }, max: { label: 'Max', prompts: 2400 } }
export const DEFAULT_PLAN = 'pro'
const WINDOW_MS = 5 * 3600_000
const BASE = '/api/coding/paas/v4'

/** A new account's state: a balance and a Coding Plan. */
export function zaiState() {
  return { balanceMicros: STARTING_MICROS, plan: DEFAULT_PLAN, window: { used: 0, start: null } }
}

/** The five-hour window at `now`: emptied once it has ended, started now if used without a start. */
export function settle(state, now = Date.now()) {
  const window = { used: 0, start: null, ...state.window }
  if (window.start !== null && now >= Date.parse(window.start) + WINDOW_MS) Object.assign(window, { used: 0, start: null })
  if (window.used > 0 && window.start === null) window.start = new Date(now).toISOString()
  return { ...state, plan: PLANS[state.plan] ? state.plan : DEFAULT_PLAN, window }
}

/** A time as Z.ai writes it in its messages: `YYYY-MM-DD HH:MM:SS`, Beijing time. */
const flushTime = ms => new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
/** Z.ai's response ids: the time, then hex. */
const idPrefix = () => new Date(Date.now() + 8 * 3600_000).toISOString().replace(/\D/g, '').slice(0, 14)

/** Z.ai's error body. */
function zaiError(ctx, res, status, code, message, headers = {}) {
  ctx.json(res, status, { error: { code: String(code), message } }, headers)
}

/** The script's error kinds as Z.ai's business codes. */
const CODES = { 'rate-limit': 1302, overloaded: 1305, server: 500, timeout: 1234, network: 1234, auth: 1000, quota: 1113, 'context-length': 1261, 'invalid-request': 1214, invalid_request_error: 1214 }

function create(ctx, catalog) {
  const store = ctx.store
  return async (req, res, path, body, host) => {
    const provider = host === 'open.bigmodel.cn' ? 'zai-coding-cn' : 'zai'
    const key = bearer(req)
    if (!key) return zaiError(ctx, res, 401, 1001, 'Authentication parameter not received in Header, unable to authenticate')
    const account = store.update(store.account('zai', 'key', key, zaiState).id, s => settle(s))
    if (req.method === 'POST' && path === `${BASE}/chat/completions`) {
      const known = catalog.models(provider)
      const model = known.find(m => m.id === body.model)
      if (known.length > 0 && !model) return zaiError(ctx, res, 400, 1211, 'Unknown Model, please check the model code.')
      const { window } = account.state
      if (window.used >= PLANS[account.state.plan].prompts) return zaiError(ctx, res, 429, 1308, `Usage limit reached for 5 hour. Your limit will reset at ${flushTime(Date.parse(window.start) + WINDOW_MS)}`)
      const priced = (model?.cost?.input ?? 0) > 0 || (model?.cost?.output ?? 0) > 0
      if (priced && account.state.balanceMicros <= 0) return zaiError(ctx, res, 429, 1113, 'Insufficient balance or no resource package. Please recharge.')
      const charge = (micros) => {
        const now = Date.now()
        store.update(account.id, (s) => {
          const settled = settle(s, now)
          settled.window.used += 1
          settled.window.start ??= new Date(now).toISOString()
          return { ...settled, balanceMicros: settled.balanceMicros - micros }
        })
      }
      const fail = (status, kind, message, headers) => zaiError(ctx, res, status, CODES[kind] ?? kind, message, headers)
      return playCompletion(ctx, { res, body, dialect: 'zai', account, provider, catalog, charge, idPrefix: idPrefix(), fail })
    }
    if (req.method === 'GET' && path === `${BASE}/models`) {
      return ctx.json(res, 200, { object: 'list', data: catalog.models(provider).map(m => ({ id: m.id, object: 'model', created: 1735689600, owned_by: 'z-ai' })) })
    }
    return zaiError(ctx, res, 404, 1222, `API ${path} does not exist`)
  }
}

export const name = 'zai'
export const hosts = ['api.z.ai', 'open.bigmodel.cn']
/** A new account's state. */
export const initialState = () => zaiState()

export default { name, hosts, initialState, create }
