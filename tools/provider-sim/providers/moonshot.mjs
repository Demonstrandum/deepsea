/**
 * Moonshot AI (the Kimi API) and Kimi Code, as DeepSea's stack calls them:
 * pi-ai's `moonshotai` and `moonshotai-cn` providers (`openai-completions`,
 * `MOONSHOT_API_KEY`) and its `kimi-coding` provider (`anthropic-messages`,
 * a Kimi Code key `KIMI_API_KEY` or the Kimi Code sign-in of
 * `auth/oauth/kimi-coding.js`, an RFC 8628 device-code grant).
 *
 * api.moonshot.ai, api.moonshot.cn  POST /v1/chat/completions (streamed and whole), GET /v1/models.
 * api.kimi.com     POST /coding/v1/messages (streamed and whole), GET /coding/v1/models.
 * auth.kimi.com    POST /api/oauth/device_authorization, POST /api/oauth/token
 *                  (device_code and refresh_token grants).
 * www.kimi.com     GET /code/authorize_device?user_code= (the page where a person
 *                  enters the code and an email), POST it to allow or deny.
 *
 * A key names an account with a balance in micro-dollars, spent at catalog
 * prices on the Kimi API (none left: Moonshot's 429
 * `exceeded_current_quota_error`), and a Kimi Code plan when used on
 * api.kimi.com. An email signed in through the device page names a Kimi Code
 * Plan account. Kimi Code is a subscription: every request counts against the
 * plan's five-hour request quota (full: Kimi Code's 403 "You've reached your
 * 5-hour usage limit…"), and models above the plan answer Kimi Code's 401.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { bearer, generate, STARTING_MICROS } from '../common.mjs'
import { playCompletion } from '../wire-completions.mjs'

/** Kimi Code plans: requests per five hours, and the models only higher plans reach. */
export const PLANS = {
  go: { label: 'Go', requests: 50, denied: ['k3', 'k3-256k', 'kimi-for-coding-highspeed'] },
  plus: { label: 'Plus', requests: 200, denied: ['kimi-for-coding-highspeed'] },
  pro: { label: 'Pro', requests: 800, denied: [] },
  max: { label: 'Max', requests: 2000, denied: [] },
  ultra: { label: 'Ultra', requests: 5000, denied: [] },
}
export const DEFAULT_PLAN = 'pro'
const WINDOW_MS = 5 * 3600_000
/** Access tokens live fifteen minutes; refresh tokens until used; a device code half an hour. */
export const ACCESS_SECONDS = 900
const DEVICE_SECONDS = 1800
const POLL_SECONDS = 5
const SCOPE = 'kimi-code'
const VERIFICATION_URI = 'https://www.kimi.com/code/authorize_device'

/** A new account's state: a balance and a plan for a key, a plan for an email. */
export function moonshotState(kind, credential) {
  const plan = { plan: DEFAULT_PLAN, window: { used: 0, start: null } }
  if (kind === 'email') return { ...plan, uuid: randomUUID() }
  return { balanceMicros: STARTING_MICROS, uid: `d${createHash('sha256').update(credential).digest('hex').slice(0, 19)}`, ...plan }
}

