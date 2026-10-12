/**
 * dsd logs [<ref>] [app | relay | server | dsd | plugin <name>] [--lines <n>] [--follow] [--export]
 *
 * The current run's log of one kind for a variant: the `latest` link of its
 * directory in the variant's log directory (LAYOUT.md §5), server by
 * default. Prints the last `--lines` lines (default 100; 0: the whole file),
 * the file's path on standard error. `--follow` keeps printing what is
 * appended and moves on to a newer run when the `latest` link does (a relay
 * restarting the server, an app relaunched). `--export` writes a copy named
 * by its identity (`deepsea.<v>-<kind>-<ts>.log`) into the current
 * directory instead.
 */
import { closeSync, copyFileSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { logDirOf } from '../lib/paths.mjs'
import { DsdError, note, onlyFlags, parseArgs, sleep, usage } from '../lib/util.mjs'
import { listVariants, resolveRef } from '../lib/variants.mjs'

export const KINDS = ['app', 'relay', 'server', 'dsd', 'plugin']
const USAGE = 'dsd logs [<variant>] [app | relay | server | dsd | plugin <name>] [--lines <n>] [--follow] [--export]'

/**
 * Split `dsd logs` arguments into the variant reference, the kind and the plugin name. A first
 * word that is a kind (and not a variant's id) is the kind.
 * @param {string[]} words
 * @param {Set<string>} ids - existing variant ids
 */
export function parseLogArgs(words, ids) {
  const rest = [...words]
  let ref
  if (rest.length > 0 && (!KINDS.includes(rest[0]) || ids.has(rest[0]))) ref = rest.shift()
  const kind = rest.shift() ?? 'server'
  if (!KINDS.includes(kind)) usage(`no log kind "${kind}"\n${USAGE}`)
  let plugin
  if (kind === 'plugin') {
    plugin = rest.shift()
    if (plugin === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(plugin)) usage('dsd logs [<variant>] plugin <name>')
  }
  if (rest.length > 0) usage(USAGE)
  return { ref, kind, plugin }
}

/** A log directory's current run: its `latest.<ext>` link, else its newest run file. */
export function currentRun(dir) {
  if (!existsSync(dir)) return undefined
  const names = readdirSync(dir)
  const latest = names.filter(n => /^latest\.[a-z]+$/.test(n)).map(n => join(dir, n)).filter(p => existsSync(p))
  if (latest.length > 0) return latest.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  const runs = names.filter(n => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[^/]+\.[a-z]+$/.test(n)).sort()
  return runs.length ? join(dir, runs[runs.length - 1]) : undefined
}

/** The last `count` lines of a text (all when 0). */
export function lastLines(text, count) {
  if (!count) return text
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const kept = lines.slice(-count).join('\n')
  return text.endsWith('\n') ? `${kept}\n` : kept
}

/** The copy's name: `deepsea.<v>-<kind>-<ts>.<ext>` from the run file `<ts>-<tag>.<ext>`. */
export function exportName(id, kind, runFile) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-[^.]+\.([a-z]+)$/.exec(basename(runFile))
  return `deepsea.${id}-${kind}-${m ? m[1] : 'run'}.${m ? m[2] : 'log'}`
}

const resolveLink = (path) => { try { return realpathSync(path) } catch { return undefined } }

/** Print what is appended to the run `link` points at, moving to a newer run when the link moves. */
async function follow(link, dir, offset) {
  let file = resolveLink(link)
  let position = offset
  const buffer = Buffer.alloc(64 * 1024)
  for (;;) {
    if (!existsSync(dir)) { note('the log directory is gone (the variant was removed)'); return }
    const now = resolveLink(currentRun(dir) ?? link)
    if (now !== undefined && now !== file) {
      note(`now ${now}`)
      file = now
      position = 0
    }
    if (file !== undefined) {
      let fd
      try {
        fd = openSync(file, 'r')
        for (;;) {
          const read = readSync(fd, buffer, 0, buffer.length, position)
          if (read <= 0) break
          process.stdout.write(buffer.subarray(0, read))
          position += read
        }
      } catch { /* rotated away; the link says where next */ } finally { if (fd !== undefined) closeSync(fd) }
    }
    await sleep(250)
  }
}

export async function logs(argv) {
  const args = parseArgs(argv, ['lines'])
  onlyFlags(args, ['lines', 'follow', 'export'])
  const { ref, kind, plugin } = parseLogArgs(args._, new Set(listVariants().map(v => v.id)))
  const lines = args.lines === undefined ? 100 : Number(args.lines)
  if (!Number.isInteger(lines) || lines < 0) usage('--lines takes a whole number (0: the whole file)')
  if (args.follow && args.export) usage('--follow and --export are alternatives')
  const variant = resolveRef(ref)
  const dir = join(logDirOf(variant.id), ...(kind === 'plugin' ? ['plugins', plugin] : [kind]))
  const link = currentRun(dir)
  if (link === undefined) throw new DsdError(`${variant.id} has no ${kind === 'plugin' ? `plugin ${plugin}` : kind} log (${dir})`)
  const file = resolveLink(link) ?? link
  if (args.export) {
    const target = resolve(exportName(variant.id, kind === 'plugin' ? `plugin-${plugin}` : kind, file))
    copyFileSync(file, target)
    process.stdout.write(`${target}\n`)
    return
  }
  note(file)
  const bytes = readFileSync(file)
  process.stdout.write(lastLines(bytes.toString('utf8'), lines))
  if (args.follow) await follow(link, dir, bytes.length)
}
