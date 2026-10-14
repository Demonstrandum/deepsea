import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSimulator } from '../server.mjs'
import { costMicros } from '../providers.mjs'
import { normalize, promptOf } from '../wire.mjs'

const made = []
test.after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

/** A simulator on a free port with a tiny catalog; returns its base URL and a closer. */
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'deepsea-provider-sim-test-'))
  made.push(dir)
  const sim = await createSimulator({ db: join(dir, 'sim.sqlite') })
  // A catalog of two priced models, standing in for pi-ai's generated files.
  sim.catalog.cost = (provider, model) => ({ 'openrouter/vendor/model': { input: 1, output: 2 }, 'deepseek/deepseek-v4-pro': { input: 1.32, output: 3.96 } })[`${provider}/${model}`]
  await new Promise(resolve => sim.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${sim.server.address().port}`
  return { base, sim, close: () => new Promise(resolve => { sim.server.close(() => { sim.store.close(); resolve() }) }) }
}

const post = (url, body, key) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) })
const sse = async response => (await response.text()).split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => JSON.parse(l.slice(6)))

test('the prompt is the message that starts the turn; context after it and tool results are not', () => {
  const openai = normalize('openai', [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: [{ type: 'text', text: '{"cmd":"say","text":"x"}' }] },
    { role: 'user', content: 'runtime context' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'result one' },
  ])
  assert.deepEqual(promptOf(openai), { prompt: '{"cmd":"say","text":"x"}', position: 1, lastResults: [{ id: 'c1', text: 'result one' }] })
  const anthropic = normalize('anthropic', [
    { role: 'user', content: [{ type: 'text', text: 'say hi' }, { type: 'text', text: 'context' }] },
  ])
  assert.deepEqual(promptOf(anthropic), { prompt: 'say hi', position: 0, lastResults: [] })
  assert.equal(costMicros({ input: 1, output: 2 }, { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }), 2000)
})

test('openrouter: an account per key, scripted streams in both formats, cost lookup, credit, and 402 when it runs out', async () => {
  const { base, sim, close } = await start()
  try {
    assert.equal((await post(`${base}/openrouter.ai/api/v1/chat/completions`, { model: 'vendor/model', messages: [] })).status, 401)
    const script = '{"cmd":"think","text":"hmm"}\n{"cmd":"say","text":"hello there","chunks":2}\n{"cmd":"usage","input":1000,"output":500}'
    const chunks = await sse(await post(`${base}/openrouter.ai/api/v1/chat/completions`, { model: 'vendor/model', stream: true, messages: [{ role: 'user', content: script }] }, 'sk-or-test'))
    assert.equal(chunks.map(c => c.choices[0].delta.content ?? '').join(''), 'hello there')
    assert.equal(chunks.map(c => c.choices[0].delta.reasoning ?? '').join(''), 'hmm')
    const last = chunks.at(-1)
    assert.deepEqual([last.choices[0].finish_reason, last.usage.prompt_tokens, last.usage.completion_tokens, last.usage.cost], ['stop', 1000, 500, 0.002])
    const generation = await (await fetch(`${base}/openrouter.ai/api/v1/generation?id=${last.id}`, { headers: { authorization: 'Bearer sk-or-test' } })).json()
    assert.equal(generation.data.total_cost, 0.002)
    assert.equal((await fetch(`${base}/openrouter.ai/api/v1/generation?id=${last.id}`, { headers: { authorization: 'Bearer someone-else' } })).status, 404)
    const credits = await (await fetch(`${base}/openrouter.ai/api/v1/credits`, { headers: { authorization: 'Bearer sk-or-test' } })).json()
    assert.deepEqual(credits.data, { total_credits: 10, total_usage: 0.002 })
    // A tool call in the Anthropic format, then the script's next response once the result is back.
    const tool = '{"cmd":"tool","name":"read","args":{"path":"a.txt"},"id":"t1"}\n{"cmd":"expect","contains":"alpha"}\n{"cmd":"say","text":"done"}'
    const first = await (await post(`${base}/openrouter.ai/api/v1/messages`, { model: 'vendor/model', messages: [{ role: 'user', content: tool }] }, 'sk-or-test')).json()
    assert.deepEqual([first.stop_reason, first.content[0].type, first.content[0].name, first.content[0].input], ['tool_use', 'tool_use', 'read', { path: 'a.txt' }])
    const history = [{ role: 'user', content: tool }, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'alpha beta' }] }]
    const second = await (await post(`${base}/openrouter.ai/api/v1/messages`, { model: 'vendor/model', messages: history }, 'sk-or-test')).json()
    assert.deepEqual(second.content, [{ type: 'text', text: 'done' }])
    history[2].content[0].content = 'gamma'
    const failed = await post(`${base}/openrouter.ai/api/v1/messages`, { model: 'vendor/model', messages: history }, 'sk-or-test')
    assert.equal(failed.status, 400)
    assert.match((await failed.json()).error.message, /expected text containing "alpha"/)
    // Spend the account's credit; the next request is refused.
    await post(`${base}/_sim/account`, { provider: 'openrouter', credential: 'sk-or-test', state: { usageMicros: 10_000_000 } })
    const broke = await post(`${base}/openrouter.ai/api/v1/chat/completions`, { model: 'vendor/model', messages: [{ role: 'user', content: 'say hi' }] }, 'sk-or-test')
    assert.equal(broke.status, 402)
    assert.equal(sim.store.accounts('openrouter').length, 2)
  } finally { await close() }
})

test('deepseek: Anthropic messages for its own adapter, plain prompts, balance, errors with retry-after, unknown hosts', async () => {
  const { base, close } = await start()
  try {
    const stream = await (await fetch(`${base}/api.deepseek.com/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'sk-ds', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro', stream: true, messages: [{ role: 'user', content: 'say XXXX YYY ZZZ' }] }) })).text()
    const events = stream.split('\n').filter(l => l.startsWith('event: ')).map(l => l.slice(7))
    assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    assert.match(stream, /"text":"XXXX YYY ZZZ"/)
    const balance = await (await fetch(`${base}/api.deepseek.com/user/balance`, { headers: { authorization: 'Bearer sk-ds' } })).json()
    assert.deepEqual([balance.is_available, balance.balance_infos[0].currency], [true, 'USD'])
    const [account] = (await (await fetch(`${base}/_sim/accounts?provider=deepseek`)).json()).accounts
    assert.ok(account.state.balanceMicros < 10_000_000 && account.state.balanceMicros > 9_999_000, String(account.state.balanceMicros))
    const limited = await post(`${base}/api.deepseek.com/chat/completions`, { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: '{"cmd":"error","kind":"rate-limit","retryAfter":3,"times":1}\n{"cmd":"say","text":"ok"}' }] }, 'sk-ds')
    assert.deepEqual([limited.status, limited.headers.get('retry-after')], [429, '3'])
    const retried = await (await post(`${base}/api.deepseek.com/chat/completions`, { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: '{"cmd":"error","kind":"rate-limit","retryAfter":3,"times":1}\n{"cmd":"say","text":"ok"}' }] }, 'sk-ds')).json()
    assert.equal(retried.choices[0].message.content, 'ok')
    const unknown = await post(`${base}/api.example-llm.com/v1/chat`, {}, 'k')
    assert.equal(unknown.status, 501)
  } finally { await close() }
})
