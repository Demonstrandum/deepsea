import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSimulator } from '../server.mjs'

const made = []
test.after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

/** A simulator on a free port with one priced Anthropic model. */
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-provider-sim-anthropic-'))
  made.push(dir)
  const sim = await createSimulator({ db: join(dir, 'sim.sqlite') })
  const model = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } }
  sim.catalog.cost = (provider, id) => provider === 'anthropic' && id === model.id ? model.cost : undefined
  sim.catalog.models = provider => provider === 'anthropic' ? [model] : []
  await new Promise(resolve => sim.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${sim.server.address().port}`
  return { base, sim, close: () => new Promise(resolve => { sim.server.close(() => { sim.store.close(); resolve() }) }) }
}

const VERSION = { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
const OAUTH = { ...VERSION, 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20' }
const messages = (base, headers, body) => fetch(`${base}/api.anthropic.com/v1/messages?beta=true`, { method: 'POST', headers, body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1024, ...body }) })
const prompt = text => ({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
const usageScript = (input, output = 10) => `{"cmd":"say","text":"ok"}\n{"cmd":"usage","input":${input},"output":${output}}`
const jsonPost = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('anthropic API key: messages whole and streamed, credit at catalog prices, models, and Anthropic\'s errors', async () => {
  const { base, sim, close } = await start()
  try {
    const key = { ...VERSION, 'x-api-key': 'sk-ant-api03-test' }
    const noVersion = await messages(base, { 'x-api-key': 'k', 'content-type': 'application/json' }, prompt('say hi'))
    assert.equal(noVersion.status, 400)
    const anonymous = await messages(base, VERSION, prompt('say hi'))
    assert.deepEqual([anonymous.status, (await anonymous.json()).error], [401, { type: 'authentication_error', message: 'x-api-key header is required' }])

    const whole = await messages(base, key, prompt(usageScript(1000, 500)))
    assert.ok(whole.headers.get('request-id')?.startsWith('req_'))
    const body = await whole.json()
    assert.deepEqual([body.type, body.content, body.stop_reason, body.usage.input_tokens, body.usage.output_tokens], ['message', [{ type: 'text', text: 'ok' }], 'end_turn', 1000, 500])
    // 1000 × $4 + 500 × $20 per million tokens = 14 000 micro-dollars.
    assert.equal(sim.store.accounts('anthropic')[0].state.balanceMicros, 10_000_000 - 14_000)

    const stream = await (await messages(base, key, { ...prompt('say streamed reply'), stream: true })).text()
    assert.deepEqual(stream.split('\n').filter(l => l.startsWith('event: ')).map(l => l.slice(7)),
      ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    assert.match(stream, /"text":"streamed reply"/)

    const models = await (await fetch(`${base}/api.anthropic.com/v1/models`, { headers: key })).json()
    assert.deepEqual([models.data[0].id, models.data[0].type, models.has_more], ['claude-opus-5-5', 'model', false])

    const limited = await messages(base, key, prompt('{"cmd":"error","kind":"rate-limit","retryAfter":7}'))
    assert.deepEqual([limited.status, limited.headers.get('retry-after'), (await limited.json()).error.type], [429, '7', 'rate_limit_error'])
    const overloaded = await messages(base, key, prompt('{"cmd":"error","kind":"overloaded","message":"Overloaded"}'))
    assert.deepEqual([overloaded.status, (await overloaded.json()).error], [529, { type: 'overloaded_error', message: 'Overloaded' }])

    await jsonPost(`${base}/_sim/account`, { provider: 'anthropic', credential: 'sk-ant-api03-test', state: { balanceMicros: 0 } })
    const broke = await messages(base, key, prompt('say hi'))
    assert.equal(broke.status, 400)
    assert.deepEqual((await broke.json()).error, { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' })
  } finally { await close() }
})

test('anthropic Plan: authorize form, code and state, token, refresh, messages, usage and profile', async () => {
  const { base, close } = await start()
  try {
    const query = new URLSearchParams({ code: 'true', client_id: 'client', response_type: 'code', redirect_uri: 'http://localhost:53692/callback',
      scope: 'user:inference user:profile', code_challenge: 'challenge', code_challenge_method: 'S256', state: 'verifier-1' })
    const page = await fetch(`${base}/claude.ai/oauth/authorize?${query}`)
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.match(html, /<form method="post" action="authorize"/)
    assert.match(html, /name="email"/)
    assert.match(html, /<option value="max5">Max 5×<\/option>/)
    const elsewhere = new URLSearchParams(query)
    elsewhere.set('redirect_uri', 'https://example.com/callback')
    assert.equal((await fetch(`${base}/claude.ai/oauth/authorize?${elsewhere}`)).status, 400)

    // The form posts back with its hidden fields; a bad email shows the form again.
    const form = (fields) => fetch(`${base}/claude.ai/oauth/authorize`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(query), ...fields }) })
    assert.equal((await form({ email: 'not-an-email', plan: '' })).status, 400)
    const redirected = await form({ email: 'Plan@Example.com', plan: '' })
    assert.equal(redirected.status, 302)
    const callback = new URL(redirected.headers.get('location'))
    assert.deepEqual([callback.origin + callback.pathname, callback.searchParams.get('state')], ['http://localhost:53692/callback', 'verifier-1'])
    const code = callback.searchParams.get('code')

    const tokenUrl = `${base}/platform.claude.com/v1/oauth/token`
    const exchange = { grant_type: 'authorization_code', client_id: 'client', code, state: 'verifier-1', redirect_uri: 'http://localhost:53692/callback', code_verifier: 'verifier-1' }
    const granted = await (await jsonPost(tokenUrl, exchange)).json()
    assert.match(granted.access_token, /^sk-ant-oat01-/)
    assert.match(granted.refresh_token, /^sk-ant-ort01-/)
    assert.deepEqual([granted.expires_in, granted.account.email_address], [3600, 'plan@example.com'])
    const reused = await jsonPost(tokenUrl, exchange)
    assert.deepEqual([reused.status, (await reused.json()).error], [400, 'invalid_grant'])

    const bearer = access => ({ ...OAUTH, authorization: `Bearer ${access}` })
    const reply = await messages(base, bearer(granted.access_token), prompt('say from the plan'))
    assert.equal(reply.status, 200)
    assert.equal(reply.headers.get('anthropic-ratelimit-unified-status'), 'allowed')
    assert.match(reply.headers.get('anthropic-ratelimit-unified-5h-reset'), /^\d+$/)
    assert.deepEqual((await reply.json()).content, [{ type: 'text', text: 'from the plan' }])
    const noBeta = await messages(base, { ...VERSION, authorization: `Bearer ${granted.access_token}` }, prompt('say hi'))
    assert.deepEqual([noBeta.status, (await noBeta.json()).error.message], [401, 'OAuth authentication is currently not supported.'])

    // The harness's reads (subscription-usage.ts): utilization numbers and parseable reset times.
    const read = async (path, access) => (await fetch(`${base}/api.anthropic.com${path}`, { headers: { authorization: `Bearer ${access}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' } })).json()
    const usage = await read('/api/oauth/usage', granted.access_token)
    for (const window of [usage.five_hour, usage.seven_day]) {
      assert.equal(typeof window.utilization, 'number')
      assert.ok(Number.isFinite(Date.parse(window.resets_at)))
    }
    assert.ok(Date.parse(usage.five_hour.resets_at) - Date.now() > 4.9 * 3600_000)
    const profile = await read('/api/oauth/profile', granted.access_token)
    assert.deepEqual([profile.account.email, profile.organization.organization_type, profile.organization.rate_limit_tier], ['plan@example.com', 'claude_max', 'default_claude_max_5x'])
    assert.ok(profile.account.uuid && profile.organization.uuid)

    // Refresh rotates the refresh token; the old access token stays valid until it expires.
    const refreshed = await (await jsonPost(tokenUrl, { grant_type: 'refresh_token', client_id: 'client', refresh_token: granted.refresh_token })).json()
    assert.ok(refreshed.access_token !== granted.access_token && refreshed.refresh_token !== granted.refresh_token)
    assert.equal((await jsonPost(tokenUrl, { grant_type: 'refresh_token', client_id: 'client', refresh_token: granted.refresh_token })).status, 400)
    assert.equal((await messages(base, bearer(refreshed.access_token), prompt('say hi'))).status, 200)
    assert.equal((await messages(base, bearer(granted.access_token), prompt('say hi'))).status, 200)

    // An expired access token, issued by the simulator's own sign-in.
    const expired = await (await jsonPost(`${base}/_sim/sign-in`, { provider: 'anthropic', email: 'plan@example.com', accessSeconds: -1 })).json()
    const stale = await messages(base, bearer(expired.access_token), prompt('say hi'))
    assert.deepEqual([stale.status, (await stale.json()).error.type], [401, 'authentication_error'])
    assert.equal((await messages(base, bearer('sk-ant-oat01-unknown'), prompt('say hi'))).status, 401)

    // The plan chosen on the form, for a new account.
    const pro = await form({ email: 'pro@example.com', plan: 'pro' })
    const proCode = new URL(pro.headers.get('location')).searchParams.get('code')
    const proTokens = await (await jsonPost(tokenUrl, { ...exchange, code: proCode })).json()
    assert.equal((await read('/api/oauth/profile', proTokens.access_token)).organization.organization_type, 'claude_pro')
  } finally { await close() }
})

