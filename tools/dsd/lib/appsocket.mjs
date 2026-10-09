/**
 * Client for a throwaway app's automation channel (apps/macos/Sources/Automation.swift):
 * one JSON object per line over a Unix socket, each answered by one line.
 */
import { createConnection } from 'node:net'
import { DsdError } from './util.mjs'

/**
 * Send one request and resolve its value, or reject with the app's error.
 * @param {string} socket - the socket path
 * @param {string} op
 * @param {object} [args]
 * @param {{ timeoutMs?: number }} [options]
 */
export function appRequest(socket, op, args = {}, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket)
    let buffer = ''
    const timer = setTimeout(() => { conn.destroy(); reject(new DsdError(`${op}: no answer from the app within ${Math.round(timeoutMs / 1000)} s`)) }, timeoutMs)
    const finish = (fn, value) => { clearTimeout(timer); conn.end(); fn(value) }
    conn.on('connect', () => conn.write(`${JSON.stringify({ id: 1, op, ...args })}\n`))
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      let reply
      try { reply = JSON.parse(buffer.slice(0, newline)) } catch { finish(reject, new DsdError(`${op}: the app answered with something that is not JSON`)); return }
      if (reply.ok) finish(resolve, reply.value)
      else finish(reject, new DsdError(`${op}: ${reply.error?.code ?? 'error'}: ${reply.error?.message ?? 'failed'}`))
    })
    conn.on('error', (error) => finish(reject, new DsdError(`cannot reach the app's automation socket ${socket}: ${error.code ?? error.message}`)))
  })
}
