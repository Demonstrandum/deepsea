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
dsd run release --throwaway-app --simulated --accounts anthropic,anthropic-max  # API key and a signed-in Plan
dsd sim status | start | stop | accounts [<provider>] | fixtures
dsd sim account openrouter sk-or-mine --set '{"usageMicros": 0}'
dsd sim account anthropic max@example.com --set '{"plan": "max20"}'      # an email: a Plan account
```

`--simulated` starts the simulator if it is not running (one per machine and
macOS account, left running; `dsd sim stop` ends it), creates the throwaway's
accounts, puts their keys in the server's environment and the routes they
need in its profile patch, and sets `DSH_PROVIDER_SIMULATOR`.

## Accounts

An account is created the first time a credential is used: any API-key
string, or an email address signed in through a simulated sign-in page (kind
`email`). New key accounts start with $10 of credit or balance. Money is kept
in micro-dollars and spent at the model's catalog prices (pi-ai's generated
catalog, the same one DeepSea uses), from the script's `usage` command or an
estimate of four characters per token.

`accounts.json` names starting points: each has a provider, a credential,
the environment variable the key goes in, the rows its route needs, and a
starting state. A throwaway gets fresh accounts, its id appended to each
credential (before the `@` of an email: `max+3275dd@example.com`), so no two
throwaways share one; `name=<credential>` uses that credential as it is, for
an account that persists across runs.

| Fixture | Account |
|---|---|
| `openrouter`, `openrouter-low`, `openrouter-empty` | OpenRouter key: $10, 5¢, no credit |
| `deepseek`, `deepseek-empty` | DeepSeek key: $10, empty balance |
| `anthropic`, `anthropic-low` | Anthropic API key (`ANTHROPIC_API_KEY`, route `anthropic`): $10, 5¢ of credit |
| `anthropic-max` | Anthropic Plan, Max 5×, `max@example.com`, signed in to `anthropic-oauth` |
| `anthropic-max-80` | the same with the five-hour window at 80% (`max80@example.com`) |

A sign-in fixture (`kind: email`, `signIn: <route>`) starts the throwaway
signed in, without a browser: dsd asks the simulator for tokens
(`/_sim/sign-in`) and writes the grant pi-ai would have stored after a
browser sign-in into the throwaway's `.credentials.yaml` (credentials-local's
record `llm-pi-ai/<route>`: `{ type: oauth, access, refresh, expires }`). A
throwaway holds one sign-in per route, so `anthropic-max` and
`anthropic-max-80` do not go together.

The store is `~/.deepsea/_sim/sim.sqlite` (SQLite in WAL mode, every change in
an immediate transaction, so several simulators or tools can share it);
`~/.deepsea/_sim/sim.json` records the running simulator, and its run logs are
in the machine log directory's `sim/`.

## Providers

| Host | Endpoints | Account |
|---|---|---|
| `openrouter.ai` | `POST /api/v1/chat/completions` (OpenAI format), `POST /api/v1/messages` (Anthropic format: pi-ai sends Anthropic models there), `GET /api/v1/models`, `GET /api/v1/generation?id=` (a response's cost), `GET /api/v1/key`, `GET /api/v1/credits` | credit and usage; no credit left is 402 |
| `api.deepseek.com` | `POST /anthropic/v1/messages` (DeepSeek's own adapter), `POST /chat/completions`, `/v1/chat/completions`, `GET /models`, `GET /user/balance` | a balance; empty is 402 |
| `api.anthropic.com` | `POST /v1/messages` (`x-api-key`, or an OAuth `Bearer sk-ant-oat…` with the `oauth-2025-04-20` beta), `GET /v1/models`, `GET /api/oauth/usage`, `GET /api/oauth/profile` | a key: a credit balance, too low is 400 `invalid_request_error`; an email: a Plan (below) |
| `claude.ai` | `GET /oauth/authorize` (the sign-in page), `POST /oauth/authorize` | |
| `platform.claude.com` (and `console.anthropic.com`) | `POST /v1/oauth/token` (`authorization_code`, `refresh_token`) | |

Both wire formats stream (server-sent events) or answer whole, with text,
reasoning, tool calls and usage. A script plays across a turn as with the
scripted model: one response per request, counted by the assistant messages
since the prompt (the user message that starts the turn; context the harness
adds after it is ignored). `expect` checks the tool results the request
carries; `error` answers the HTTP status of its kind (with `Retry-After`), and
with `times` only for its first attempts.

Anthropic answers in its own error shapes (`{ type: "error", error: { type,
message }, request_id }`, a `request-id` header): 401 `authentication_error`
(no key, a bad or expired OAuth token, an OAuth token without the beta), 400
for a missing `anthropic-version`, and the script's `error` kinds as
`rate_limit_error` (429), `overloaded_error` (529), `api_error`,
`timeout_error`, `billing_error`, `invalid_request_error`.

## Plans (Anthropic)

The sign-in page (`claude.ai/oauth/authorize`, as pi-ai's
`loginAnthropic` sends a person there; under simulation the harness rewrites
the link) is a form: an email address and a plan (Pro, Max 5×, Max 20×;
"Unchanged" keeps an existing account's plan, a new one gets Max 5×). It
accepts only a loopback `redirect_uri` (pi-ai's `http://localhost:53692/callback`)
and redirects there with `code` and `state`. The token endpoint exchanges the
code (single use, ten minutes; the PKCE verifier is accepted without being
checked) for an access token `sk-ant-oat01-…` (one hour) and a refresh token
`sk-ant-ort01-…` (used once: a refresh issues a new pair). Tokens are rows of
the store's `tokens` table, tied to the account.

