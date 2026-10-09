/**
 * @deepsea/scripted-model: a model whose replies are scripted by the prompt
 * (README.md). Registers the `scripted` route with the model `script`.
 */
import { ScriptedAdapter } from './adapter.mjs'

export const name = 'deepsea-scripted-model'
export const inject = ['llm']

export const Config = { '~standard': { version: 1, vendor: 'deepsea-scripted-model', validate(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'route')) return { issues: [{ message: 'config takes only "route"' }] }
  if (input.route !== undefined && (typeof input.route !== 'string' || !/^[a-z0-9-]+$/.test(input.route))) return { issues: [{ message: 'route must be lowercase letters, digits and dashes' }] }
  return { value: { route: input.route ?? 'scripted' } }
} } }

export function apply(ctx, config = { route: 'scripted' }) {
  ctx.llm.registerAdapter([config.route ?? 'scripted'], new ScriptedAdapter())
}
