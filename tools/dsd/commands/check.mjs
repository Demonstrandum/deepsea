/**
 * dsd check [--staged | <rev range>] [--install-hook]
 *
 * Scan the lines a change adds for things that must not be published: local
 * account paths, private network addresses, tailnet names, personal email
 * addresses, plus the patterns in `<main checkout>/private/check-patterns.txt`
 * (one JavaScript regular expression per line, `#` comments; machine-local
 * names that tracked files must not carry). Exit 1 listing each hit.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mainCheckout, REPO } from '../lib/paths.mjs'
import { DsdError, git, note, onlyFlags, parseArgs, printJson, usage } from '../lib/util.mjs'

/** Patterns no tracked file may add, with the reason each is reported. */
export const BUILTIN_PATTERNS = [
  [/\/Users\/(?!USER\b)[A-Za-z][\w.-]*/, 'a local account path (write /Users/USER/…)'],
  [/\b192\.168\.\d{1,3}\.\d{1,3}\b|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/, 'a private network address'],
  [/\b(?!example\.ts\.net\b)[a-z0-9-]+\.ts\.net\b/i, 'a tailnet name (write <node>.example.ts.net)'],
  // A domain ending in a letter TLD, so package specs (`react@18.3.1`) are not addresses.
  [/\b[\w.+-]+@(?!example\.(?:com|org|net)\b)(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i, 'an email address (write user@example.com)'],
]

/** Files whose added lines are not scanned: the license names its holder. */
const EXEMPT = new Set(['LICENSE'])

/** The machine-local patterns, if the main checkout has any. */
export function privatePatterns() {
  const file = join(mainCheckout(), 'private', 'check-patterns.txt')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(source => [new RegExp(source, 'i'), `matches private pattern /${source}/`])
}

/**
 * The lines a unified diff (`-U0`) adds: file, line number, text.
 * @param {string} diff
 */
export function addedLines(diff) {
  const out = []
  let file
  let line = 0
  let previous = ''
  for (const raw of diff.split('\n')) {
    // A file header is `+++ ` right after `--- `; elsewhere `+++…` is an added line starting with `++`.
    const header = raw.startsWith('+++ ') && previous.startsWith('--- ')
    previous = raw
    if (header) { file = raw.slice(4).replace(/^b\//, ''); continue }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) { line = Number(hunk[1]); continue }
    if (raw.startsWith('+') && file !== undefined && file !== '/dev/null') out.push({ file, line: line++, text: raw.slice(1) })
  }
  return out
}

/** Every hit of `patterns` in `lines`. */
export function scan(lines, patterns) {
  const hits = []
  for (const { file, line, text } of lines) {
    if (EXEMPT.has(file)) continue
    for (const [pattern, reason] of patterns) {
      const m = pattern.exec(text)
      if (m) hits.push({ file, line, match: m[0], reason })
    }
  }
  return hits
}

const HOOK_MARK = '# installed by dsd check --install-hook'

/** Install the pre-commit hook that runs `dsd check --staged` (shared by every worktree). */
export function installHook() {
  const hooks = join(resolve(REPO, git(REPO, ['rev-parse', '--git-common-dir'])), 'hooks')
  const file = join(hooks, 'pre-commit')
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(HOOK_MARK)) {
    note(`left ${file} alone: it is not dsd's`)
    return false
  }
  mkdirSync(hooks, { recursive: true })
  writeFileSync(file, `#!/bin/sh
${HOOK_MARK}: scan staged changes for leaks and retired names.
dsd="$(git rev-parse --show-toplevel)/tools/dsd/bin/dsd.mjs"
[ -f "$dsd" ] || exit 0
exec node "$dsd" check --staged
`)
  chmodSync(file, 0o755)
  return true
}

export async function check(argv) {
  const args = parseArgs(argv)
  onlyFlags(args, ['staged', 'install-hook', 'json'])
  if (args['install-hook']) { const installed = installHook(); return printJson({ hook: installed }) }
  if (args._.length > 1 || (args.staged && args._.length)) usage('dsd check [--staged | <rev range>]')
  const diff = git(process.cwd(), ['diff', '-U0', '--no-color', ...(args._.length ? [args._[0]] : ['--cached'])])
  const lines = addedLines(diff)
  const hits = scan(lines, [...BUILTIN_PATTERNS, ...privatePatterns()])
  if (args.json) printJson({ lines: lines.length, hits })
  else if (hits.length === 0) note(`check: clean (${lines.length} added lines)`)
  else process.stderr.write(`${hits.map(h => `${h.file}:${h.line}: ${h.match}  (${h.reason})`).join('\n')}\n`)
  if (hits.length) throw new DsdError(`check: ${hits.length} hit${hits.length === 1 ? '' : 's'}; fix them, or commit with --no-verify only if every hit is intended`)
}
