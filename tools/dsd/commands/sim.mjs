/**
 * dsd sim [status] | start | stop | accounts [<provider>] | account <provider> <credential> [--set <json>]
 *
 * The provider simulator (tools/provider-sim; lib/sim.mjs). `dsd run <v>
 * --throwaway… --simulated [--accounts <names>]` starts it as needed.
 */
import { linkHarness } from '../lib/harness.mjs'
import { ensureSim, fixtures, simStatus, stopSim } from '../lib/sim.mjs'
import { DsdError, onlyFlags, parseArgs, printJson, usage } from '../lib/util.mjs'

const USAGE = 'dsd sim [status] | start | stop | accounts [<provider>] | account <provider> <credential> [--set <json>] | fixtures'

export async function sim(argv) {
  const args = parseArgs(argv, ['set'])
  onlyFlags(args, ['set'])
  const [sub = 'status', ...rest] = args._
  switch (sub) {
    case 'status': return printJson((await simStatus()) ?? { running: false })
    case 'start': return printJson(await ensureSim((await linkHarness()).build))
    case 'stop': return printJson({ stopped: await stopSim() })
    case 'fixtures': return printJson(fixtures())
    case 'accounts': {
      const running = await simStatus()
      if (!running) throw new DsdError('the simulator is not running (dsd sim start)')
      const query = rest[0] ? `?provider=${encodeURIComponent(rest[0])}` : ''
      return printJson(await (await fetch(`${running.url}/_sim/accounts${query}`)).json())
    }
    case 'account': {
      const [provider, credential] = rest
      if (!provider || !credential) usage(USAGE)
      const running = await simStatus()
      if (!running) throw new DsdError('the simulator is not running (dsd sim start)')
      let state
      if (args.set !== undefined) {
        try { state = JSON.parse(args.set) } catch { usage('--set takes a JSON object, e.g. \'{"creditsMicros": 0}\'') }
      }
      // An email address names a sign-in account (a Plan), anything else an API key.
      const kind = credential.includes('@') ? 'email' : 'key'
      const response = await fetch(`${running.url}/_sim/account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, kind, credential, ...(state ? { state } : {}) }) })
      if (!response.ok) throw new DsdError(await response.text())
      return printJson(await response.json())
    }
    default: usage(USAGE)
  }
}
