import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSimulator } from '../server.mjs'

const made = []
test.after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

/** A simulator on a free port with a priced and a free GLM model. */
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-provider-sim-zai-'))
  made.push(dir)
  const sim = await createSimulator({ db: join(dir, 'sim.sqlite') })
  const models = [{ id: 'glm-5.3', cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } }, { id: 'glm-5.3-highspeed', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
  sim.catalog.models = provider => provider === 'zai' || provider === 'zai-coding-cn' ? models : []
  sim.catalog.cost = (provider, id) => sim.catalog.models(provider).find(m => m.id === id)?.cost
  await new Promise(resolve => sim.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${sim.server.address().port}`
  return { base, sim, close: () => new Promise(resolve => { sim.server.close(() => { sim.store.close(); resolve() }) }) }
}

const jsonPost = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const chat = (base, key, body, host = 'api.z.ai') => jsonPost(`${base}/${host}/api/coding/paas/v4/chat/completions`, { model: 'glm-5.3', ...body }, key ? { authorization: `Bearer ${key}` } : {})
const user = text => ({ messages: [{ role: 'user', content: text }] })
const events = text => text.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)))
const TOOL = '{"cmd":"think","text":"hmm"}\n{"cmd":"tool","name":"read","args":{"path":"a.txt"}}'

test('Z.ai: chat completions, reasoning_content, tool_stream, usage, money at catalog prices and Z.ai\'s errors', async () => {
  const { base, sim, close } = await start()
  try {
    const anonymous = await chat(base, undefined, user('say hi'))
    assert.deepEqual([anonymous.status, await anonymous.json()], [401, { error: { code: '1001', message: 'Authentication parameter not received in Header, unable to authenticate' } }])

    const whole = await (await chat(base, 'zai-test', { ...user('{"cmd":"say","text":"ok"}\n{"cmd":"usage","input":1000,"output":500}'), thinking: { type: 'disabled' } })).json()
    assert.equal(whole.object, undefined)
    assert.match(whole.id, /^\d{14}/)
    assert.deepEqual([whole.choices[0].message, whole.usage], [{ role: 'assistant', content: 'ok' }, { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 0 } }])
    // 1000 × $1.4 + 500 × $4.4 per million tokens = 3 600 micro-dollars.
    assert.equal(sim.store.accounts('zai')[0].state.balanceMicros, 10_000_000 - 3600)

    // pi-ai asks for tool_stream when it sends tools: the arguments come in pieces; without it, whole.
    const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }]
    const piecewise = events(await (await chat(base, 'zai-test', { ...user(TOOL), stream: true, tools, tool_stream: true, thinking: { type: 'enabled', clear_thinking: false } })).text())
    assert.equal(piecewise[0].object, undefined)
    assert.ok(piecewise.every(e => e.choices[0].delta.role === 'assistant'))
    assert.equal(piecewise.map(e => e.choices[0].delta.reasoning_content ?? '').join(''), 'hmm')
    const pieces = piecewise.flatMap(e => e.choices[0].delta.tool_calls ?? [])
    assert.ok(pieces.length > 2)
    assert.deepEqual(JSON.parse(pieces.map(c => c.function.arguments).join('')), { path: 'a.txt' })
    const last = piecewise.at(-1)
    assert.deepEqual([last.choices[0].finish_reason, Object.keys(last.usage)], ['tool_calls', ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details']])
    const atOnce = events(await (await chat(base, 'zai-test', { ...user(TOOL), stream: true, tools })).text()).flatMap(e => e.choices[0].delta.tool_calls ?? [])
    assert.deepEqual([atOnce.length, JSON.parse(atOnce[0].function.arguments)], [1, { path: 'a.txt' }])

    const models = await (await fetch(`${base}/api.z.ai/api/coding/paas/v4/models`, { headers: { authorization: 'Bearer zai-test' } })).json()
    assert.deepEqual(models.data.map(m => m.id), ['glm-5.3', 'glm-5.3-highspeed'])
    const unknown = await chat(base, 'zai-test', { ...user('say hi'), model: 'glm-9' })
    assert.deepEqual([unknown.status, (await unknown.json()).error.code], [400, '1211'])
    const limited = await chat(base, 'zai-test', user('{"cmd":"error","kind":"rate-limit","retryAfter":3}'))
    assert.deepEqual([limited.status, limited.headers.get('retry-after'), (await limited.json()).error.code], [429, '3', '1302'])

    // No money left: the priced models answer 1113; the free ones still run on the plan.
    await jsonPost(`${base}/_sim/account`, { provider: 'zai', credential: 'zai-test', state: { balanceMicros: 0 } })
    const broke = await chat(base, 'zai-test', user('say hi'))
    assert.deepEqual([broke.status, await broke.json()], [429, { error: { code: '1113', message: 'Insufficient balance or no resource package. Please recharge.' } }])
    assert.equal((await chat(base, 'zai-test', { ...user('say hi'), model: 'glm-5.3-highspeed' })).status, 200)
    // open.bigmodel.cn is the same API (zai-coding-cn's catalog).
    assert.equal((await chat(base, 'zai-cn', user('say hi'), 'open.bigmodel.cn')).status, 200)
  } finally { await close() }
})

test('Z.ai Coding Plan: the five-hour prompt quota answers 1308 until the window ends', async () => {
  const { base, close } = await start()
  try {
    const started = new Date(Date.now() - 3600_000)
    await jsonPost(`${base}/_sim/account`, { provider: 'zai', credential: 'zai-lite', state: { plan: 'lite', window: { used: 119, start: started.toISOString() } } })
    assert.equal((await chat(base, 'zai-lite', user('say hi'))).status, 200)
    const full = await chat(base, 'zai-lite', { ...user('say hi'), model: 'glm-5.3-highspeed' })
    const error = (await full.json()).error
    assert.deepEqual([full.status, error.code], [429, '1308'])
    const reset = new Date(started.getTime() + 5 * 3600_000 + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
    assert.equal(error.message, `Usage limit reached for 5 hour. Your limit will reset at ${reset}`)
    await jsonPost(`${base}/_sim/account`, { provider: 'zai', credential: 'zai-lite', state: { window: { used: 120, start: new Date(Date.now() - 6 * 3600_000).toISOString() } } })
    assert.equal((await chat(base, 'zai-lite', user('say hi'))).status, 200)
  } finally { await close() }
})
