/**
 * The simulated providers, by host. Each answers the endpoints DeepSea's
 * stack calls (model streams, model lists, the account reads billing makes),
 * from accounts the store creates on a credential's first use.
 *
 * openrouter.ai   /api/v1/chat/completions (OpenAI), /api/v1/messages
 *                 (Anthropic; pi-ai routes Anthropic models there),
 *                 /api/v1/models, /api/v1/generation?id=, /api/v1/key,
 *                 /api/v1/credits. Accounts: credit in micro-dollars, spent
 *                 at catalog prices; no credit left is 402.
 * api.deepseek.com  /anthropic/v1/messages (DeepSeek's own adapter),
 *                 /chat/completions and /v1/chat/completions (OpenAI),
 *                 /models, /user/balance. Accounts: a balance, spent at
 *                 catalog prices; an empty balance is 402.
 * api.anthropic.com, claude.ai, platform.claude.com  Anthropic: API keys and
 *                 Plan sign-ins (anthropic.mjs).
 */
import { anthropicState } from './anthropic.mjs'
import { anthropicMessage, anthropicStream, normalize, openaiMessage, openaiStream, respond, usageOf } from './wire.mjs'

/** New accounts start with this much credit or balance: $10. */
export const STARTING_MICROS = 10_000_000

/** Micro-dollars a response costs at a model's prices (dollars per million tokens). */
export function costMicros(cost, usage) {
  if (!cost) return 0
  return Math.round(usage.input * (cost.input ?? 0) + usage.output * (cost.output ?? 0)
    + usage.cacheRead * (cost.cacheRead ?? 0) + usage.cacheWrite * (cost.cacheWrite ?? 0))
}

const dollars = micros => micros / 1e6

/** A new account's state. */
export function initialState(provider, credential, kind = 'key') {
  if (provider === 'anthropic') return anthropicState(kind, credential)
  if (provider === 'openrouter') return { creditsMicros: STARTING_MICROS, usageMicros: 0, label: `sk-or-…${credential.slice(-4)}` }
  return { balanceMicros: STARTING_MICROS, grantedMicros: 0 }
}

function bearer(req) {
  const auth = req.headers.authorization ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(auth)
  return match?.[1]?.trim() || req.headers['x-api-key']?.trim() || undefined
}

let generationCounter = 0
const generationId = prefix => `${prefix}${Date.now().toString(36)}${(++generationCounter).toString(36).padStart(4, '0')}`

/**
 * Play one model request: the script's response for this point of the turn,
 * charged to the account (`charge(micros, usage)`, before anything is sent).
 * `format` is 'openai' or 'anthropic'; `fail(status, kind, message, headers)`
 * answers a script's error in the provider's shape.
 */
export async function generate(ctx, { req, res, body, format, account, provider, catalog, charge, idPrefix, reasoningField, fail }) {
  const messages = body.messages
  const conversation = normalize(format, messages)
  const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map(b => b?.text ?? '').join('\n') : ''
  const plan = respond(conversation, system)
  const refuse = fail ?? ((status, kind, message, headers) => ctx.error(res, status, kind, message, headers))
  if (plan.invalid) return refuse(400, 'invalid_request_error', plan.invalid)
  if (plan.failure) {
    const headers = plan.failure.retryAfter ? { 'retry-after': String(plan.failure.retryAfter) } : {}
    return refuse(plan.failure.status, plan.failure.kind, plan.failure.message, headers)
  }
  const model = String(body.model ?? 'unknown')
  const usage = usageOf(plan.steps, JSON.stringify(messages ?? []) + JSON.stringify(body.system ?? ''))
  const micros = costMicros(catalog.cost(provider, model), usage)
  const id = generationId(idPrefix)
  ctx.store.recordGeneration({ id, account: account.id, provider, model, ...usage, costMicros: micros, streamed: body.stream === true })
  charge(micros, usage)
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  const r = { id, model, steps: plan.steps, usage, signal: controller.signal, reasoningField, ...(provider === 'openrouter' ? { cost: dollars(micros) } : {}) }
  if (body.stream === true) return format === 'anthropic' ? anthropicStream(res, r) : openaiStream(res, r)
  return ctx.json(res, 200, format === 'anthropic' ? anthropicMessage(r) : openaiMessage(r))
}

