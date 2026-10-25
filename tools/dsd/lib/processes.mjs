/**
 * Processes: liveness, identity checks before signalling, stopping a
 * process group, free ports.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { onPath, sleep } from './util.mjs'

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
 * Whether `pid` is still the process dsd started, judged by fragments of its
 * command line recorded at start (one string or several, all required). A
 * recycled pid fails this, so dsd never signals a stranger.
 */
export function runningAs(pid, signature) {
  const parts = [signature].flat().filter(Boolean)
  if (parts.length === 0) return false
  const command = commandOf(pid)
  return command !== undefined && parts.every(part => command.includes(part))
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

/**
 * The pids listening on a TCP port of this machine: on Linux from /proc (the listening sockets'
 * inodes, then the processes holding them: this account's, which is all dsd signals), elsewhere
 * through lsof; empty when none, or when neither can be read.
 */
export function listenerPids(port, platform = process.platform) {
  if (platform === 'linux') {
    try { return procListenerPids(port) } catch { /* no /proc: try lsof */ }
  }
  try {
    const lsof = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : onPath('lsof')
    if (!lsof) return []
    return execFileSync(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

/** Inodes of the TCP sockets listening on `port`, from /proc/net/tcp-style text. */
export function listeningInodes(text, port) {
  const inodes = new Set()
  for (const line of String(text).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
    if (f.length < 10 || f[3] !== '0A') continue
    if (Number.parseInt(f[1].split(':').pop(), 16) === port && f[9] !== '0') inodes.add(f[9])
  }
  return inodes
}

function procListenerPids(port) {
  const inodes = new Set()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try { for (const inode of listeningInodes(readFileSync(table, 'utf8'), port)) inodes.add(inode) } catch (error) { if (table.endsWith('tcp')) throw error }
  }
  if (inodes.size === 0) return []
  const pids = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let fds
    try { fds = readdirSync(`/proc/${entry}/fd`) } catch { continue } // another account's, or gone
    for (const fd of fds) {
      let target
      try { target = readlinkSync(`/proc/${entry}/fd/${fd}`) } catch { continue }
      const m = /^socket:\[(\d+)\]$/.exec(target)
      if (m && inodes.has(m[1])) { pids.push(Number(entry)); break }
    }
  }
  return pids
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
