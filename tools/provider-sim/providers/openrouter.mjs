/**
 * openrouter, as DeepSea's stack calls it.
 *
 * openrouter.ai   /api/v1/chat/completions (OpenAI), /api/v1/messages
 *                 (Anthropic; pi-ai routes Anthropic models there),
 *                 /api/v1/models, /api/v1/generation?id=, /api/v1/key,
 *                 /api/v1/credits. Accounts: credit in micro-dollars, spent
 *                 at catalog prices; no credit left is 402.
 */
import { bearer, dollars, generate, STARTING_MICROS } from '../common.mjs'

export const name = 'openrouter'
export const hosts = ["openrouter.ai"]

/** A new account's state. */
export function initialState(kind, credential) {
  return { creditsMicros: STARTING_MICROS, usageMicros: 0, label: `sk-or-…${credential.slice(-4)}` }
}

function create(ctx, catalog) {
  const open = key => ctx.store.account('openrouter', 'key', key, () => initialState('key', key))
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

export default { name, hosts, initialState, create }