/** OpenRouter. */
export function openrouter(ctx, catalog) {
  const open = key => ctx.store.account('openrouter', 'key', key, () => initialState('openrouter', key))
  const charge = account => micros => ctx.store.update(account.id, s => ({ ...s, usageMicros: s.usageMicros + micros }))
  return async (req, res, path, body) => {
    const key = bearer(req)
    if (!key) return ctx.error(res, 401, 'authentication', 'No auth credentials found')
    const account = open(key)
    const s = account.state
    if (req.method === 'POST' && (path === '/api/v1/chat/completions' || path === '/api/v1/messages')) {
      if (s.creditsMicros - s.usageMicros <= 0) return ctx.error(res, 402, 'insufficient_credits', 'Insufficient credits. Add more using https://openrouter.ai/settings/credits')
      return generate(ctx, { req, res, body, format: path.endsWith('/messages') ? 'anthropic' : 'openai', account, provider: 'openrouter', catalog, charge: charge(account), idPrefix: 'gen-', reasoningField: 'reasoning' })
    }
    if (req.method === 'GET' && path === '/api/v1/models') return ctx.json(res, 200, { data: catalog.models('openrouter').map(m => ({
      id: m.id, name: m.name, context_length: m.contextWindow,
      architecture: { input_modalities: m.input ?? ['text'], output_modalities: ['text'] },
      pricing: { prompt: String((m.cost?.input ?? 0) / 1e6), completion: String((m.cost?.output ?? 0) / 1e6) },
    })) })
    if (req.method === 'GET' && path === '/api/v1/generation') {
      const g = ctx.store.generation(new URL(req.url, 'http://sim').searchParams.get('id') ?? '')
      if (!g || g.account !== account.id) return ctx.error(res, 404, 'not_found', 'Generation not found')
      return ctx.json(res, 200, { data: { id: g.id, model: g.model, created_at: g.created, total_cost: dollars(g.cost_micros), usage: dollars(g.cost_micros),
        tokens_prompt: g.input, tokens_completion: g.output, native_tokens_prompt: g.input, native_tokens_completion: g.output,
        native_tokens_cached: g.cache_read, streamed: g.streamed === 1, provider_name: 'Simulated', finish_reason: 'stop' } })
    }
    if (req.method === 'GET' && path === '/api/v1/key') return ctx.json(res, 200, { data: { label: s.label, usage: dollars(s.usageMicros), limit: null,
      limit_remaining: null, is_free_tier: false, is_provisioning_key: false } })
    if (req.method === 'GET' && path === '/api/v1/credits') return ctx.json(res, 200, { data: { total_credits: dollars(s.creditsMicros), total_usage: dollars(s.usageMicros) } })
    return ctx.error(res, 404, 'not_found', `${req.method} ${path} is not simulated`)
  }
}

/** DeepSeek (api.deepseek.com). */
export function deepseek(ctx, catalog) {
  const open = key => ctx.store.account('deepseek', 'key', key, () => initialState('deepseek', key))
  const charge = account => micros => ctx.store.update(account.id, s => ({ ...s, balanceMicros: s.balanceMicros - micros }))
  return async (req, res, path, body) => {
    const key = bearer(req)
    if (!key) return ctx.error(res, 401, 'authentication_error', 'Authentication Fails, Your api key is invalid')
    const account = open(key)
    if (req.method === 'POST' && ['/anthropic/v1/messages', '/chat/completions', '/v1/chat/completions'].includes(path)) {
      if (account.state.balanceMicros <= 0) return ctx.error(res, 402, 'insufficient_balance', 'Insufficient Balance')
      return generate(ctx, { req, res, body, format: path.startsWith('/anthropic') ? 'anthropic' : 'openai', account, provider: 'deepseek', catalog, charge: charge(account), idPrefix: path.startsWith('/anthropic') ? 'msg_' : 'chatcmpl-', reasoningField: 'reasoning_content' })
    }
    if (req.method === 'GET' && (path === '/models' || path === '/v1/models')) return ctx.json(res, 200, { object: 'list', data: catalog.models('deepseek').map(m => ({ id: m.id, object: 'model', owned_by: 'deepseek' })) })
    if (req.method === 'GET' && path === '/user/balance') {
      const s = account.state
      const amount = micros => (micros / 1e6).toFixed(2)
      return ctx.json(res, 200, { is_available: s.balanceMicros > 0, balance_infos: [{ currency: 'USD', total_balance: amount(s.balanceMicros), granted_balance: amount(s.grantedMicros), topped_up_balance: amount(s.balanceMicros - s.grantedMicros) }] })
    }
    return ctx.error(res, 404, 'not_found', `${req.method} ${path} is not simulated`)
  }
}

/** The simulated provider serving a host, or undefined. */
export function providerFor(host) {
  if (host === 'openrouter.ai') return 'openrouter'
  if (host === 'api.deepseek.com') return 'deepseek'
  if (['api.anthropic.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com'].includes(host)) return 'anthropic'
  return undefined
}
