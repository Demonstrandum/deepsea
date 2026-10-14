/**
 * Anthropic, as DeepSea's stack calls it: pi-ai's `anthropic-messages` API and
 * its Claude Pro/Max sign-in (`auth/oauth/anthropic.js`), and the harness's
 * subscription reads (`llm-pi-ai/src/subscription-usage.ts`).
 *
 * api.anthropic.com     POST /v1/messages (streamed and whole), GET /v1/models,
 *                       GET /api/oauth/usage, GET /api/oauth/profile.
 * claude.ai             GET /oauth/authorize (a form: email and plan), POST
 *                       /oauth/authorize (redirect to redirect_uri with code and state).
 * platform.claude.com   POST /v1/oauth/token (authorization_code, refresh_token);
 * console.anthropic.com   the same (older pi-ai releases used it).
 *
 * Two kinds of account. An API key (`x-api-key`) names an account with a
 * credit balance in micro-dollars, spent at catalog prices; an empty balance
 * is Anthropic's 400 "Your credit balance is too low…". An email signed in
 * through the authorize page names a Plan account (Pro, Max 5×, Max 20×): its
 * OAuth access tokens (`sk-ant-oat01-…`, one hour, refreshable) are charged to
 * a five-hour and a seven-day window of tokens instead of money, and a window
 * at 100% answers 429 with Anthropic's unified rate-limit headers.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { generate, STARTING_MICROS } from '../common.mjs'

/** Plans: their names and token limits per window. */
export const PLANS = {
  pro: { label: 'Pro', organizationType: 'claude_pro', tier: 'default_claude_pro', limits: { five_hour: 1_000_000, seven_day: 10_000_000 } },
  max5: { label: 'Max 5×', organizationType: 'claude_max', tier: 'default_claude_max_5x', limits: { five_hour: 5_000_000, seven_day: 50_000_000 } },
  max20: { label: 'Max 20×', organizationType: 'claude_max', tier: 'default_claude_max_20x', limits: { five_hour: 20_000_000, seven_day: 200_000_000 } },
}
export const DEFAULT_PLAN = 'max5'
const WINDOWS = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000 }
const HEADER_LABEL = { five_hour: '5h', seven_day: '7d' }
/** Access tokens live an hour, authorization codes ten minutes; refresh tokens until used. */
export const ACCESS_SECONDS = 3600
const CODE_SECONDS = 600
const SCOPES = 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload org:create_api_key'
const OAUTH_BETA = 'oauth-2025-04-20'

/** A new account's state: a credit balance for a key, a plan for an email. */
export function anthropicState(kind, credential) {
  if (kind === 'email') return { plan: DEFAULT_PLAN, uuid: randomUUID(), organizationUuid: randomUUID(), windows: {} }
  return { balanceMicros: STARTING_MICROS }
}

/** Tokens a response counts against a Plan's windows: input and output, cache reads at a tenth. */
export const planTokens = usage => usage.input + usage.output + usage.cacheWrite + Math.round(usage.cacheRead / 10)

/** A Plan's windows at `now`: expired ones emptied, used ones without a start started now. */
export function settle(state, now = Date.now()) {
  const windows = {}
  for (const name of Object.keys(WINDOWS)) {
    const w = { used: 0, start: null, ...state.windows?.[name] }
    if (w.start !== null && now >= Date.parse(w.start) + WINDOWS[name]) Object.assign(w, { used: 0, start: null })
    if (w.used > 0 && w.start === null) w.start = new Date(now).toISOString()
    windows[name] = w
  }
  return { ...state, plan: PLANS[state.plan] ? state.plan : DEFAULT_PLAN, windows }
}

/** One window's utilization (percent, whole numbers as Anthropic reports them) and reset time. */
export function windowOf(state, name) {
  const w = state.windows[name]
  const exact = 100 * w.used / PLANS[state.plan].limits[name]
  return { exact, utilization: Math.min(100, Math.floor(exact)), resetsAt: w.start === null ? null : new Date(Date.parse(w.start) + WINDOWS[name]).toISOString() }
}

