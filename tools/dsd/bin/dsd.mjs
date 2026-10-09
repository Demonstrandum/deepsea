#!/usr/bin/env node
/**
 * dsd — the DeepSea developer CLI. Command reference: tools/dsd/README.md.
 */
import { check } from '../commands/check.mjs'
import { buildsCommand, gc, link, list, stop } from '../commands/manage.mjs'
import { run } from '../commands/run.mjs'
import { DsdError } from '../lib/util.mjs'

const HELP = `dsd — DeepSea developer CLI (tools/dsd/README.md)

  dsd run <variant> --throwaway-server [--detach] [--plugins <names|all>] [--source <ref>] [--harness <ref>] [--keep]
  dsd stop [<variant>] [--keep]
  dsd list [--builds] [--json]
  dsd gc [--builds] [--dry-run]
  dsd builds [list | make [<harness ref>]]
  dsd link
  dsd check [--staged | <rev range>] [--install-hook]

A <variant> reference is a full id, a unique part of a throwaway's hex, or
nothing when exactly one throwaway is running.
`

const COMMANDS = { run, stop, list, gc, builds: buildsCommand, link, check }

const [command, ...rest] = process.argv.slice(2)
if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(HELP)
} else if (!(command in COMMANDS)) {
  process.stderr.write(`dsd: unknown command "${command}"\n\n${HELP}`)
  process.exitCode = 2
} else {
  try {
    await COMMANDS[command](rest)
  } catch (error) {
    if (!(error instanceof DsdError)) throw error
    process.stderr.write(`dsd: ${error.message}\n`)
    process.exitCode = error.code
  }
}
