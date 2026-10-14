# tools/provider-sim — simulated model providers

A loopback HTTP server that stands in for model providers, so DeepSea can be
tested end to end (models, routes, billing, sign-in) without real accounts.
It runs no inference: replies are scripted exactly as with the scripted model
(`packages/script`: JSONL commands, or the plain prompts `say <text>` and
`help`), but put on the wire in each provider's own protocol, and every
request is charged to an account that keeps real-looking credit, balance and
usage.

## How DeepSea reaches it

The harness baseline redirects every model provider's host when
`DSH_PROVIDER_SIMULATOR` names a loopback URL (`provider-simulation.ts` in
`@deepseek-ai/dsh-llm`): `https://openrouter.ai/api/v1/models` becomes
`<simulator>/openrouter.ai/api/v1/models`. Everything else in the stack (the
provider SDKs inside pi-ai, DeepSeek's own adapter, billing's account reads)
runs unchanged. A provider the simulator does not serve answers 501, so a
simulated home never reaches a real service.

```sh
dsd run release --throwaway-app --simulated                      # openrouter + deepseek test accounts
dsd run release --throwaway-app --simulated --accounts openrouter-low,deepseek-empty
dsd run release --throwaway-app --simulated --accounts openrouter=sk-or-mine   # a persistent account
dsd sim status | start | stop | accounts [<provider>] | fixtures
dsd sim account openrouter sk-or-mine --set '{"usageMicros": 0}'
```

`--simulated` starts the simulator if it is not running (one per machine and
macOS account, left running; `dsd sim stop` ends it), creates the throwaway's
accounts, puts their keys in the server's environment and the routes they
need in its profile patch, and sets `DSH_PROVIDER_SIMULATOR`.

## Accounts

An account is created the first time a credential is used: any API-key
string. New accounts start with $10 of credit or balance. Money is kept in
micro-dollars and spent at the model's catalog prices (pi-ai's generated
catalog, the same one DeepSea uses), from the script's `usage` command or an
estimate of four characters per token.

`accounts.json` names starting points (`openrouter`, `openrouter-low`,
`openrouter-empty`, `deepseek`, `deepseek-empty`): each has a provider, a
credential, the environment variable the key goes in, the rows its route
needs, and a starting state. A throwaway gets fresh accounts, its id appended
to each credential, so no two throwaways share one; `name=<credential>` uses
that credential as it is, for an account that persists across runs.

The store is `~/.deepsea/_sim/sim.sqlite` (SQLite in WAL mode, every change in
an immediate transaction, so several simulators or tools can share it);
`~/.deepsea/_sim/sim.json` records the running simulator, and its run logs are
in the machine log directory's `sim/`.

## Providers

| Host | Endpoints | Account |
|---|---|---|
| `openrouter.ai` | `POST /api/v1/chat/completions` (OpenAI format), `POST /api/v1/messages` (Anthropic format: pi-ai sends Anthropic models there), `GET /api/v1/models`, `GET /api/v1/generation?id=` (a response's cost), `GET /api/v1/key`, `GET /api/v1/credits` | credit and usage; no credit left is 402 |
| `api.deepseek.com` | `POST /anthropic/v1/messages` (DeepSeek's own adapter), `POST /chat/completions`, `/v1/chat/completions`, `GET /models`, `GET /user/balance` | a balance; empty is 402 |

Both wire formats stream (server-sent events) or answer whole, with text,
reasoning, tool calls and usage. A script plays across a turn as with the
scripted model: one response per request, counted by the assistant messages
since the prompt (the user message that starts the turn; context the harness
adds after it is ignored). `expect` checks the tool results the request
carries; `error` answers the HTTP status of its kind (with `Retry-After`), and
with `times` only for its first attempts.

The simulator's own endpoints are under `/_sim/`: `status`, `accounts`
(`?provider=`), and `POST account` (`{ provider, credential, state }` creates
an account or merges `state` into it).

## Adding a provider

List every endpoint DeepSea's stack calls for it (pi-ai's provider code, the
harness adapters and sign-in flows, billing's account reads), answer exactly
those in `providers.mjs` with the provider's error shapes, map its host in
`providerFor()`, give it a starting state, and test it in
`tests/sim.test.mjs` and in a `--simulated` throwaway.

## Tests

`node --test tests/*.test.mjs`: prompt finding, both wire formats, tool calls
and `expect`, cost lookup, credit and balance, errors with `Retry-After`,
unknown hosts.