/** A plan's five-hour window at `now`: emptied once it has ended, started now if used without a start. */
export function settle(state, now = Date.now()) {
  const window = { used: 0, start: null, ...state.window }
  if (window.start !== null && now >= Date.parse(window.start) + WINDOW_MS) Object.assign(window, { used: 0, start: null })
  if (window.used > 0 && window.start === null) window.start = new Date(now).toISOString()
  return { ...state, plan: PLANS[state.plan] ? state.plan : DEFAULT_PLAN, window }
}

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
/** A JWT-shaped token (as Kimi's are), its signature random. */
const jwt = claims => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, jti: randomUUID() })}.${randomBytes(32).toString('base64url')}`
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const userCode = () => [...randomBytes(8)].map((b, i) => (i === 4 ? '-' : '') + CODE_LETTERS[b % CODE_LETTERS.length]).join('')

const PAGE_STYLE = `body { font: 15px/1.4 -apple-system, system-ui, sans-serif; background: #f4f5f7; color: #111; display: grid; place-items: center; min-height: 100vh; margin: 0 }
  form, main { background: #fff; padding: 28px 32px; border-radius: 12px; box-shadow: 0 1px 4px #0002; display: grid; gap: 12px; width: 320px }
  h1 { font-size: 20px; margin: 0 0 4px } label { display: grid; gap: 4px; font-size: 13px; color: #555 }
  input, select, button { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid #ccc }
  button { background: #111; color: #fff; border: 0; cursor: pointer } button.secondary { background: #eee; color: #111 } .problem { color: #b00020; margin: 0 }`
const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Kimi Code (simulated)</title>
<style>
  ${PAGE_STYLE}
</style></head>
<body>${body}</body></html>
`

/** The page a person opens from the device code: the code, an email address and a plan. */
function devicePage(params, problem) {
  const options = [['', 'Unchanged (new account: Pro)'], ...Object.entries(PLANS).map(([id, p]) => [id, p.label])]
    .map(([id, label]) => `<option value="${id}"${params.plan === id ? ' selected' : ''}>${escape(label)}</option>`).join('')
  return page('Authorize a device', `<form method="post" action="authorize_device" id="sim-device">
      <h1>Authorize Kimi Code</h1>
      ${problem ? `<p class="problem" role="alert">${escape(problem)}</p>` : ''}
      <label>Code <input name="user_code" id="user_code" autocomplete="off" required value="${escape(params.user_code ?? '')}"></label>
      <label>Email <input type="email" name="email" id="email" autocomplete="email" required value="${escape(params.email ?? '')}"></label>
      <label>Plan <select name="plan" id="plan">${options}</select></label>
      <button type="submit" id="authorize" name="decision" value="allow">Authorize</button>
      <button type="submit" id="deny" name="decision" value="deny" class="secondary" formnovalidate>Deny</button>
</form>`)
}

/** Kimi Code's (Anthropic-shaped) error body. */
function kimiError(ctx, res, status, type, message, headers = {}) {
  ctx.json(res, status, { type: 'error', error: { type, message } }, headers)
}
/** Moonshot's (OpenAI-shaped) error body. */
function moonshotError(ctx, res, status, type, message, headers = {}) {
  ctx.json(res, status, { error: { message, type } }, headers)
}

/** The script's error kinds as each API reports them. */
const KIMI_TYPES = { 'rate-limit': 'rate_limit_error', overloaded: 'overloaded_error', server: 'api_error', timeout: 'api_error', network: 'api_error',
  auth: 'authentication_error', quota: 'permission_error', 'context-length': 'invalid_request_error', 'invalid-request': 'invalid_request_error' }
const MOONSHOT_TYPES = { 'rate-limit': 'rate_limit_reached_error', overloaded: 'engine_overloaded_error', server: 'server_error', timeout: 'server_error', network: 'server_error',
  auth: 'invalid_authentication_error', quota: 'exceeded_current_quota_error', 'context-length': 'invalid_request_error', 'invalid-request': 'invalid_request_error' }

const KIMI_INVALID_KEY = 'The API Key appears to be invalid or may have expired. Please verify your credentials and try again.'
const KIMI_UPGRADE = 'https://www.kimi.com/code?from=server_highspeed_error#pricing'
const KIMI_FIVE_HOUR = "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota"

/** Moonshot and Kimi Code: one handler for the API, sign-in and device-page hosts. */
export function create(ctx, catalog) {
  const store = ctx.store
  const keyAccount = key => store.account('moonshot', 'key', key, () => moonshotState('key', key))
  const emailAccount = (email, plan) => {
    const account = store.account('moonshot', 'email', email, () => ({ ...moonshotState('email', email), ...(plan ? { plan } : {}) }))
    return plan && account.state.plan !== plan ? store.update(account.id, s => ({ ...s, plan })) : account
  }
  /** Device authorizations in progress (this process's: the page and the poll reach the same simulator). */
  const devices = new Map()

  /** Issue an access and a refresh token for an account. */
  const issue = (account, accessSeconds = ACCESS_SECONDS, clientId = 'simulated') => {
    const now = Math.floor(Date.now() / 1000)
    const claims = { iss: 'https://auth.kimi.com', sub: account.state.uuid ?? String(account.id), client_id: clientId, scope: SCOPE, iat: now }
    const access = jwt({ ...claims, typ: 'access', exp: now + accessSeconds })
    const refresh = jwt({ ...claims, typ: 'refresh' })
    store.issueToken({ token: access, account: account.id, kind: 'access', seconds: accessSeconds })
    store.issueToken({ token: refresh, account: account.id, kind: 'refresh' })
    return { access_token: access, refresh_token: refresh, expires_in: accessSeconds, scope: SCOPE, token_type: 'Bearer' }
  }

  // ---- the Kimi API (platform.moonshot.ai / .cn) --------------------------------------
  const moonshot = async (req, res, path, body, host) => {
    const provider = host === 'api.moonshot.cn' ? 'moonshotai-cn' : 'moonshotai'
    const key = bearer(req)
    if (!key) return moonshotError(ctx, res, 401, 'incorrect_api_key_error', 'Incorrect API key provided')
    // A Kimi Code sign-in is not a Kimi API key: the platforms are separate.
    if (key.startsWith('eyJ')) return moonshotError(ctx, res, 401, 'invalid_authentication_error', 'Invalid Authentication')
    const account = keyAccount(key)
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      const known = catalog.models(provider)
      if (known.length > 0 && !known.some(m => m.id === body.model)) return moonshotError(ctx, res, 404, 'resource_not_found_error', `Not found the model ${body.model} or Permission denied`)
      if (account.state.balanceMicros <= 0) {
        const ak = `ak-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`
        return moonshotError(ctx, res, 429, 'exceeded_current_quota_error', `Your account ${account.state.uid}<${ak}> is suspended, please check your plan and billing details`)
      }
      const charge = micros => store.update(account.id, s => ({ ...s, balanceMicros: s.balanceMicros - micros }))
      const fail = (status, kind, message, headers) => moonshotError(ctx, res, status, MOONSHOT_TYPES[kind] ?? kind, message, headers)
      return playCompletion(ctx, { res, body, dialect: 'moonshot', account, provider, catalog, charge, idPrefix: 'chatcmpl-', fail })
    }
    if (req.method === 'GET' && path === '/v1/models') {
      return ctx.json(res, 200, { object: 'list', data: catalog.models(provider).map(m => ({ id: m.id, object: 'model', created: 1735689600, owned_by: 'moonshot', root: m.id, parent: null, context_length: m.contextWindow })) })
    }
    return moonshotError(ctx, res, 404, 'resource_not_found_error', `${req.method} ${path} is not simulated`)
  }

  // ---- Kimi Code (api.kimi.com/coding) ---------------------------------------------------
  const code = async (req, res, path, body) => {
    const key = req.headers['x-api-key']?.trim()
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
    let account
    if (key || (token && !token.startsWith('eyJ'))) account = keyAccount(key || token)
    else if (token) {
      const row = store.token(token)
      if (!row || row.kind !== 'access' || row.revoked || (row.expires && Date.parse(row.expires) <= Date.now())) return kimiError(ctx, res, 401, 'authentication_error', 'Invalid Authentication')
      account = store.get(row.account)
    } else return kimiError(ctx, res, 401, 'authentication_error', 'Invalid Authentication')
    account = store.update(account.id, s => settle(s))

    if (req.method === 'POST' && path === '/coding/v1/messages') {
      const plan = PLANS[account.state.plan]
      const model = String(body.model ?? '')
      const known = catalog.models('kimi-coding')
      if (known.length > 0 && !known.some(m => m.id === model)) return kimiError(ctx, res, 404, 'not_found_error', `Not found the model ${model} or Permission denied`)
      if (plan.denied.includes(model)) return kimiError(ctx, res, 401, 'authentication_error', `Your current subscription does not have access to ${model.startsWith('k3') ? 'k3' : model}.  Upgrade to higher-tier Kimi Code plans. Upgrade: Upgrade: ${KIMI_UPGRADE}`)
      if (account.state.window.used >= plan.requests) return kimiError(ctx, res, 403, 'permission_error', KIMI_FIVE_HOUR)
      const charge = () => {
        const now = Date.now()
        store.update(account.id, (s) => {
          const settled = settle(s, now)
          settled.window.used += 1
          settled.window.start ??= new Date(now).toISOString()
          return settled
        })
      }
      const fail = (status, kind, message, headers) => kimiError(ctx, res, status, KIMI_TYPES[kind] ?? kind, message, headers)
      return generate(ctx, { req, res, body, format: 'anthropic', account, provider: 'kimi-coding', catalog, charge, idPrefix: 'msg_', fail })
    }
    if (req.method === 'GET' && path === '/coding/v1/models') {
      const data = catalog.models('kimi-coding').map(m => ({ type: 'model', id: m.id, display_name: m.name ?? m.id, created_at: '2025-01-01T00:00:00Z' }))
      return ctx.json(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null })
    }
    return kimiError(ctx, res, 404, 'not_found_error', 'method not found')
  }

  // ---- the device-code sign-in (auth.kimi.com, www.kimi.com) ------------------------
  const oauthError = (res, status, error, description, extra = {}) => ctx.json(res, status, { error, error_description: description, ...extra })
  const auth = async (req, res, path, body) => {
    if (req.method !== 'POST') return oauthError(res, 404, 'not_found', `${req.method} ${path} is not simulated`)
    if (path === '/api/oauth/device_authorization') {
      if (!body.client_id) return oauthError(res, 400, 'invalid_client', 'client_id is required')
      const now = Date.now()
      for (const [k, d] of devices) if (d.expires <= now) devices.delete(k)
      const device = { deviceCode: randomBytes(32).toString('base64url'), userCode: userCode(), clientId: body.client_id, expires: now + DEVICE_SECONDS * 1000, status: 'pending' }
      devices.set(device.deviceCode, device)
      return ctx.json(res, 200, { device_code: device.deviceCode, user_code: device.userCode, verification_uri: VERIFICATION_URI,
        verification_uri_complete: `${VERIFICATION_URI}?user_code=${device.userCode}`, expires_in: DEVICE_SECONDS, interval: POLL_SECONDS })
    }
    if (path !== '/api/oauth/token') return oauthError(res, 404, 'not_found', `${req.method} ${path} is not simulated`)
    if (!body.client_id) return oauthError(res, 400, 'invalid_client', 'client_id is required')
    if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      const device = devices.get(String(body.device_code ?? ''))
      if (!device || device.clientId !== body.client_id) return oauthError(res, 400, 'invalid_grant', 'The device code is invalid')
      if (device.expires <= Date.now()) { devices.delete(device.deviceCode); return oauthError(res, 400, 'expired_token', 'The device code has expired') }
      if (device.status === 'pending') return oauthError(res, 400, 'authorization_pending', 'The authorization request is still pending')
      devices.delete(device.deviceCode)
      if (device.status === 'denied') return oauthError(res, 400, 'access_denied', 'The authorization request was denied')
      return ctx.json(res, 200, issue(store.get(device.account), ACCESS_SECONDS, body.client_id))
    }
    if (body.grant_type === 'refresh_token') {
      const row = store.consumeToken(String(body.refresh_token ?? ''), 'refresh')
      if (!row) return oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid or has been used')
      return ctx.json(res, 200, issue(store.get(row.account), ACCESS_SECONDS, body.client_id))
    }
    return oauthError(res, 400, 'unsupported_grant_type', `grant_type ${JSON.stringify(body.grant_type ?? null)} is not supported`)
  }

  const deviceSite = async (req, res, path, body) => {
    const html = (status, text) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(text) }
    if (path !== '/code/authorize_device' || !['GET', 'POST'].includes(req.method)) return html(404, page('Not found', '<main><h1>Not found</h1></main>'))
    const params = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://sim').searchParams) : body
    if (req.method === 'GET') return html(200, devicePage(params))
    const wanted = String(params.user_code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const device = [...devices.values()].find(d => d.userCode.replace('-', '') === wanted && d.status === 'pending' && d.expires > Date.now())
    if (!device) return html(400, devicePage(params, 'This code is invalid or has expired.'))
    if (params.decision === 'deny') {
      device.status = 'denied'
      return html(200, page('Access denied', '<main id="sim-denied"><h1>Access denied</h1><p>The device was not authorized.</p></main>'))
    }
    const email = String(params.email ?? '').trim().toLowerCase()
    if (!EMAIL.test(email)) return html(400, devicePage(params, 'Enter a valid email address.'))
    if (params.plan && !PLANS[params.plan]) return html(400, devicePage(params, 'Unknown plan.'))
    Object.assign(device, { status: 'allowed', account: emailAccount(email, params.plan || undefined).id })
    return html(200, page('Device authorized', `<main id="sim-authorized"><h1>Device authorized</h1><p>${escape(email)} is signed in to Kimi Code. You can return to your terminal.</p></main>`))
  }

  const handler = async (req, res, path, body, host) => {
    if (host === 'auth.kimi.com') return auth(req, res, path, body)
    if (host === 'www.kimi.com') return deviceSite(req, res, path, body)
    if (host === 'api.kimi.com') return code(req, res, path, body)
    return moonshot(req, res, path, body, host)
  }
  /** Sign an email in without a browser (for /_sim/sign-in): its Plan account, with fresh tokens. */
  handler.signIn = ({ email, plan, accessSeconds }) => {
    if (!EMAIL.test(String(email ?? ''))) throw new Error('an email address is required')
    if (plan !== undefined && !PLANS[plan]) throw new Error(`plan is one of ${Object.keys(PLANS).join(', ')}`)
    const account = emailAccount(email, plan)
    return { account, ...issue(account, accessSeconds ?? ACCESS_SECONDS) }
  }
  return handler
}

export const name = 'moonshot'
export const hosts = ['api.moonshot.ai', 'api.moonshot.cn', 'api.kimi.com', 'auth.kimi.com', 'www.kimi.com']
/** A new account's state. */
export const initialState = (kind, credential) => moonshotState(kind, credential)

export default { name, hosts, initialState, create }
