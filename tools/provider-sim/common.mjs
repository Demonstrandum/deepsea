/**
 * What every simulated provider shares: money in micro-dollars, the request's
 * credential, response ids, and `generate()`, which plays one model request
 * (the script's response for this point of the turn) in a wire format and
 * charges it to an account.
 */
import { anthropicMessage, anthropicStream, normalize, openaiMessage, openaiStream, respond, usageOf } from './wire.mjs'

/** New accounts start with this much credit or balance: $10. */
export const STARTING_MICROS = 10_000_000

/** Micro-dollars a response costs at a model's prices (dollars per million tokens). */
export function costMicros(cost, usage) {
  if (!cost) return 0
  return Math.round(usage.input * (cost.input ?? 0) + usage.output * (cost.output ?? 0)
    + usage.cacheRead * (cost.cacheRead ?? 0) + usage.cacheWrite * (cost.cacheWrite ?? 0))
}

export const dollars = micros => micros / 1e6

/** The credential of a request: a bearer token or an `x-api-key`. */
export function bearer(req) {
  const auth = req.headers.authorization ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(auth)
  return match?.[1]?.trim() || req.headers['x-api-key']?.trim() || undefined
}

let generationCounter = 0
/** A fresh response id with a provider's prefix. */
export const generationId = prefix => `${prefix}${Date.now().toString(36)}${(++generationCounter).toString(36).padStart(4, '0')}`

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