/** Anthropic's `anthropic-ratelimit-unified-*` headers for a Plan's state. */
function unifiedHeaders(state, rejected) {
  const names = Object.keys(WINDOWS)
  const views = Object.fromEntries(names.map(n => [n, windowOf(state, n)]))
  const claim = names.reduce((a, b) => views[b].exact > views[a].exact ? b : a)
  const seconds = iso => String(Math.floor(Date.parse(iso) / 1000))
  const status = rejected ? 'rejected' : views[claim].exact >= 80 ? 'allowed_warning' : 'allowed'
  const headers = { 'anthropic-ratelimit-unified-status': status, 'anthropic-ratelimit-unified-representative-claim': claim, 'anthropic-ratelimit-unified-fallback-percentage': '0.5' }
  for (const n of names) {
    const v = views[n]
    headers[`anthropic-ratelimit-unified-${HEADER_LABEL[n]}-status`] = v.exact >= 100 ? 'rejected' : v.exact >= 80 ? 'allowed_warning' : 'allowed'
    headers[`anthropic-ratelimit-unified-${HEADER_LABEL[n]}-utilization`] = String(Math.round(v.exact * 100) / 10000)
    if (v.resetsAt) headers[`anthropic-ratelimit-unified-${HEADER_LABEL[n]}-reset`] = seconds(v.resetsAt)
  }
  if (views[claim].resetsAt) headers['anthropic-ratelimit-unified-reset'] = seconds(views[claim].resetsAt)
  return { headers, claim, views }
}

