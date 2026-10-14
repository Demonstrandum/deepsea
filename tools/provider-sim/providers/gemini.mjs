/**
 * Gemini (Google AI Studio's Gemini API), as DeepSea's stack calls it: pi-ai's
 * `google` provider (`google-generative-ai` API through @google/genai,
 * `https://generativelanguage.googleapis.com/v1beta`, key `GEMINI_API_KEY`).
 *
 * generativelanguage.googleapis.com
 *   POST /v1beta/models/<model>:streamGenerateContent (`?alt=sse`: server-sent
 *        events, else a JSON array) and :generateContent;
 *   GET  /v1beta/models (pageSize, pageToken), /v1beta/models/<model>.
 *
 * The key goes in `x-goog-api-key` or `?key=`; it names an account (created
 * on first use) with a Prepay credit balance in micro-dollars, spent at
 * catalog prices. Google's errors throughout (`{ error: { code, message,
 * status, details? } }`): no key 403 PERMISSION_DENIED, a key that is not an
 * API key (`AIza…`) 400 API_KEY_INVALID, no credit 402, an unknown model 404,
 * and the script's errors (429 RESOURCE_EXHAUSTED, 503 UNAVAILABLE, …).
 */
import { ERROR_KINDS } from '../../../packages/script/index.mjs'
import { STARTING_MICROS } from '../common.mjs'
import { geminiGenerate, geminiMajor, missingSignature } from '../wire-gemini.mjs'

export const name = 'gemini'
export const hosts = ['generativelanguage.googleapis.com']
/** pi-ai's provider id: the catalog the prices and models come from. */
const CATALOG = 'google'

/** A new account's state: a Prepay credit balance. */
export function initialState() {
  return { balanceMicros: STARTING_MICROS }
}

/** Google's status names by HTTP status (google.rpc.Code); 402 has none of its own. */
const STATUS = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 402: 'RESOURCE_EXHAUSTED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 409: 'ABORTED',
  429: 'RESOURCE_EXHAUSTED', 499: 'CANCELLED', 500: 'INTERNAL', 501: 'UNIMPLEMENTED', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED' }
const statusOf = code => STATUS[code] ?? (code >= 500 ? 'INTERNAL' : code === 429 ? 'RESOURCE_EXHAUSTED' : 'FAILED_PRECONDITION')

const INVALID_KEY = 'API key not valid. Please pass a valid API key.'
const INVALID_KEY_DETAILS = [
  { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } },
  { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message: INVALID_KEY },
]
export const NO_CREDIT = 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.'
const UNREGISTERED = "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API."
/** An API key, as Google issues them. */
const API_KEY = /^AIza[\w-]+$/

/**
 * The script's error kinds, at Gemini's statuses where Google differs from
 * the kind's default (an explicit `status` is kept): Gemini is overloaded with
 * 503, rejects a bad key with 400 API_KEY_INVALID.
 */
const KIND_STATUS = { overloaded: 503, auth: 400, network: 503 }

export function create(ctx, catalog) {
  const store = ctx.store
  const json = (res, status, value) => ctx.json(res, status, value, { 'content-type': 'application/json; charset=UTF-8' })
  const googleError = (res, code, message, details) => json(res, code, { error: { code, message, status: statusOf(code), ...(details ? { details } : {}) } })
  const keyAccount = key => store.account(name, 'key', key, () => initialState())

  /** A script's `error`, as Gemini reports it. */
  const fail = res => (status, kind, message, retryAfter) => {
    const code = KIND_STATUS[kind] !== undefined && status === (ERROR_KINDS[kind]?.status ?? 500) ? KIND_STATUS[kind] : status
    const details = kind === 'auth' ? INVALID_KEY_DETAILS
      : retryAfter ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${retryAfter}s` }] : undefined
    return googleError(res, code, message, details)
  }

  const models = () => catalog.models(CATALOG)
  const modelJson = m => ({
    name: `models/${m.id}`, version: '001', displayName: m.name ?? m.id, description: m.name ?? m.id,
    inputTokenLimit: m.contextWindow ?? 1_048_576, outputTokenLimit: m.maxTokens ?? 65_536,
    supportedGenerationMethods: ['generateContent', 'countTokens', 'createCachedContent', 'batchGenerateContent'],
    temperature: 1, topP: 0.95, topK: 64, maxTemperature: 2, thinking: m.reasoning === true,
  })
  const notFound = (res, id) => googleError(res, 404, `models/${id} is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.`)

  /** A generateContent request's body, as Gemini validates it: the error, or undefined. */
  const invalidBody = (body) => {
    if (!Array.isArray(body.contents) || body.contents.length === 0) return '* GenerateContentRequest.contents: contents is not specified\n'
    for (const [i, c] of body.contents.entries()) {
      if (c?.role !== undefined && c.role !== 'user' && c.role !== 'model') return 'Please use a valid role: user, model.'
      if (!Array.isArray(c?.parts) || c.parts.length === 0) return `* GenerateContentRequest.contents[${i}].parts: contents.parts must not be empty.\n`
    }
    return undefined
  }

  return async (req, res, path, body) => {
    const url = new URL(req.url ?? '/', 'http://sim')
    const key = String(req.headers['x-goog-api-key'] ?? url.searchParams.get('key') ?? '').trim()
    const match = /^\/v1beta\/models(?:\/([^/:]+)(?::(\w+))?)?$/.exec(path)
    if (!match) return googleError(res, 404, 'Method not found.')
    if (!key) return googleError(res, 403, UNREGISTERED)
    if (!API_KEY.test(key)) return googleError(res, 400, INVALID_KEY, INVALID_KEY_DETAILS)
    const account = keyAccount(key)
    const [, id, method] = match

    if (req.method === 'GET' && id === undefined) {
      const all = models()
      const size = Math.min(1000, Math.max(1, Number(url.searchParams.get('pageSize')) || 50))
      const start = Number(Buffer.from(url.searchParams.get('pageToken') ?? '', 'base64url').toString()) || 0
      const page = all.slice(start, start + size)
      return json(res, 200, { models: page.map(modelJson), ...(start + size < all.length ? { nextPageToken: Buffer.from(String(start + size)).toString('base64url') } : {}) })
    }
    if (req.method === 'GET' && method === undefined) {
      const m = models().find(x => x.id === id)
      return m ? json(res, 200, modelJson(m)) : notFound(res, id)
    }
    if (req.method !== 'POST' || (method !== 'generateContent' && method !== 'streamGenerateContent')) return googleError(res, 404, 'Method not found.')

    if (models().length > 0 && !models().some(m => m.id === id)) return notFound(res, id)
    const invalid = invalidBody(body)
    if (invalid) return googleError(res, 400, invalid)
    if (account.state.balanceMicros <= 0) return googleError(res, 402, NO_CREDIT)
    if ((geminiMajor(id) ?? 0) >= 3) {
      const missing = missingSignature(body.contents)
      if (missing) return googleError(res, 400, missing)
    }
    const charge = micros => store.update(account.id, s => ({ ...s, balanceMicros: s.balanceMicros - micros }))
    return geminiGenerate(ctx, { req, res, body, model: id, stream: method === 'streamGenerateContent', sse: url.searchParams.get('alt') === 'sse',
      account, provider: name, catalogProvider: CATALOG, catalog, charge, fail: fail(res) })
  }
}

export default { name, hosts, initialState, create }
