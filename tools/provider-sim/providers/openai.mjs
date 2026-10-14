/**
 * OpenAI, as DeepSea's stack calls it: pi-ai's `openai-responses` API (the
 * `openai` route), its ChatGPT Plus/Pro sign-in (`auth/oauth/openai-codex.js`)
 * and `openai-codex-responses` API (the `openai-codex-oauth` route), and the
 * harness's Codex usage read (`llm-pi-ai/src/subscription-usage.ts`).
 *
 * api.openai.com   POST /v1/responses (streamed and whole), POST
 *                  /v1/chat/completions, GET /v1/models, GET /v1/models/<id>.
 * auth.openai.com  GET/POST /oauth/authorize (a form: email and plan; redirect
 *                  to the loopback redirect_uri with code and state), POST
 *                  /oauth/token (authorization_code with PKCE, refresh_token),
 *                  the device-code login: POST /api/accounts/deviceauth/usercode,
 *                  GET/POST /codex/device (the page), POST /api/accounts/deviceauth/token.
 * chatgpt.com      POST /backend-api/codex/responses (server-sent events; the
 *                  body may be zstd), GET /backend-api/wham/usage.
 *
 * Two kinds of account. An API key (`Authorization: Bearer sk-…`) names an
 * account with a credit balance in micro-dollars, spent at catalog prices
 * (price tiers and service tiers as pi-ai prices them); an empty balance is
 * OpenAI's 429 `insufficient_quota`. An email signed in through the
 * authorize page names a ChatGPT Plan (Plus, Pro): its access tokens are
 * JWTs carrying the ChatGPT account id, plan and email as ChatGPT's do, and
 * its Codex requests fill a five-hour (primary) and a weekly (secondary)
 * window of tokens; a full window answers 429 `usage_limit_reached`.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { generate, STARTING_MICROS } from '../common.mjs'
import { playResponses } from '../wire-responses.mjs'

/** ChatGPT Plans: names and token limits per window. */
export const PLANS = {
  plus: { label: 'Plus', limits: { primary: 2_000_000, secondary: 20_000_000 } },
  pro: { label: 'Pro', limits: { primary: 12_000_000, secondary: 120_000_000 } },
}
export const DEFAULT_PLAN = 'plus'
/** The Codex windows: five hours and a week, in seconds. */
const WINDOWS = { primary: 5 * 3600, secondary: 7 * 86400 }
/** Access tokens live ten days (Codex refreshes them after eight), codes ten minutes, device codes fifteen. */
export const ACCESS_SECONDS = 10 * 86400
const CODE_SECONDS = 600
const DEVICE_SECONDS = 15 * 60
const ISSUER = 'https://auth.openai.com'
const SCOPE = 'openid profile email offline_access'
const AUTH_CLAIM = 'https://api.openai.com/auth'
const PROFILE_CLAIM = 'https://api.openai.com/profile'
/** The device-code login's redirect_uri (pi-ai's DEVICE_REDIRECT_URI). */
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`
/** Emails whose JWT payload stays plain base64 (pi-ai decodes Codex tokens with `atob`). */
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

const hex = bytes => randomBytes(bytes).toString('hex')
const alnum = n => randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n)

/** A new account's state: a credit balance for a key, a ChatGPT Plan for an email. */
export function openaiState(kind) {
  if (kind === 'email') return { plan: DEFAULT_PLAN, accountId: randomUUID(), userId: `user-${alnum(24)}`, windows: {} }
  return { balanceMicros: STARTING_MICROS, organization: `org-${alnum(24)}` }
}

/** Tokens a Codex response counts against the windows: input and output, cache reads at a tenth. */
export const planTokens = usage => usage.input + usage.output + usage.cacheWrite + Math.round(usage.cacheRead / 10)

/** A Plan's windows at `now`: expired ones emptied, used ones without a start started now. */
export function settle(state, now = Date.now()) {
  const windows = {}
  for (const name of Object.keys(WINDOWS)) {
    const w = { used: 0, start: null, ...state.windows?.[name] }
    if (w.start !== null && now >= Date.parse(w.start) + WINDOWS[name] * 1000) Object.assign(w, { used: 0, start: null })
    if (w.used > 0 && w.start === null) w.start = new Date(now).toISOString()
    windows[name] = w
  }
  return { ...state, plan: PLANS[state.plan] ? state.plan : DEFAULT_PLAN, windows }
}

/** One window as ChatGPT reports it: percent used, its length and reset (a window not started resets a full length from now). */
export function windowOf(state, name, now = Date.now()) {
  const w = state.windows[name]
  const exact = 100 * w.used / PLANS[state.plan].limits[name]
  const resetMs = w.start === null ? now + WINDOWS[name] * 1000 : Date.parse(w.start) + WINDOWS[name] * 1000
  return { exact, seconds: WINDOWS[name], resetAt: Math.floor(resetMs / 1000), resetAfter: Math.max(0, Math.ceil((resetMs - now) / 1000)) }
}

/** The `x-codex-*` headers of a Codex response (the vocabulary codex-rs and the billing plugin read). */
function codexHeaders(state, now = Date.now()) {
  const headers = {}
  for (const name of Object.keys(WINDOWS)) {
    const v = windowOf(state, name, now)
    headers[`x-codex-${name}-used-percent`] = String(Math.min(100, Math.round(v.exact * 10) / 10))
    headers[`x-codex-${name}-window-minutes`] = String(v.seconds / 60)
    headers[`x-codex-${name}-reset-at`] = String(v.resetAt)
    headers[`x-codex-${name}-reset-after-seconds`] = String(v.resetAfter)
  }
  return { ...headers, 'x-codex-credits-has-credits': 'false', 'x-codex-credits-unlimited': 'false', 'x-codex-credits-balance': '0' }
}

// ---- tokens: JWTs as ChatGPT issues them ----------------------------------------------

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
/** A JWT with these claims; its signature is random (nothing checks it but the simulator, which looks tokens up). */
const jwt = claims => `${b64({ alg: 'RS256', kid: 'sim', typ: 'JWT' })}.${b64(claims)}.${randomBytes(64).toString('base64url')}`

/** The access and ID tokens' claims for a Plan account: account id, plan, user and email where pi-ai and the harness read them. */
function claims(account, seconds, clientId) {
  const s = account.state
  const iat = Math.floor(Date.now() / 1000)
  const sub = `auth0|${alnum(24)}`
  const session = `authsess_${alnum(24)}`
  const auth = { chatgpt_account_id: s.accountId, chatgpt_plan_type: s.plan, chatgpt_user_id: s.userId, user_id: s.userId }
  const access = {
    aud: ['https://api.openai.com/v1'], client_id: clientId, exp: iat + seconds, iat, iss: ISSUER, jti: randomUUID(), nbf: iat, pwd_auth_time: iat * 1000,
    scp: SCOPE.split(' '), session_id: session, sub,
    [AUTH_CLAIM]: { ...auth, chatgpt_account_user_id: `${s.userId}__${s.accountId}`, chatgpt_compute_residency: 'no_constraint' },
    [PROFILE_CLAIM]: { email: account.credential, email_verified: true },
  }
  const id = {
    aud: [clientId], auth_provider: 'password', auth_time: iat, email: account.credential, email_verified: true, exp: iat + 3600, iat, iss: ISSUER,
    jti: randomUUID(), rat: iat, sid: session, sub,
    [AUTH_CLAIM]: { ...auth, chatgpt_subscription_active_start: account.created, chatgpt_subscription_active_until: null, chatgpt_subscription_last_checked: new Date(iat * 1000).toISOString(),
      completed_platform_onboarding: false, groups: [], is_org_owner: true, localhost: true, organizations: [{ id: `org-${alnum(24)}`, is_default: true, role: 'owner', title: 'Personal' }] },
  }
  return { access, id }
}

const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const PAGE_STYLE = `
  body { font: 15px/1.4 -apple-system, system-ui, sans-serif; background: #fff; color: #0d0d0d; display: grid; place-items: center; min-height: 100vh; margin: 0 }
  form, main { padding: 28px 32px; border-radius: 16px; border: 1px solid #e5e5e5; display: grid; gap: 12px; width: 320px }
  h1 { font-size: 22px; margin: 0 0 4px; text-align: center } label { display: grid; gap: 4px; font-size: 13px; color: #5d5d5d }
  input, select, button { font: inherit; padding: 10px 12px; border-radius: 999px; border: 1px solid #d9d9d9 }
  button { background: #0d0d0d; color: #fff; border: 0; cursor: pointer } .problem { color: #d00; margin: 0 }`

/** A form page: an email address and a plan, the request's other fields kept hidden. */
function formPage({ title, heading, action, id, params, problem, fields = '' }) {
  const hidden = Object.entries(params).filter(([k]) => !['email', 'plan', 'user_code'].includes(k))
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join('\n      ')
  const options = [['', `Unchanged (new account: ${PLANS[DEFAULT_PLAN].label})`], ...Object.entries(PLANS).map(([key, p]) => [key, p.label])]
    .map(([key, label]) => `<option value="${key}"${params.plan === key ? ' selected' : ''}>${escape(label)}</option>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${PAGE_STYLE}</style></head>
<body><form method="post" action="${action}" id="${id}">
      <h1>${escape(heading)}</h1>
      ${problem ? `<p class="problem" role="alert">${escape(problem)}</p>` : ''}
      ${fields}
      <label>Email address <input type="email" name="email" id="email" autocomplete="email" required value="${escape(params.email ?? '')}"></label>
      <label>Plan <select name="plan" id="plan">${options}</select></label>
      ${hidden}
      <button type="submit" id="continue">Continue</button>
</form></body></html>
`
}

const messagePage = (title, text) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(text)}</p></main></body></html>
`

// ---- errors ---------------------------------------------------------------------------

/** OpenAI's error body: `{ error: { message, type, param, code } }`. */
function openaiError(ctx, res, status, { message, type = 'invalid_request_error', code = null, param = null, ...extra }, headers = {}) {
  ctx.json(res, status, { error: { message, type, param, code, ...extra } }, headers)
}

/** The script's error kinds as OpenAI reports them. */
const ERRORS = {
  'rate-limit': { status: 429, type: 'requests', code: 'rate_limit_exceeded', message: 'Rate limit reached for requests. Please try again later.' },
  overloaded: { status: 503, type: 'server_error', code: 'server_is_overloaded', message: 'The server is overloaded. Please try again later.' },
  server: { status: 500, type: 'server_error', code: 'server_error', message: 'The server had an error while processing your request. Sorry about that!' },
  timeout: { status: 504, type: 'server_error', code: 'timeout', message: 'Request timed out.' },
  auth: { status: 401, type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided.' },
  quota: { status: 429, type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.' },
  'context-length': { status: 400, type: 'invalid_request_error', code: 'context_length_exceeded', param: 'input', message: 'Your input exceeds the context window of this model. Please adjust your input and try again.' },
  'invalid-request': { status: 400, type: 'invalid_request_error', code: null },
}
/** Statuses a script names by default that OpenAI answers otherwise (an `overloaded` is 503, a `quota` 429). */
const DEFAULT_STATUS = { overloaded: 529, quota: 402 }

/** Answer a script's error (`kind` in the script's vocabulary): a `network` error drops the connection. */
function scriptError(ctx, req, res, status, given, message, headers, extra = () => ({})) {
  // common.mjs's generate() names an invalid script by OpenAI's type.
  const kind = given === 'invalid_request_error' ? 'invalid-request' : given
  if (kind === 'network') { req.socket.destroy(); return }
  const e = ERRORS[kind] ?? { type: 'server_error', code: null }
  const answer = DEFAULT_STATUS[kind] === status ? e.status : status
  openaiError(ctx, res, answer, { message: message ?? e.message, type: e.type, code: e.code, param: e.param ?? null, ...extra(kind) }, headers)
}

/** A key as OpenAI shows it in an error: its first three and last four characters. */
const redact = key => key.length <= 8 ? key : `${key.slice(0, 3)}${'*'.repeat(Math.min(40, key.length - 7))}${key.slice(-4)}`

// ---- the provider ---------------------------------------------------------------------

/** OpenAI: one handler for its API, its sign-in host and ChatGPT. */
export function create(ctx, catalog) {
  const store = ctx.store
  const keyAccount = key => store.account('openai', 'key', key, () => openaiState('key'))
  const emailAccount = (email, plan) => {
    let account = store.account('openai', 'email', email, () => ({ ...openaiState('email'), ...(plan ? { plan } : {}) }))
    if (plan && account.state.plan !== plan) account = store.update(account.id, s => ({ ...s, plan }))
    return account
  }
  /** Pending device-code logins (fifteen minutes; one simulator serves a login from start to end). */
  const devices = new Map()

  /** Issue an access, refresh and ID token for a Plan account, as the token endpoint answers. */
  const issue = (account, accessSeconds = ACCESS_SECONDS, clientId = 'app_EMoamEEZ73f0CkXaXp7hrann') => {
    const { access, id } = claims(account, accessSeconds, clientId)
    const accessToken = jwt(access)
    const refresh = `rt_${randomBytes(48).toString('base64url')}`
    store.issueToken({ token: accessToken, account: account.id, kind: 'access', seconds: accessSeconds })
    store.issueToken({ token: refresh, account: account.id, kind: 'refresh', data: { clientId } })
    return { id_token: jwt(id), access_token: accessToken, refresh_token: refresh, expires_in: accessSeconds, token_type: 'Bearer', scope: SCOPE }
  }

  // ---- api.openai.com ----
  const api = async (req, res, path, body) => {
    res.setHeader('x-request-id', `req_${hex(16)}`)
    res.setHeader('openai-version', '2020-10-01')
    const key = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
    if (!key) {
      return openaiError(ctx, res, 401, { message: "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY), or as the password field (with blank username) if you're accessing the API from your browser and are prompted for a username. You can obtain an API key from https://platform.openai.com/account/api-keys." })
    }
    const invalid = () => openaiError(ctx, res, 401, { message: `Incorrect API key provided: ${redact(key)}. You can find your API key at https://platform.openai.com/account/api-keys.`, code: 'invalid_api_key' })
    if (!key.startsWith('sk-')) return invalid()
    const account = keyAccount(key)
    if (account.state.revoked) return invalid()
    res.setHeader('openai-organization', account.state.organization ?? 'user-sim')
    const fail = (status, kind, message, headers) => scriptError(ctx, req, res, status, kind, message, headers)
    const charge = micros => store.update(account.id, s => ({ ...s, balanceMicros: s.balanceMicros - micros }))
    const generating = req.method === 'POST' && (path === '/v1/responses' || path === '/v1/chat/completions')
    if (generating) {
      if (account.state.balanceMicros <= 0) return openaiError(ctx, res, 429, { ...ERRORS.quota })
      const started = Date.now()
      res.setHeader('x-ratelimit-limit-requests', '10000')
      res.setHeader('x-ratelimit-remaining-requests', '9999')
      res.setHeader('x-ratelimit-reset-requests', '6ms')
      const timed = (micros) => { res.setHeader('openai-processing-ms', String(Date.now() - started)); charge(micros) }
      if (path === '/v1/responses') return playResponses(ctx, { req, res, body, account, provider: 'openai', catalog, charge: timed, fail })
      return generate(ctx, { req, res, body, format: 'openai', account, provider: 'openai', catalog, charge: timed, idPrefix: 'chatcmpl-', fail })
    }
    const model = m => ({ id: m.id, object: 'model', created: 1_700_000_000, owned_by: 'system' })
    if (req.method === 'GET' && path === '/v1/models') return ctx.json(res, 200, { object: 'list', data: catalog.models('openai').map(model) })
    if (req.method === 'GET' && path.startsWith('/v1/models/')) {
      const id = decodeURIComponent(path.slice('/v1/models/'.length))
      const found = catalog.models('openai').find(m => m.id === id)
      if (found) return ctx.json(res, 200, model(found))
      return openaiError(ctx, res, 404, { message: `The model '${id}' does not exist`, code: 'model_not_found', param: 'model' })
    }
    return openaiError(ctx, res, 404, { message: `Invalid URL (${req.method} ${path})` })
  }

  // ---- auth.openai.com ----
  const html = (res, status, page) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page) }
  const oauthError = (res, error, description, status = 400) => ctx.json(res, status, { error, error_description: description })
  const signedInEmail = (params) => {
    const email = String(params.email ?? '').trim().toLowerCase()
    if (!EMAIL.test(email)) return { problem: 'Enter a valid email address.' }
    if (params.plan && !PLANS[params.plan]) return { problem: 'Unknown plan.' }
    return { account: emailAccount(email, params.plan || undefined) }
  }

  const authorize = (req, res, body) => {
    const params = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://sim').searchParams) : body
    let redirect
    try { redirect = new URL(params.redirect_uri ?? '') } catch { /* checked below */ }
    // Only a loopback callback: a simulated sign-in never sends the browser to a real site.
    if (params.response_type !== 'code' || !params.client_id || !redirect || redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)) {
      return html(res, 400, messagePage('Invalid request', 'Invalid OAuth request: response_type=code, a client_id and a loopback redirect_uri are required.'))
    }
    const page = problem => formPage({ title: 'Log in · ChatGPT (simulated)', heading: 'Welcome back', action: 'authorize', id: 'sim-authorize', params, problem })
    if (req.method === 'GET') return html(res, 200, page())
    const { account, problem } = signedInEmail(params)
    if (problem) return html(res, 400, page(problem))
    const code = `ac_${randomBytes(32).toString('base64url')}`
    store.issueToken({ token: code, account: account.id, kind: 'code', seconds: CODE_SECONDS,
      data: { redirectUri: params.redirect_uri, clientId: params.client_id, challenge: params.code_challenge ?? null, method: params.code_challenge_method ?? 'plain' } })
    redirect.searchParams.set('code', code)
    if (params.scope !== undefined) redirect.searchParams.set('scope', params.scope)
    if (params.state !== undefined) redirect.searchParams.set('state', params.state)
    res.writeHead(302, { location: redirect.href, 'cache-control': 'no-store' })
    return res.end()
  }

  const verifierMatches = (data, verifier) => {
    if (!data.challenge) return true
    if (typeof verifier !== 'string' || verifier.length === 0) return false
    return data.method === 'S256' ? createHash('sha256').update(verifier).digest('base64url') === data.challenge : verifier === data.challenge
  }

  const token = (res, body) => {
    if (!body.client_id) return oauthError(res, 'invalid_request', 'Missing required parameter: client_id')
    if (body.grant_type === 'authorization_code') {
      const row = store.consumeToken(String(body.code ?? ''), 'code')
      if (!row) return oauthError(res, 'invalid_grant', 'Invalid authorization code')
      if (row.data.redirectUri !== body.redirect_uri) return oauthError(res, 'invalid_grant', 'redirect_uri does not match the authorization request')
      if (!verifierMatches(row.data, body.code_verifier)) return oauthError(res, 'invalid_grant', 'Invalid code_verifier')
      return ctx.json(res, 200, issue(store.get(row.account), ACCESS_SECONDS, body.client_id))
    }
    if (body.grant_type === 'refresh_token') {
      const value = String(body.refresh_token ?? '')
      const row = store.token(value)
      const refused = (code, message) => ctx.json(res, 401, { error: { message, type: 'invalid_request_error', param: null, code } })
      if (!row || row.kind !== 'refresh') return refused('refresh_token_invalidated', 'Your refresh token has been invalidated. Please try signing in again.')
      if (!store.consumeToken(value, 'refresh')) return refused('refresh_token_reused', 'Your refresh token has already been used to generate a new access token. Please try signing in again.')
      return ctx.json(res, 200, issue(store.get(row.account), ACCESS_SECONDS, body.client_id))
    }
    return oauthError(res, 'unsupported_grant_type', `grant_type ${JSON.stringify(body.grant_type ?? null)} is not supported`)
  }

  const formatCode = () => { const c = randomBytes(9).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().padEnd(9, 'X'); return `${c.slice(0, 4)}-${c.slice(4, 9)}` }
  const devicePage = (req, res, body) => {
    const params = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://sim').searchParams) : body
    const fields = `<label>Code <input name="user_code" id="user_code" required autocomplete="off" value="${escape(params.user_code ?? '')}"></label>`
    const page = problem => formPage({ title: 'Sign in with a code · ChatGPT (simulated)', heading: 'Enter your code', action: 'device', id: 'sim-device', params, problem, fields })
    if (req.method === 'GET') return html(res, 200, page())
    const userCode = String(params.user_code ?? '').trim().toUpperCase()
    const entry = [...devices.values()].find(d => d.userCode === userCode && d.expires > Date.now())
    if (!entry) return html(res, 400, page('That code is not valid or has expired.'))
    const { account, problem } = signedInEmail(params)
    if (problem) return html(res, 400, page(problem))
    entry.account = account.id
    return html(res, 200, messagePage('Signed in', 'You can close this window and return to Codex.'))
  }

  const auth = async (req, res, path, body) => {
    if (path === '/oauth/authorize' && ['GET', 'POST'].includes(req.method)) return authorize(req, res, body)
    if (path === '/oauth/token' && req.method === 'POST') return token(res, body)
    if (path === '/codex/device' && ['GET', 'POST'].includes(req.method)) return devicePage(req, res, body)
    if (path === '/api/accounts/deviceauth/usercode' && req.method === 'POST') {
      if (!body.client_id) return ctx.json(res, 400, { error: { message: 'client_id is required', code: 'invalid_request' } })
      for (const [id, d] of devices) if (d.expires <= Date.now()) devices.delete(id)
      const id = `deviceauth_${alnum(32)}`
      const device = { userCode: formatCode(), clientId: body.client_id, expires: Date.now() + DEVICE_SECONDS * 1000, account: undefined }
      devices.set(id, device)
      return ctx.json(res, 200, { device_auth_id: id, user_code: device.userCode, interval: '5', expires_at: new Date(device.expires).toISOString() })
    }
    if (path === '/api/accounts/deviceauth/token' && req.method === 'POST') {
      const device = devices.get(String(body.device_auth_id ?? ''))
      if (!device || device.userCode !== body.user_code) return ctx.json(res, 404, { error: { message: 'Device authorization not found', code: 'deviceauth_not_found' } })
      if (device.expires <= Date.now()) { devices.delete(body.device_auth_id); return ctx.json(res, 400, { error: { message: 'The device code has expired', code: 'deviceauth_expired' } }) }
      if (device.account === undefined) return ctx.json(res, 403, { error: { message: 'Device authorization is pending', code: 'deviceauth_authorization_pending' } })
      devices.delete(body.device_auth_id)
      const verifier = randomBytes(48).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const code = `ac_${randomBytes(32).toString('base64url')}`
      store.issueToken({ token: code, account: device.account, kind: 'code', seconds: CODE_SECONDS, data: { redirectUri: DEVICE_REDIRECT_URI, clientId: device.clientId, challenge, method: 'S256' } })
      return ctx.json(res, 200, { authorization_code: code, code_challenge: challenge, code_verifier: verifier })
    }
    return ctx.json(res, 404, { error: { message: `${req.method} ${path} is not simulated`, code: 'not_found' } })
  }

  // ---- chatgpt.com ----
  /** The Plan account behind a ChatGPT request's bearer token (and its `chatgpt-account-id`), or an answered 401/403. */
  const planAccount = (req, res) => {
    const value = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
    if (!value) { ctx.json(res, 401, { detail: 'Unauthorized' }); return undefined }
    const refuse = (code, message) => { ctx.json(res, 401, { error: { message, type: 'invalid_request_error', param: null, code } }); return undefined }
    const row = store.token(value)
    if (!row || row.kind !== 'access' || row.revoked) return refuse('token_invalidated', 'Your authentication token has been invalidated. Please try signing in again.')
    if (row.expires && Date.parse(row.expires) <= Date.now()) return refuse('token_expired', 'Provided authentication token is expired. Please try signing in again.')
    const account = store.update(row.account, s => settle(s))
    const claimed = req.headers['chatgpt-account-id']
    if (claimed !== undefined && claimed !== account.state.accountId) { ctx.json(res, 403, { detail: 'The chatgpt-account-id header does not match the signed-in account.' }); return undefined }
    return account
  }

  const chatgpt = async (req, res, path, body) => {
    if (path === '/backend-api/codex/responses' && req.method === 'POST') {
      const account = planAccount(req, res)
      if (!account) return
      if (body.stream !== true) return ctx.json(res, 400, { detail: 'Stream must be set to true' })
      if (body.store !== false) return ctx.json(res, 400, { detail: 'Store must be set to false' })
      const now = Date.now()
      const views = Object.fromEntries(Object.keys(WINDOWS).map(n => [n, windowOf(account.state, n, now)]))
      const full = Object.keys(WINDOWS).filter(n => views[n].exact >= 100)
      if (full.length > 0) {
        const resetsAt = Math.max(...full.map(n => views[n].resetAt))
        return ctx.json(res, 429, { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: account.state.plan,
          resets_at: resetsAt, resets_in_seconds: Math.max(0, resetsAt - Math.floor(now / 1000)), eligible_promo: null } }, codexHeaders(account.state, now))
      }
      const charge = (_micros, usage) => {
        const at = Date.now()
        const after = store.update(account.id, (s) => {
          const settled = settle(s, at)
          for (const w of Object.values(settled.windows)) {
            w.used += planTokens(usage)
            w.start ??= new Date(at).toISOString()
          }
          return settled
        })
        for (const [name, value] of Object.entries(codexHeaders(after.state, at))) res.setHeader(name, value)
      }
      const fail = (status, kind, message, headers) => scriptError(ctx, req, res, status, kind, message, { ...codexHeaders(account.state), ...headers },
        k => k === 'quota' ? { type: 'usage_limit_reached', plan_type: account.state.plan } : {})
      return playResponses(ctx, { req, res, body, account, provider: 'openai-codex', catalog, charge, fail })
    }
    if (path === '/backend-api/wham/usage' && req.method === 'GET') {
      const account = planAccount(req, res)
      if (!account) return
      const now = Date.now()
      const window = (n) => { const v = windowOf(account.state, n, now); return { used_percent: Math.min(100, Math.floor(v.exact)), limit_window_seconds: v.seconds, reset_after_seconds: v.resetAfter, reset_at: v.resetAt } }
      const reached = Object.keys(WINDOWS).some(n => windowOf(account.state, n, now).exact >= 100)
      return ctx.json(res, 200, { user_id: account.state.userId, account_id: account.state.accountId, email: account.credential, plan_type: account.state.plan,
        rate_limit: { allowed: !reached, limit_reached: reached, primary_window: window('primary'), secondary_window: window('secondary') },
        code_review_rate_limit: null, additional_rate_limits: null, credits: { has_credits: false, unlimited: false, balance: '0' }, promo: null })
    }
    return ctx.json(res, 404, { detail: 'Not Found' })
  }

  const handler = async (req, res, path, body, host) => {
    if (host === 'auth.openai.com') return auth(req, res, path, body)
    if (host === 'chatgpt.com') return chatgpt(req, res, path, body)
    return api(req, res, path, body)
  }
  /** Sign an email in without a browser (for /_sim/sign-in): its account, with fresh tokens. */
  handler.signIn = ({ email, plan, accessSeconds }) => {
    if (!EMAIL.test(String(email ?? ''))) throw new Error('an email address is required')
    if (plan !== undefined && !PLANS[plan]) throw new Error(`plan is one of ${Object.keys(PLANS).join(', ')}`)
    const account = emailAccount(String(email).toLowerCase(), plan)
    return { account, ...issue(account, accessSeconds ?? ACCESS_SECONDS) }
  }
  return handler
}

export const name = 'openai'
export const hosts = ['api.openai.com', 'auth.openai.com', 'chatgpt.com']
/** A new account's state. */
export const initialState = kind => openaiState(kind)

export default { name, hosts, initialState, create }