A Plan has a five-hour and a seven-day window of tokens (input, output and
cache writes, cache reads at a tenth): Pro 1M / 10M, Max 5× 5M / 50M, Max
20× 20M / 200M. A window starts with its first request and empties when it
ends. Every Plan response carries Anthropic's `anthropic-ratelimit-unified-*`
headers (status `allowed`, `allowed_warning` from 80%, per-window utilization
and reset); the request that crosses 100% is served, the next one is 429
`rate_limit_error` with status `rejected` and `retry-after` until the reset.
`/api/oauth/usage` reports `five_hour` and `seven_day` (`utilization` in
whole percent, `resets_at`, null before the window starts) and
`/api/oauth/profile` the account (email, uuid) and organization
(`organization_type` `claude_pro` / `claude_max`, `rate_limit_tier`), the
fields the harness's `subscription-usage.ts` reads.

The simulator's own endpoints are under `/_sim/`: `status`, `accounts`
(`?provider=`), `POST account` (`{ provider, kind, credential, state }`
creates an account or merges `state` into it; `kind` is `key` or `email`), and
`POST sign-in` (`{ provider: "anthropic", email, plan?, accessSeconds? }`:
the account, created if new, and fresh tokens, as the token endpoint answers).

## Adding a provider

List every endpoint DeepSea's stack calls for it (pi-ai's provider code, the
harness adapters and sign-in flows, billing's account reads), answer exactly
those in `providers.mjs` with the provider's error shapes, map its host in
`providerFor()`, give it a starting state, and test it in
`tests/sim.test.mjs` and in a `--simulated` throwaway.

## Tests

`node --test tests/*.test.mjs`: prompt finding, both wire formats, tool calls
and `expect`, cost lookup, credit and balance, errors with `Retry-After`,
unknown hosts; Anthropic's API key route and errors, the whole sign-in
(form, redirect with code and state, token, refresh, expiry, messages, usage,
profile), and Plan windows filling up to the 429 and resetting
(`tests/anthropic.test.mjs`). dsd's own test provisions a Plan fixture and
checks the credentials document it writes.

## Not simulated yet

Anthropic: `count_tokens`, message batches, files; the separate Opus and
Sonnet weekly windows and extra usage (always reported off); rate limits of
API keys (only the script's `error`); the usage endpoint's own rate limit.
A conversation whose last turn failed after a tool call reads a new prompt as
the old turn's continuation (the tool result and the prompt arrive in one
user message): start a new session for the next script.
