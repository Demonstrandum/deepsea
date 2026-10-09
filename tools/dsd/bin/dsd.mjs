#!/usr/bin/env node
/**
 * dsd — the DeepSea developer CLI. Command reference: tools/dsd/README.md.
 */
import { execFileSync } from 'node:child_process'
import { check } from '../commands/check.mjs'
import { drive } from '../commands/drive.mjs'
import { buildsCommand, gc, link, list, stop } from '../commands/manage.mjs'
import { run } from '../commands/run.mjs'
import { topics } from '../commands/topics.mjs'
import { worktree } from '../commands/worktree.mjs'
import { REPO } from '../lib/paths.mjs'
import { DsdError } from '../lib/util.mjs'

const HELP = `dsd — DeepSea developer CLI (tools/dsd/README.md)

  dsd run <variant> --throwaway-server [--detach] [--scripted] [--plugins <names|all>] [--source <ref>] [--harness <ref>] [--keep]
  dsd stop [<variant>] [--keep]
  dsd list [--builds] [--json]
  dsd gc [--builds] [--dry-run]
  dsd builds [list | make [<harness ref>]]
  dsd link
  dsd drive [-v <ref>] <op> …   (health, create-session, prompt, command, wait, events, cancel, sessions, invoke, url)
  dsd worktree add <topic> [--from <ref>] | list | remove <topic>
  dsd topics [list]
  dsd check [--staged | <rev range>] [--install-hook]

A <variant> reference is a full id, a unique part of a throwaway's hex, or
nothing when exactly one of your throwaways is running.
`

const COMMANDS = { run, stop, list, gc, builds: buildsCommand, link, drive, worktree, topics, check }

/**
 * Warn when this dsd is run inside another checkout of the same repository:
 * plugins, the pin and builds come from the checkout dsd belongs to.
 */
function warnForeignCheckout() {
  const ask = (cwd, args) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return undefined } }
  const here = ask(process.cwd(), ['rev-parse', '--show-toplevel'])
  if (here === undefined || here === REPO) return
  const sameRepo = ask(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir']) === ask(REPO, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (sameRepo) process.stderr.write(`dsd: this is ${REPO}'s dsd, run inside ${here}; plugins and the harness pin come from ${REPO}. Use ${here}/tools/dsd/bin/dsd.mjs (or pnpm dsd there).\n`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(HELP)
} else if (!(command in COMMANDS)) {
  process.stderr.write(`dsd: unknown command "${command}"\n\n${HELP}`)
  process.exitCode = 2
} else {
  warnForeignCheckout()
  try {
    await COMMANDS[command](rest)
  } catch (error) {
    if (!(error instanceof DsdError)) throw error
    process.stderr.write(`dsd: ${error.message}\n`)
    process.exitCode = error.code
  }
}
