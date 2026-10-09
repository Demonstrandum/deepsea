/**
 * dsd __supervise <id> — internal: started detached by `dsd run --throwaway-app
 * --detach`. Watches the throwaway's app and server once a second and removes
 * the throwaway (lib/remove.mjs) as soon as either has exited, so quitting the
 * app is all a person has to do. `dsd stop` ends the supervisor first.
 */
import { removeVariant } from '../lib/remove.mjs'
import { alive } from '../lib/processes.mjs'
import { isoLocal, sleep, usage } from '../lib/util.mjs'
import { readState } from '../lib/variants.mjs'

export async function supervise(argv) {
  const id = argv[0]
  if (id === undefined || argv.length > 1) usage('dsd __supervise <id>')
  process.on('SIGTERM', () => process.exit(0))
  const say = line => process.stdout.write(`${isoLocal()} ${line}\n`)
  say(`watching ${id}`)
  for (;;) {
    const state = readState(id)
    if (!state) { say('the throwaway is gone'); return }
    const app = state.app?.pid ? alive(state.app.pid) : true
    const server = state.pid ? alive(state.pid) : false
    if (!app || !server) {
      say(`${app ? 'the server' : 'the app'} exited; removing ${id}`)
      const result = await removeVariant(id)
      say(`removed ${result.removed.length} paths`)
      return
    }
    await sleep(1000)
  }
}
