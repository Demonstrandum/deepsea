# Z.ai (simulated)

| Host | Endpoints | Account |
|---|---|---|
| `api.z.ai`, `open.bigmodel.cn` | `POST /api/coding/paas/v4/chat/completions` (streamed and whole), `GET /api/coding/paas/v4/models` | a key (`Bearer`): a balance and a GLM Coding Plan |

pi-ai reaches these as `zai` (`ZAI_API_KEY`) and `zai-coding-cn`
(`ZAI_CODING_CN_API_KEY`), both `openai-completions` at the GLM Coding Plan
endpoint, with Z.ai's options: `thinking: { type: enabled | disabled }`,
`reasoning_effort`, and `tool_stream: true` whenever it sends tools
(`zaiToolStream`). Nothing in the stack reads a Z.ai balance or quota.

Chunks are Z.ai's: no `object`, no `finish_reason: null`, `role` in every
delta, reasoning in `reasoning_content`, the last chunk's `usage` with
`prompt_tokens_details.cached_tokens`, ids that start with the (Beijing) time.
A tool call's arguments arrive in pieces when the request asks for
`tool_stream`, else whole in one chunk.

pi-ai's catalog prices the coding endpoint's models (only the `-highspeed`
ones are free), so a key's account keeps a balance ($10 to start), spent at
those prices; none left is 429 code `1113` "Insufficient balance or no resource
package. Please recharge." for a priced model. Every request also counts
against the Coding Plan's five-hour prompt quota (Lite 120, Pro 600, Max 2400,
as Z.ai publishes them; the window starts with its first request and empties
when it ends), all the free models need; a full window is 429 code `1308`
"Usage limit reached for 5 hour. Your limit will reset at <YYYY-MM-DD
HH:MM:SS>". Errors are Z.ai's `{ error: { code, message } }` (the code a
string): 401 `1001` without a key, 400 `1211` for a model not in the catalog,
404 `1222` for another path, and the script's `error` kinds as `1302`, `1305`,
`500`, `1234`, `1000`, `1113`, `1261`, `1214`.

| Fixture | Account |
|---|---|
| `zai` | Z.ai key (`ZAI_API_KEY`, route `zai`): $10, Pro |
| `zai-empty` | the same with no balance: priced models answer `1113`, the free ones still run |

`dsd sim account zai <key> --set '{"plan": "lite", "window": {"used": 120, "start": null}}'`
fills a key's five-hour window.

## Not simulated yet

The general (pay-as-you-go) endpoint `/api/paas/v4`, weekly and monthly
quotas (`1310`), extra usage, rate limits (only the script's `error`), a
stream that ends with `finish_reason` `sensitive` or
`model_context_window_exceeded`, and `thinking: { type: "disabled" }`
silencing a script's `think`.
