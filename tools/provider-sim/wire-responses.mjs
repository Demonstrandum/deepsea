/**
 * OpenAI's Responses API on the wire (`POST /v1/responses`, and ChatGPT's
 * Codex backend, which speaks the same events): reading a request's `input`
 * items as a conversation, and playing the scripted model's response as a
 * Response object or as its server-sent events.
 *
 * A request carries the whole conversation (pi-ai sends `store: false`):
 * `developer`/`system` messages, user messages of `input_text` parts, and
 * the assistant's earlier output items (`reasoning`, `message`,
 * `function_call`) followed by `function_call_output` items. Consecutive
 * output items are one assistant message, as `promptOf` counts them.
 *
 * Events, as OpenAI sends them (each `event: <type>` with a `data:` line
 * carrying `type` and `sequence_number`): `response.created`,
 * `response.in_progress`, per output item `response.output_item.added`, its
 * deltas (`response.reasoning_summary_*`, `response.content_part.*` with
 * `response.output_text.*`, `response.function_call_arguments.*`) and
 * `response.output_item.done`, then `response.completed` (or
 * `response.incomplete` with `incomplete_details.reason: max_output_tokens`)
 * carrying the whole Response with its usage.
 */
import { randomBytes } from 'node:crypto'
import { chunk } from '../../packages/script/index.mjs'
import { costMicros } from './common.mjs'
import { blocksOf, respond, tokens, usageOf } from './wire.mjs'

// ---- reading a request ---------------------------------------------------------------

const ASSISTANT_ITEMS = new Set(['reasoning', 'function_call', 'custom_tool_call', 'tool_search_call'])
const TOOL_CALLS = new Set(['function_call', 'custom_tool_call'])
const TOOL_OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output'])

const partTexts = content => typeof content === 'string' ? [content]
  : Array.isArray(content) ? content.filter(p => ['input_text', 'output_text', 'text'].includes(p?.type) && typeof p.text === 'string').map(p => p.text) : []

/** A Responses `input` (a string or items) as a neutral conversation: `{ role, texts, toolCalls, toolResults }` per message. */
export function normalizeResponses(input) {
  if (typeof input === 'string') return [{ role: 'user', texts: [input], toolCalls: 0, toolResults: [] }]
  const out = []
  const assistant = () => {
    const last = out.at(-1)
    if (last?.role === 'assistant') return last
    const message = { role: 'assistant', texts: [], toolCalls: 0, toolResults: [] }
    out.push(message)
    return message
  }
  for (const item of Array.isArray(input) ? input : []) {
    const type = item?.type ?? (item?.role ? 'message' : undefined)
    if (type === 'message' && item.role === 'assistant') assistant().texts.push(...partTexts(item.content))
    else if (type === 'message') {
      const role = item.role === 'developer' || item.role === 'system' ? 'system' : 'user'
      out.push({ role, texts: partTexts(item.content), toolCalls: 0, toolResults: [] })
    } else if (ASSISTANT_ITEMS.has(type)) {
      if (TOOL_CALLS.has(type)) assistant().toolCalls++
      else assistant()
    } else if (TOOL_OUTPUTS.has(type)) {
      const text = typeof item.output === 'string' ? item.output : partTexts(item.output).join('\n')
      out.push({ role: 'tool', texts: [], toolCalls: 0, toolResults: [{ id: item.call_id, text }] })
    }
  }
  return out
}

/** The price tier pi-ai's `calculateCost` applies: the highest `tiers[].inputTokensAbove` the request's input exceeds. */
export function tieredCost(cost, usage) {
  if (!cost) return undefined
  const input = usage.input + usage.cacheRead + usage.cacheWrite
  let rates = cost
  let threshold = -1
  for (const tier of cost.tiers ?? []) {
    if (input > tier.inputTokensAbove && tier.inputTokensAbove > threshold) { rates = tier; threshold = tier.inputTokensAbove }
  }
  return rates
}

/** The price multiplier of a service tier, as pi-ai applies it (flex half, priority double; gpt-5.5 2.5×). */
export const serviceTierMultiplier = (tier, model) => tier === 'flex' ? 0.5 : tier === 'priority' ? (model === 'gpt-5.5' ? 2.5 : 2) : 1