test('anthropic Plan windows fill up, warn, answer 429 at 100%, and reset', async () => {
  const { base, close } = await start()
  try {
    const signed = await (await jsonPost(`${base}/_sim/sign-in`, { provider: 'anthropic', email: 'limits@example.com', plan: 'max5' })).json()
    const headers = { ...OAUTH, authorization: `Bearer ${signed.access_token}` }
    const usage = async () => (await fetch(`${base}/api.anthropic.com/api/oauth/usage`, { headers })).json()
    const fresh = await usage()
    assert.deepEqual(fresh.five_hour, { utilization: 0, resets_at: null })

    // Max 5×: five million tokens in five hours. Four million is 80%: a warning.
    const warned = await messages(base, headers, prompt(usageScript(4_000_000 - 10)))
    assert.equal(warned.status, 200)
    assert.deepEqual([warned.headers.get('anthropic-ratelimit-unified-status'), warned.headers.get('anthropic-ratelimit-unified-5h-utilization'),
      warned.headers.get('anthropic-ratelimit-unified-representative-claim')], ['allowed_warning', '0.8', 'five_hour'])
    assert.deepEqual([(await usage()).five_hour.utilization, (await usage()).seven_day.utilization], [80, 8])

    // The request that crosses 100% is served; the next one is refused until the window resets.
    assert.equal((await messages(base, headers, prompt(usageScript(1_000_000 - 10)))).status, 200)
    const refused = await messages(base, headers, prompt('say hi'))
    assert.equal(refused.status, 429)
    assert.deepEqual((await refused.json()).error, { type: 'rate_limit_error', message: "This request would exceed your account's rate limit. Please try again later." })
    assert.deepEqual([refused.headers.get('anthropic-ratelimit-unified-status'), refused.headers.get('anthropic-ratelimit-unified-representative-claim')], ['rejected', 'five_hour'])
    const retryAfter = Number(refused.headers.get('retry-after'))
    assert.ok(retryAfter > 4.9 * 3600 && retryAfter <= 5 * 3600, String(retryAfter))
    assert.equal((await usage()).five_hour.utilization, 100)

    // Six hours later the five-hour window is empty again; the seven-day one is not.
    const started = new Date(Date.now() - 6 * 3600_000).toISOString()
    await jsonPost(`${base}/_sim/account`, { provider: 'anthropic', kind: 'email', credential: 'limits@example.com',
      state: { windows: { five_hour: { used: 5_000_000, start: started }, seven_day: { used: 5_000_000, start: started } } } })
    const later = await usage()
    assert.deepEqual([later.five_hour, later.seven_day.utilization], [{ utilization: 0, resets_at: null }, 10])
    assert.equal((await messages(base, headers, prompt('say hi'))).status, 200)
  } finally { await close() }
})
