/**
 * Processes: liveness, identity checks before signalling, stopping a
 * process group, free ports.
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { sleep } from './util.mjs'

/** Whether a process exists. */
export function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

/** Whether any member of a process group exists. */
export function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

/** A process's command line, or undefined when it is gone. */
export function commandOf(pid) {
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/**
 * Whether `pid` is still the process dsd started, judged by a substring of its
 * command line recorded at start. A recycled pid fails this, so dsd never
 * signals a stranger.
 */
export function runningAs(pid, signature) {
  if (!signature) return false
  const command = commandOf(pid)
  return command !== undefined && command.includes(signature)
}

/** SIGTERM a process group, then SIGKILL whatever is left after `graceMs`. */
export async function stopGroup(pgid, graceMs = 10_000) {
  try { process.kill(-pgid, 'SIGTERM') } catch { return }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return
    await sleep(200)
  }
  try { process.kill(-pgid, 'SIGKILL') } catch { /* already gone */ }
}

/** A port nothing is listening on, on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}
