/**
 * deepseek, as DeepSea's stack calls it.
 *
 * api.deepseek.com  /anthropic/v1/messages (DeepSeek's own adapter),
 *                 /chat/completions and /v1/chat/completions (OpenAI),
 *                 /models, /user/balance. Accounts: a balance, spent at
 *                 catalog prices; an empty balance is 402.
 * api.anthropic.com, claude.ai, platform.claude.com  Anthropic: API keys and
 *                 Plan sign-ins (anthropic.mjs).
 */
import { bearer, dollars, generate, STARTING_MICROS } from '../common.mjs'

export const name = 'deepseek'
export const hosts = ["api.deepseek.com"]

/** A new account's state. */
export function initialState(kind, credential) {
  return { balanceMicros: STARTING_MICROS, grantedMicros: 0 }
}

function create(ctx, catalog) {
  const open = key => ctx.store.account('deepseek', 'key', key, () => initialState('key', key))
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

export default { name, hosts, initialState, create }
