/**
 * @deepsea/server-log: the server's own log messages (`ctx.logger` of every
 * plugin) as lines on its standard error, where `dsd` and the relay capture
 * them into the variant's server log (LAYOUT.md §5). The harness keeps no
 * log sink of its own after startup, so without this they are dropped.
 *
 *   2026-10-09T21:13:24.115+01:00 warn  deepsea-billing  usage read failed: …
 */
import { Logger } from '@deepseek-ai/cordis'

export const name = 'deepsea-server-log'

const LEVELS = { error: 0, info: 1, warn: 2, debug: 3 }

export const Config = { '~standard': { version: 1, vendor: 'deepsea-server-log', validate(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'level')) return { issues: [{ message: 'config takes only "level"' }] }
  if (input.level !== undefined && !Object.hasOwn(LEVELS, input.level)) return { issues: [{ message: `level is one of ${Object.keys(LEVELS).join(', ')}` }] }
  return { value: { level: input.level ?? 'debug' } }
} } }

/** Local time with milliseconds and offset: `2026-10-09T21:13:24.115+01:00`. */
export function timestamp(ms) {
  const d = new Date(ms)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

/** One message as text lines, each prefixed with time, level and logger name. */
export function render(message, exporter) {
  const head = `${timestamp(message.ts)} ${message.type.padEnd(5)} ${message.name}`
  return Logger.format(exporter, message).split('\n').map(line => `${head}  ${line}`).join('\n')
}

export function apply(ctx, config = { level: 'debug' }) {
  const exporter = {
    colors: false,
    levels: { default: LEVELS[config.level ?? 'debug'] },
    export(message) {
      try { process.stderr.write(`${render(message, exporter)}\n`) } catch { /* a closed stderr must not break logging */ }
    },
  }
  ctx.logger.exporter(exporter)
}
