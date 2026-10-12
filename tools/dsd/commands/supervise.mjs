/**
 * dsd __supervise <id> — internal: started detached by `dsd run --throwaway
 * --detach` and `--throwaway-app --detach`. Watches the throwaway's app once a second and removes the
 * throwaway (lib/remove.mjs) as soon as the app has quit, so quitting the app
 * is all a person has to do. The app outlives its server: after a /reboot or
 * /restore the page shows what happened. `dsd stop` ends the supervisor first.
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
  let serverGone = false
  for (;;) {
    const state = readState(id)
    if (!state) { say('the throwaway is gone'); return }
    if (!serverGone && state.pid && !alive(state.pid)) { serverGone = true; say(`the ${state.relay ? 'relay' : 'server'} exited; waiting for the app to quit`) }
    if (!state.app?.pid || !alive(state.app.pid)) {
      say(`the app quit; removing ${id}`)
      const result = await removeVariant(id)
      say(`removed ${result.removed.length} paths`)
      return
    }
    await sleep(1000)
  }
}