const token = prefix => `${prefix}${randomBytes(48).toString('base64url')}`
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The page a sign-in starts on: an email address and a plan. */
function authorizePage(params, problem) {
  const hidden = Object.entries(params).filter(([k]) => !['email', 'plan'].includes(k))
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join('\n      ')
  const options = [['', 'Unchanged (new account: Max 5×)'], ...Object.entries(PLANS).map(([id, p]) => [id, p.label])]
    .map(([id, label]) => `<option value="${id}"${params.plan === id ? ' selected' : ''}>${escape(label)}</option>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Claude (simulated)</title>
<style>
  body { font: 15px/1.4 -apple-system, system-ui, sans-serif; background: #f5f4ef; color: #1f1e1d; display: grid; place-items: center; min-height: 100vh; margin: 0 }
  form { background: #fff; padding: 28px 32px; border-radius: 12px; box-shadow: 0 1px 4px #0002; display: grid; gap: 12px; width: 320px }
  h1 { font-size: 20px; margin: 0 0 4px } label { display: grid; gap: 4px; font-size: 13px; color: #555 }
  input, select, button { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid #ccc }
  button { background: #c96442; color: #fff; border: 0; cursor: pointer } .problem { color: #b00020; margin: 0 }
</style></head>
<body><form method="post" action="authorize" id="sim-authorize">
      <h1>Sign in to Claude</h1>
      ${problem ? `<p class="problem" role="alert">${escape(problem)}</p>` : ''}
      <label>Email <input type="email" name="email" id="email" autocomplete="email" required value="${escape(params.email ?? '')}"></label>
      <label>Plan <select name="plan" id="plan">${options}</select></label>
      ${hidden}
      <button type="submit" id="authorize">Authorize</button>
</form></body></html>
`
}

/** Anthropic's error body. */
function anthropicError(ctx, res, status, type, message, headers = {}) {
  ctx.json(res, status, { type: 'error', error: { type, message }, request_id: res.getHeader('request-id') }, headers)
}

/** The script's error kinds as Anthropic reports them. */
const ERROR_TYPES = { 'rate-limit': 'rate_limit_error', overloaded: 'overloaded_error', server: 'api_error', timeout: 'timeout_error', network: 'api_error',
  auth: 'authentication_error', quota: 'billing_error', 'context-length': 'invalid_request_error', 'invalid-request': 'invalid_request_error' }

/** Anthropic: one handler for its API, sign-in page and token hosts. */
export function create(ctx, catalog) {
  const store = ctx.store
  const keyAccount = key => store.account('anthropic', 'key', key, () => anthropicState('key', key))
  const fail = res => (status, kind, message, headers) => anthropicError(ctx, res, status, ERROR_TYPES[kind] ?? kind, message, headers)

  /** Issue an access and a refresh token for a Plan account. */
  const issue = (account, accessSeconds = ACCESS_SECONDS) => {
    const access = token('sk-ant-oat01-')
    const refresh = token('sk-ant-ort01-')
    store.issueToken({ token: access, account: account.id, kind: 'access', seconds: accessSeconds })
    store.issueToken({ token: refresh, account: account.id, kind: 'refresh' })
    return { token_type: 'Bearer', access_token: access, expires_in: accessSeconds, refresh_token: refresh, scope: SCOPES,
      organization: { uuid: account.state.organizationUuid, name: `${account.credential}'s Organization` },
      account: { uuid: account.state.uuid, email_address: account.credential } }
  }

  /** The Plan account behind a request's OAuth bearer token, or an answered 401. */
  const oauthAccount = (req, res, access) => {
    const betas = String(req.headers['anthropic-beta'] ?? '').split(',').map(s => s.trim())
    if (!betas.includes(OAUTH_BETA)) { anthropicError(ctx, res, 401, 'authentication_error', 'OAuth authentication is currently not supported.'); return undefined }
    const row = store.token(access)
    if (!row || row.kind !== 'access' || row.revoked) { anthropicError(ctx, res, 401, 'authentication_error', 'Invalid bearer token'); return undefined }
    if (row.expires && Date.parse(row.expires) <= Date.now()) { anthropicError(ctx, res, 401, 'authentication_error', 'OAuth token has expired. Please obtain a new token or refresh your existing token.'); return undefined }
    return store.update(row.account, s => settle(s))
  }

  const api = async (req, res, path, body) => {
    res.setHeader('request-id', `req_sim${randomBytes(12).toString('hex')}`)
    const key = req.headers['x-api-key']?.trim()
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const isMessages = req.method === 'POST' && path === '/v1/messages'
    if (path.startsWith('/v1/') && !req.headers['anthropic-version']) return anthropicError(ctx, res, 400, 'invalid_request_error', 'anthropic-version: header is required')
    let account
    if (key) {
      if (path.startsWith('/api/oauth/')) return anthropicError(ctx, res, 401, 'authentication_error', 'OAuth authentication is required for this endpoint.')
      account = keyAccount(key)
    } else if (bearer?.startsWith('sk-ant-oat')) {
      account = oauthAccount(req, res, bearer)
      if (!account) return
    } else return anthropicError(ctx, res, 401, 'authentication_error', bearer ? 'invalid x-api-key' : 'x-api-key header is required')
    const plan = account.kind === 'email'

    if (isMessages) {
      if (!plan) {
        if (account.state.balanceMicros <= 0) return anthropicError(ctx, res, 400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')
        const charge = micros => store.update(account.id, s => ({ ...s, balanceMicros: s.balanceMicros - micros }))
        return generate(ctx, { req, res, body, format: 'anthropic', account, provider: 'anthropic', catalog, charge, idPrefix: 'msg_', fail: fail(res) })
      }
      const before = unifiedHeaders(account.state, false)
      const full = Object.keys(WINDOWS).find(n => before.views[n].exact >= 100)
      if (full) {
        const { headers } = unifiedHeaders(account.state, true)
        headers['anthropic-ratelimit-unified-representative-claim'] = full
        const reset = before.views[full].resetsAt
        if (reset) {
          headers['anthropic-ratelimit-unified-reset'] = String(Math.floor(Date.parse(reset) / 1000))
          headers['retry-after'] = String(Math.max(1, Math.ceil((Date.parse(reset) - Date.now()) / 1000)))
        }
        return anthropicError(ctx, res, 429, 'rate_limit_error', "This request would exceed your account's rate limit. Please try again later.", headers)
      }
      const charge = (_micros, usage) => {
        const now = Date.now()
        const after = store.update(account.id, (s) => {
          const settled = settle(s, now)
          for (const w of Object.values(settled.windows)) {
            w.used += planTokens(usage)
            w.start ??= new Date(now).toISOString()
          }
          return settled
        })
        for (const [name, value] of Object.entries(unifiedHeaders(after.state, false).headers)) res.setHeader(name, value)
      }
      return generate(ctx, { req, res, body, format: 'anthropic', account, provider: 'anthropic', catalog, charge, idPrefix: 'msg_', fail: fail(res) })
    }
    if (req.method === 'GET' && path === '/v1/models') {
      const data = catalog.models('anthropic').map(m => ({ type: 'model', id: m.id, display_name: m.name ?? m.id, created_at: '2025-01-01T00:00:00Z' }))
      return ctx.json(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null })
    }
    if (req.method === 'GET' && path === '/api/oauth/usage') {
      const window = n => { const v = windowOf(account.state, n); return { utilization: v.utilization, resets_at: v.resetsAt } }
      return ctx.json(res, 200, { five_hour: window('five_hour'), seven_day: window('seven_day'), seven_day_oauth_apps: null, seven_day_opus: null,
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null } })
    }
    if (req.method === 'GET' && path === '/api/oauth/profile') {
      const p = PLANS[account.state.plan]
      const name = account.credential.split('@')[0]
      return ctx.json(res, 200, {
        account: { uuid: account.state.uuid, full_name: name, display_name: name, email: account.credential, has_claude_pro: account.state.plan === 'pro', has_claude_max: account.state.plan !== 'pro', created_at: account.created },
        organization: { uuid: account.state.organizationUuid, name: `${account.credential}'s Organization`, organization_type: p.organizationType, billing_type: 'stripe_subscription', rate_limit_tier: p.tier, has_extra_usage_enabled: false },
      })
    }
    return anthropicError(ctx, res, 404, 'not_found_error', `${req.method} ${path} is not simulated`)
  }

  const authorize = async (req, res, path, body) => {
    if (path !== '/oauth/authorize' || !['GET', 'POST'].includes(req.method)) return ctx.json(res, 404, { error: 'not_found' })
    const params = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://sim').searchParams) : body
    const html = (status, page) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page) }
    let redirect
    try { redirect = new URL(params.redirect_uri ?? '') } catch { /* checked below */ }
    // Only a loopback callback: a simulated sign-in never sends the browser to a real site.
    if (params.response_type !== 'code' || !params.client_id || !redirect || redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)) {
      return html(400, '<!doctype html><title>Invalid request</title><p>Invalid OAuth request: response_type=code, a client_id and a loopback redirect_uri are required.</p>')
    }
    if (req.method === 'GET') return html(200, authorizePage(params))
    const email = String(params.email ?? '').trim().toLowerCase()
    if (!EMAIL.test(email)) return html(400, authorizePage(params, 'Enter a valid email address.'))
    if (params.plan && !PLANS[params.plan]) return html(400, authorizePage(params, 'Unknown plan.'))
    let account = store.account('anthropic', 'email', email, () => ({ ...anthropicState('email', email), ...(params.plan ? { plan: params.plan } : {}) }))
    if (params.plan && account.state.plan !== params.plan) account = store.update(account.id, s => ({ ...s, plan: params.plan }))
    const code = randomBytes(24).toString('base64url')
    store.issueToken({ token: code, account: account.id, kind: 'code', seconds: CODE_SECONDS, data: { redirectUri: params.redirect_uri, state: params.state ?? '', scope: params.scope ?? '' } })
    redirect.searchParams.set('code', code)
    if (params.state !== undefined) redirect.searchParams.set('state', params.state)
    res.writeHead(302, { location: redirect.href, 'cache-control': 'no-store' })
    return res.end()
  }

  const oauthError = (res, error, description) => ctx.json(res, 400, { error, error_description: description })
  const tokens = async (req, res, path, body) => {
    if (req.method !== 'POST' || path !== '/v1/oauth/token') return ctx.json(res, 404, { error: 'not_found' })
    if (!body.client_id) return oauthError(res, 'invalid_client', 'client_id is required')
    if (body.grant_type === 'authorization_code') {
      // The PKCE verifier is accepted without checking it against the challenge.
      const row = store.consumeToken(String(body.code ?? ''), 'code')
      if (!row) return oauthError(res, 'invalid_grant', "Invalid 'code' in request, verify that the code is correct.")
      if (row.data.redirectUri !== body.redirect_uri) return oauthError(res, 'invalid_grant', 'redirect_uri does not match the authorization request')
      return ctx.json(res, 200, issue(store.get(row.account)))
    }
    if (body.grant_type === 'refresh_token') {
      const row = store.consumeToken(String(body.refresh_token ?? ''), 'refresh')
      if (!row) return oauthError(res, 'invalid_grant', 'Refresh token not found or invalid')
      return ctx.json(res, 200, issue(store.get(row.account)))
    }
    return oauthError(res, 'unsupported_grant_type', `grant_type ${JSON.stringify(body.grant_type ?? null)} is not supported`)
  }

  const handler = async (req, res, path, body, host) => {
    if (host === 'claude.ai') return authorize(req, res, path, body)
    if (host === 'platform.claude.com' || host === 'console.anthropic.com') return tokens(req, res, path, body)
    return api(req, res, path, body)
  }
  /** Sign an email in without a browser (for /_sim/sign-in): its account, with fresh tokens. */
  handler.signIn = ({ email, plan, accessSeconds }) => {
    if (!EMAIL.test(String(email ?? ''))) throw new Error('an email address is required')
    if (plan !== undefined && !PLANS[plan]) throw new Error(`plan is one of ${Object.keys(PLANS).join(', ')}`)
    let account = store.account('anthropic', 'email', email, () => ({ ...anthropicState('email', email), ...(plan ? { plan } : {}) }))
    if (plan && account.state.plan !== plan) account = store.update(account.id, s => ({ ...s, plan }))
    return { account, ...issue(account, accessSeconds ?? ACCESS_SECONDS) }
  }
  return handler
}

export const name = 'anthropic'
export const hosts = ['api.anthropic.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com']
/** A new account's state. */
export const initialState = (kind, credential) => anthropicState(kind, credential)

export default { name, hosts, initialState, create }