// ---- writing a response --------------------------------------------------------------

const hex = bytes => randomBytes(bytes).toString('hex')

const sleep = (seconds, signal) => new Promise((resolve) => {
  if (!seconds || signal?.aborted) { resolve(); return }
  const timer = setTimeout(resolve, seconds * 1000)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

/** The output items a response's blocks become (ids assigned), with each block's streaming pieces. */
function outputOf(r) {
  const { blocks, finish } = blocksOf(r.steps)
  const encrypted = (r.request.include ?? []).includes('reasoning.encrypted_content')
  const items = []
  for (const b of blocks) {
    if (b.type === 'sleep') { items.push({ sleep: b.time }); continue }
    if (b.type === 'thinking') {
      items.push({ block: b, item: { id: `rs_${hex(24)}`, type: 'reasoning', summary: [{ type: 'summary_text', text: b.text }],
        ...(encrypted ? { encrypted_content: `sim:${Buffer.from(b.text).toString('base64')}` } : {}) } })
    } else if (b.type === 'text') {
      items.push({ block: b, item: { id: `msg_${hex(24)}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], logprobs: [], text: b.text }] } })
    } else {
      items.push({ block: b, item: { id: `fc_${hex(24)}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(b.args), call_id: b.id ?? `call_${hex(12)}`, name: b.name } })
    }
  }
  const reasoning = blocks.filter(b => b.type === 'thinking').reduce((sum, b) => sum + tokens(b.text), 0)
  return { items, finish, reasoning }
}

/** OpenAI's usage object (input counts cached and cache-written tokens, as OpenAI reports it). */
function usageObject(usage, reasoning) {
  const input = usage.input + usage.cacheRead + usage.cacheWrite
  return { input_tokens: input, input_tokens_details: { cached_tokens: usage.cacheRead, ...(usage.cacheWrite ? { cache_write_tokens: usage.cacheWrite } : {}) },
    output_tokens: usage.output, output_tokens_details: { reasoning_tokens: Math.min(reasoning, usage.output) }, total_tokens: input + usage.output }
}

/** The Response object: its fields echo the request, `status` and `output` as given. */
function responseObject(r, { status, output = [], usage = null, incomplete = null }) {
  const b = r.request
  return {
    id: r.id, object: 'response', created_at: r.created, status, background: false, error: null, incomplete_details: incomplete,
    instructions: b.instructions ?? null, max_output_tokens: b.max_output_tokens ?? null, max_tool_calls: null, model: r.model, output,
    parallel_tool_calls: b.parallel_tool_calls ?? true, previous_response_id: b.previous_response_id ?? null, prompt_cache_key: b.prompt_cache_key ?? null,
    reasoning: { effort: b.reasoning?.effort ?? null, summary: b.reasoning?.summary ?? null }, safety_identifier: null,
    service_tier: ['flex', 'priority'].includes(b.service_tier) ? b.service_tier : 'default', store: b.store ?? true, temperature: b.temperature ?? 1,
    text: { format: { type: 'text' }, verbosity: b.text?.verbosity ?? 'medium' }, tool_choice: b.tool_choice ?? 'auto', tools: b.tools ?? [], top_logprobs: 0, top_p: 1,
    truncation: 'disabled', usage, user: null, metadata: {},
  }
}

const finalState = finish => finish === 'max-tokens'
  ? { status: 'incomplete', incomplete: { reason: 'max_output_tokens' } }
  : { status: 'completed', incomplete: null }

/** A whole (non-streamed) Response. */
export function responsesMessage(r) {
  const { items, finish, reasoning } = outputOf(r)
  return responseObject(r, { ...finalState(finish), output: items.filter(i => i.item).map(i => i.item), usage: usageObject(r.usage, reasoning) })
}

/** Stream a Response as OpenAI's server-sent events. */
export async function responsesStream(res, r) {
  const { items, finish, reasoning } = outputOf(r)
  let sequence = 0
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
  event('response.created', { response: responseObject(r, { status: 'in_progress' }) })
  event('response.in_progress', { response: responseObject(r, { status: 'in_progress' }) })
  const done = []
  for (const { sleep: seconds, block: b, item } of items) {
    if (r.signal?.aborted) break
    if (seconds !== undefined) { await sleep(seconds, r.signal); continue }
    const at = { item_id: item.id, output_index: done.length }
    const pieces = b.type === 'tool' ? chunk(item.arguments, 3) : chunk(b.text, b.chunks ?? 1)
    const pace = async (i) => { if (i > 0 && b.type !== 'tool') await sleep(b.chunkDelay, r.signal) }
    if (item.type === 'reasoning') {
      event('response.output_item.added', { output_index: at.output_index, item: { id: item.id, type: 'reasoning', summary: [] } })
      event('response.reasoning_summary_part.added', { ...at, summary_index: 0, part: { type: 'summary_text', text: '' } })
      for (const [i, delta] of pieces.entries()) { await pace(i); event('response.reasoning_summary_text.delta', { ...at, summary_index: 0, delta }) }
      event('response.reasoning_summary_text.done', { ...at, summary_index: 0, text: b.text })
      event('response.reasoning_summary_part.done', { ...at, summary_index: 0, part: { type: 'summary_text', text: b.text } })
    } else if (item.type === 'message') {
      event('response.output_item.added', { output_index: at.output_index, item: { ...item, status: 'in_progress', content: [] } })
      event('response.content_part.added', { ...at, content_index: 0, part: { type: 'output_text', annotations: [], logprobs: [], text: '' } })
      for (const [i, delta] of pieces.entries()) { await pace(i); event('response.output_text.delta', { ...at, content_index: 0, delta, logprobs: [] }) }
      event('response.output_text.done', { ...at, content_index: 0, text: b.text, logprobs: [] })
      event('response.content_part.done', { ...at, content_index: 0, part: item.content[0] })
    } else {
      event('response.output_item.added', { output_index: at.output_index, item: { ...item, status: 'in_progress', arguments: '' } })
      for (const delta of pieces) event('response.function_call_arguments.delta', { ...at, delta })
      event('response.function_call_arguments.done', { ...at, arguments: item.arguments })
    }
    event('response.output_item.done', { output_index: at.output_index, item })
    done.push(item)
  }
  if (r.signal?.aborted) { res.end(); return }
  const final = finalState(finish)
  event(final.status === 'completed' ? 'response.completed' : 'response.incomplete', { response: responseObject(r, { ...final, output: done, usage: usageObject(r.usage, reasoning) }) })
  res.end()
}

/**
 * Play one Responses request: the script's response for this point of the
 * turn, charged to the account (`charge(micros, usage)`, before anything is
 * sent; micros at the model's catalog price, its tier and the request's
 * service tier), streamed when the request asks for it.
 * `fail(status, kind, message, headers)` answers a script's error or an
 * invalid script, `kind` in the script's vocabulary.
 * @returns the response id, or undefined when it failed.
 */
export async function playResponses(ctx, { req, res, body, account, provider, catalog, charge, fail }) {
  const conversation = normalizeResponses(body.input)
  const plan = respond(conversation, typeof body.instructions === 'string' ? body.instructions : '')
  if (plan.invalid) return fail(400, 'invalid-request', plan.invalid)
  if (plan.failure) {
    const headers = plan.failure.retryAfter ? { 'retry-after': String(plan.failure.retryAfter) } : {}
    return fail(plan.failure.status, plan.failure.kind, plan.failure.message, headers)
  }
  const model = String(body.model ?? 'unknown')
  const usage = usageOf(plan.steps, JSON.stringify(body.input ?? []) + String(body.instructions ?? ''))
  const micros = Math.round(costMicros(tieredCost(catalog.cost(provider, model), usage), usage) * serviceTierMultiplier(body.service_tier, model))
  const id = `resp_${hex(24)}`
  ctx.store.recordGeneration({ id, account: account.id, provider, model, ...usage, costMicros: micros, streamed: body.stream === true })
  charge(micros, usage)
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableFinished) controller.abort() })
  const r = { id, model, steps: plan.steps, usage, request: body, created: Math.floor(Date.now() / 1000), signal: controller.signal }
  if (body.stream === true) await responsesStream(res, r)
  else ctx.json(res, 200, responsesMessage(r))
  return id
}
