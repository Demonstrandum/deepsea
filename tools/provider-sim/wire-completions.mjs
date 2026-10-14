/**
 * Chat completions as Moonshot (the Kimi API) and Z.ai (GLM) put them on the
 * wire, where they differ from OpenAI's (wire.mjs). Both put reasoning in
 * `reasoning_content`. Moonshot's chunks are OpenAI's, but the final usage
 * rides in the choice (`choices[0].usage`, with Kimi's top-level
 * `cached_tokens`), not in a chunk of its own. Z.ai's chunks have no `object`
 * and no `finish_reason: null`, every delta repeats `role`, the usage of the
 * last chunk has `prompt_tokens_details.cached_tokens`, and a tool call's
 * arguments arrive in pieces only when the request asks for `tool_stream`
 * (else whole, in one chunk).
 *
 * `playCompletion()` is common.mjs's `generate()` for these dialects: the
 * script's response for this point of the turn, recorded and charged, then
 * streamed or answered whole.
 */
import { chunk } from '../../packages/script/index.mjs'
import { costMicros, generationId } from './common.mjs'
import { blocksOf, normalize, respond, usageOf } from './wire.mjs'

const sleep = (seconds, signal) => new Promise((resolve) => {
  if (!seconds || signal?.aborted) { resolve(); return }
  const timer = setTimeout(resolve, seconds * 1000)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

let toolCounter = 0
const toolId = given => given ?? `call_${Date.now().toString(36)}${(++toolCounter).toString(36)}`

const finishReason = finish => finish === 'tool' ? 'tool_calls' : finish === 'max-tokens' ? 'length' : 'stop'

/** The usage object of a dialect. */
function usageBody(dialect, usage) {
  const counts = { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output }
  return dialect === 'zai' ? { ...counts, prompt_tokens_details: { cached_tokens: usage.cacheRead } } : { ...counts, cached_tokens: usage.cacheRead }
}

/**
 * Stream a response as a dialect's chat-completion chunks.
 * @param {import('node:http').ServerResponse} res
 * @param {{ dialect: 'moonshot'|'zai', id: string, model: string, steps: object[], usage: object, toolStream: boolean, signal?: AbortSignal }} r
 */
export async function completionStream(res, r) {
  const { blocks, finish } = blocksOf(r.steps)
  const zai = r.dialect === 'zai'
  const created = Math.floor(Date.now() / 1000)
  const head = zai ? { id: r.id, created, model: r.model } : { id: r.id, object: 'chat.completion.chunk', created, model: r.model }
  const write = value => res.write(`data: ${JSON.stringify(value)}\n\n`)
  const send = delta => write({ ...head, choices: [zai ? { index: 0, delta: { role: 'assistant', ...delta } } : { index: 0, delta, finish_reason: null }] })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  if (!zai) send({ role: 'assistant', content: '' })
  let toolIndex = 0
  for (const b of blocks) {
    if (r.signal?.aborted) break
    if (b.type === 'sleep') { await sleep(b.time, r.signal); continue }
    if (b.type === 'tool') {
      const index = toolIndex++
      const call = { index, id: toolId(b.id), type: 'function' }
      if (!r.toolStream) { send({ tool_calls: [{ ...call, function: { name: b.name, arguments: JSON.stringify(b.args) } }] }); continue }
      send({ tool_calls: [{ ...call, function: { name: b.name, arguments: '' } }] })
      for (const piece of chunk(JSON.stringify(b.args), 3)) send({ tool_calls: [{ index, function: { arguments: piece } }] })
      continue
    }
    const field = b.type === 'text' ? 'content' : 'reasoning_content'
    for (const [i, piece] of chunk(b.text, b.chunks ?? 1).entries()) {
      if (i > 0) await sleep(b.chunkDelay, r.signal)
      send({ [field]: piece })
    }
  }
  const usage = usageBody(r.dialect, r.usage)
  if (zai) write({ ...head, choices: [{ index: 0, finish_reason: finishReason(finish), delta: { role: 'assistant', content: '' } }], usage })
  else write({ ...head, choices: [{ index: 0, delta: {}, finish_reason: finishReason(finish), usage }] })
  res.end('data: [DONE]\n\n')
}

/** A whole (non-streamed) chat completion in a dialect. */
export function completionMessage(r) {
  const { blocks, finish } = blocksOf(r.steps)
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
  const reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.text).join('')
  const calls = blocks.filter(b => b.type === 'tool').map((b, index) => ({ id: toolId(b.id), ...(r.dialect === 'zai' ? { index } : {}), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.args) } }))
  const message = { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) }
  return {
    id: r.id, ...(r.dialect === 'zai' ? {} : { object: 'chat.completion' }), created: Math.floor(Date.now() / 1000), model: r.model,
    choices: [{ index: 0, finish_reason: finishReason(finish), message }],
    usage: usageBody(r.dialect, r.usage),
  }
}

/**
 * Play one chat-completion request in a dialect, charged to an account:
 * `charge(micros, usage)` runs before anything is sent; `fail(status, kind,
 * message, headers)` answers a script's `error` (or an unparsable script,
 * kind `invalid-request`) in the provider's shape. `provider` is the pi-ai
 * catalog id the prices come from.
 */
export async function playCompletion(ctx, { res, body, dialect, account, provider, catalog, charge, idPrefix, fail }) {
  const plan = respond(normalize('openai', body.messages))
  if (plan.invalid) return fail(400, 'invalid-request', plan.invalid)
  if (plan.failure) return fail(plan.failure.status, plan.failure.kind, plan.failure.message, plan.failure.retryAfter ? { 'retry-after': String(plan.failure.retryAfter) } : {})
  const model = String(body.model ?? 'unknown')
  const usage = usageOf(plan.steps, JSON.stringify(body.messages ?? []))
  const micros = costMicros(catalog.cost(provider, model), usage)
  const id = generationId(idPrefix)
  ctx.store.recordGeneration({ id, account: account.id, provider, model, ...usage, costMicros: micros, streamed: body.stream === true })
  charge(micros, usage)
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableFinished) controller.abort() })
  // Moonshot streams tool arguments in pieces; Z.ai only when asked (pi-ai's `zaiToolStream`).
  const r = { dialect, id, model, steps: plan.steps, usage, signal: controller.signal, toolStream: dialect === 'zai' ? body.tool_stream === true : true }
  if (body.stream === true) return completionStream(res, r)
  return ctx.json(res, 200, completionMessage(r))
}
