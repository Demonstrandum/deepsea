import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSimulator } from '../server.mjs'

const made = []
test.after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

/** A simulator on a free port with a priced Kimi API model and two Kimi Code models. */
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-provider-sim-moonshot-'))
  made.push(dir)
  const sim = await createSimulator({ db: join(dir, 'sim.sqlite') })
  const models = {
    moonshotai: [{ id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262144, cost: { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 0 } }],
    'kimi-coding': [{ id: 'kimi-for-coding', name: 'Kimi For Coding', cost: { input: 1, output: 4 } }, { id: 'kimi-for-coding-highspeed', name: 'Kimi For Coding (highspeed)', cost: { input: 2, output: 8 } }],
  }
  sim.catalog.models = provider => models[provider] ?? []
  sim.catalog.cost = (provider, id) => models[provider]?.find(m => m.id === id)?.cost
  await new Promise(resolve => sim.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${sim.server.address().port}`
  return { base, sim, close: () => new Promise(resolve => { sim.server.close(() => { sim.store.close(); resolve() }) }) }
}

const jsonPost = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const formPost = (url, fields, extra = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), ...extra })
const usageScript = (input, output = 10) => `{"cmd":"say","text":"ok"}\n{"cmd":"usage","input":${input},"output":${output}}`
const chat = (base, key, body, host = 'api.moonshot.ai') => jsonPost(`${base}/${host}/v1/chat/completions`, { model: 'kimi-k2.6', ...body }, key ? { authorization: `Bearer ${key}` } : {})
const user = text => ({ messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: text }] })
const events = text => text.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)))

test('Kimi API: chat completions whole and streamed, reasoning_content, usage in the choice, balance and Moonshot errors', async () => {
  const { base, sim, close } = await start()
  try {
    const anonymous = await chat(base, undefined, user('say hi'))
    assert.deepEqual([anonymous.status, (await anonymous.json()).error], [401, { message: 'Incorrect API key provided', type: 'incorrect_api_key_error' }])

    const whole = await (await chat(base, 'sk-test', user(usageScript(1000, 500)))).json()
    assert.deepEqual([whole.object, whole.choices[0].message, whole.choices[0].finish_reason, whole.usage], ['chat.completion', { role: 'assistant', content: 'ok' }, 'stop',
      { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, cached_tokens: 0 }])
    // 1000 × $1 + 500 × $4 per million tokens = 3 000 micro-dollars.
    assert.equal(sim.store.accounts('moonshot')[0].state.balanceMicros, 10_000_000 - 3000)

    const script = '{"cmd":"think","text":"pondering"}\n{"cmd":"say","text":"hello"}\n{"cmd":"tool","name":"read","args":{"path":"a.txt"}}'
    const streamed = events(await (await chat(base, 'sk-test', { ...user(script), stream: true, stream_options: { include_usage: true } })).text())
    assert.equal(streamed[0].object, 'chat.completion.chunk')
    assert.equal(streamed.map(e => e.choices[0].delta.reasoning_content ?? '').join(''), 'pondering')
    assert.equal(streamed.map(e => e.choices[0].delta.content ?? '').join(''), 'hello')
    const calls = streamed.flatMap(e => e.choices[0].delta.tool_calls ?? [])
    assert.equal(calls[0].function.name, 'read')
    assert.ok(calls.length > 2, 'arguments arrive in pieces')
    assert.deepEqual(JSON.parse(calls.map(c => c.function.arguments).join('')), { path: 'a.txt' })
    const last = streamed.at(-1)
    assert.equal(last.usage, undefined)
    assert.deepEqual([last.choices[0].finish_reason, Object.keys(last.choices[0].usage)], ['tool_calls', ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens']])

    const models = await (await fetch(`${base}/api.moonshot.ai/v1/models`, { headers: { authorization: 'Bearer sk-test' } })).json()
    assert.deepEqual([models.object, models.data[0].id, models.data[0].owned_by], ['list', 'kimi-k2.6', 'moonshot'])
    const unknown = await chat(base, 'sk-test', { ...user('say hi'), model: 'kimi-k9' })
    assert.deepEqual([unknown.status, (await unknown.json()).error.type], [404, 'resource_not_found_error'])
    const overloaded = await chat(base, 'sk-test', user('{"cmd":"error","kind":"overloaded","status":429,"message":"The engine is currently overloaded, please try again later"}'))
    assert.deepEqual([overloaded.status, (await overloaded.json()).error.type], [429, 'engine_overloaded_error'])

    await jsonPost(`${base}/_sim/account`, { provider: 'moonshot', credential: 'sk-test', state: { balanceMicros: 0 } })
    const broke = await chat(base, 'sk-test', user('say hi'))
    const error = (await broke.json()).error
    assert.deepEqual([broke.status, error.type], [429, 'exceeded_current_quota_error'])
    assert.match(error.message, /^Your account d[0-9a-f]+<ak-[0-9a-f]+> is suspended, please check your plan and billing details$/)
    // api.moonshot.cn is the same API (moonshotai-cn's catalog).
    assert.equal((await chat(base, 'sk-cn', user('say hi'), 'api.moonshot.cn')).status, 200)
  } finally { await close() }
})

test('Kimi Code Plan: device code, the page a person enters it on, polling, refresh, messages and the five-hour quota', async () => {
  const { base, sim, close } = await start()
  try {
    const authorize = await (await formPost(`${base}/auth.kimi.com/api/oauth/device_authorization`, { client_id: 'client' })).json()
    assert.equal(authorize.interval, 5)
    assert.match(authorize.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    assert.equal(authorize.verification_uri_complete, `https://www.kimi.com/code/authorize_device?user_code=${authorize.user_code}`)

    const token = fields => formPost(`${base}/auth.kimi.com/api/oauth/token`, { client_id: 'client', ...fields })
    const poll = () => token({ device_code: authorize.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    const pending = await poll()
    assert.deepEqual([pending.status, (await pending.json()).error], [400, 'authorization_pending'])

    // The page, as the harness rewrites the verification link to the simulator.
    const pageUrl = `${base}/www.kimi.com/code/authorize_device?user_code=${authorize.user_code}`
    const html = await (await fetch(pageUrl)).text()
    assert.match(html, new RegExp(`id="user_code"[^>]*value="${authorize.user_code}"`))
    assert.match(html, /<form method="post" action="authorize_device"/)
    const submit = fields => formPost(`${base}/www.kimi.com/code/authorize_device`, { user_code: authorize.user_code, plan: '', decision: 'allow', ...fields })
    assert.equal((await submit({ email: 'not-an-email' })).status, 400)
    assert.equal((await submit({ user_code: 'ZZZZ-ZZZZ', email: 'plan@example.com' })).status, 400)
    const allowed = await submit({ user_code: authorize.user_code.toLowerCase().replace('-', ''), email: 'Plan@Example.com' })
    assert.equal(allowed.status, 200)
    assert.match(await allowed.text(), /id="sim-authorized"/)

    const granted = await (await poll()).json()
    assert.deepEqual([granted.token_type, granted.expires_in, typeof granted.refresh_token], ['Bearer', 900, 'string'])
    assert.match(granted.access_token, /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/)
    assert.equal((await poll()).status, 400, 'a device code is used once')

    const messages = (headers, body) => jsonPost(`${base}/api.kimi.com/coding/v1/messages`, { model: 'kimi-for-coding', max_tokens: 1024, messages: [{ role: 'user', content: 'say from the plan' }], ...body }, { 'anthropic-version': '2023-06-01', ...headers })
    const reply = await messages({ authorization: `Bearer ${granted.access_token}` })
    assert.deepEqual((await reply.json()).content, [{ type: 'text', text: 'from the plan' }])
    const stream = await (await messages({ authorization: `Bearer ${granted.access_token}` }, { stream: true })).text()
    assert.match(stream, /event: message_start/)
    const account = sim.store.accounts('moonshot').find(a => a.credential === 'plan@example.com')
    assert.deepEqual([account.kind, account.state.plan, account.state.window.used], ['email', 'pro', 2])
    assert.equal((await messages({ authorization: 'Bearer eyJunknown.token.value' })).status, 401)
    assert.equal((await chat(base, granted.access_token, user('say hi'))).status, 401, 'a Kimi Code sign-in is no Kimi API key')

    // Refresh rotates both tokens; a used refresh token is refused as pi-ai expects (invalid_grant).
    const refreshed = await (await token({ grant_type: 'refresh_token', refresh_token: granted.refresh_token })).json()
    assert.ok(refreshed.access_token !== granted.access_token && refreshed.refresh_token !== granted.refresh_token)
    const reused = await token({ grant_type: 'refresh_token', refresh_token: granted.refresh_token })
    assert.deepEqual([reused.status, (await reused.json()).error], [400, 'invalid_grant'])
    assert.equal((await messages({ authorization: `Bearer ${refreshed.access_token}` })).status, 200)

    // A model above the plan, then a full five-hour window.
    await jsonPost(`${base}/_sim/account`, { provider: 'moonshot', kind: 'email', credential: 'plan@example.com', state: { plan: 'plus' } })
    const denied = await messages({ authorization: `Bearer ${refreshed.access_token}` }, { model: 'kimi-for-coding-highspeed' })
    assert.equal(denied.status, 401)
    assert.match((await denied.json()).error.message, /^Your current subscription does not have access to kimi-for-coding-highspeed\./)
    await jsonPost(`${base}/_sim/account`, { provider: 'moonshot', kind: 'email', credential: 'plan@example.com', state: { window: { used: 200, start: new Date().toISOString() } } })
    const full = await messages({ authorization: `Bearer ${refreshed.access_token}` })
    assert.equal(full.status, 403)
    assert.deepEqual((await full.json()).error.type, 'permission_error')
    // Six hours later the window is empty again.
    await jsonPost(`${base}/_sim/account`, { provider: 'moonshot', kind: 'email', credential: 'plan@example.com', state: { window: { used: 200, start: new Date(Date.now() - 6 * 3600_000).toISOString() } } })
    assert.equal((await messages({ authorization: `Bearer ${refreshed.access_token}` })).status, 200)

    // A Kimi Code key (KIMI_API_KEY, x-api-key) draws on its own plan; expired and denied sign-ins.
    assert.equal((await messages({ 'x-api-key': 'sk-kimi-test' })).status, 200)
    const expired = await (await jsonPost(`${base}/_sim/sign-in`, { provider: 'moonshot', email: 'plan@example.com', accessSeconds: -1 })).json()
    assert.equal((await messages({ authorization: `Bearer ${expired.access_token}` })).status, 401)
    const second = await (await formPost(`${base}/auth.kimi.com/api/oauth/device_authorization`, { client_id: 'client' })).json()
    await formPost(`${base}/www.kimi.com/code/authorize_device`, { user_code: second.user_code, decision: 'deny' })
    const refused = await token({ device_code: second.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    assert.deepEqual([refused.status, (await refused.json()).error], [400, 'access_denied'])
  } finally { await close() }
})
