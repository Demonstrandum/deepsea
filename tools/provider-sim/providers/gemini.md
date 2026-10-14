# Gemini (simulated)

Google's Gemini API as pi-ai calls it: provider `google`, API
`google-generative-ai` through `@google/genai`, base URL
`https://generativelanguage.googleapis.com/v1beta`, the key from
`GEMINI_API_KEY` (the harness route `google`, `apiKeyEnv: GEMINI_API_KEY`).
The wire format is in `wire-gemini.mjs`.

| Host | Endpoints | Account |
|---|---|---|
| `generativelanguage.googleapis.com` | `POST /v1beta/models/<model>:streamGenerateContent` (`?alt=sse`: server-sent events, which pi-ai always asks for; without it a JSON array), `POST /v1beta/models/<model>:generateContent`, `GET /v1beta/models` (`pageSize`, `pageToken`), `GET /v1beta/models/<model>` | a Prepay credit balance; used up is 402 |

The key comes in `x-goog-api-key` (as the SDK sends it) or `?key=`. Any
string shaped like a Google API key (`AIza…`) names an account, created on
first use with $10 of credit and charged at the `google` catalog's prices
(input, output including thinking, cached input). A response may take the
balance below zero (Prepay's billing lag); the next request is refused.

## Requests and responses

Requests are read as pi-ai builds them: `contents` of `user` and `model`
turns, `systemInstruction` (`{ parts, role }`), `tools[].functionDeclarations`
(`parametersJsonSchema`), `generationConfig.thinkingConfig`. The prompt is
the user turn with text that starts the turn; tool results arrive as
`functionResponse` parts (`response: { output }` or `{ error }`) of a user
turn and are what `expect` checks.

A response is a `GenerateContentResponse`: `candidates[0].content.parts`, one
part per streamed chunk (text, `{ text, thought: true }` thought parts,
`functionCall` parts with `args`), `finishReason` (`STOP`, also for function
calls; `MAX_TOKENS` for `end` `max-tokens`) and the full `usageMetadata` on
the last chunk (earlier chunks carry only the prompt count), `modelVersion`,
`responseId` (the generation id in the store).

- Usage: `promptTokenCount` is input plus cached input,
  `cachedContentTokenCount` the cached part, `candidatesTokenCount` the
  output without thinking, `thoughtsTokenCount` the thinking (the script's
  `usage.reasoning`, else the `think` text's estimate), `totalTokenCount` all
  of it. pi-ai reads input as prompt minus cached and output as candidates
  plus thoughts.
- Thinking: thought parts are sent only with `thinkingConfig.includeThoughts`
  (pi-ai sets it when the session's effort is not off); hidden thinking is
  still counted and billed. `thinkingBudget: 0` (pi-ai's "off" for Gemini
  2.5) drops the script's `think` steps entirely. Gemini 3 cannot turn
  thinking off (pi-ai sends `thinkingLevel: MINIMAL`), so its thoughts are
  billed but hidden.
- Thought signatures: base64, on the first `functionCall` part of a response,
  or on the last part of one that calls nothing (an empty text part when the
  last piece was a pause); none with `thinkingBudget: 0`. pi-ai sends them
  back on the same model. Gemini 3 and later (`gemini-<n>` with n ≥ 3, as
  pi-ai reads ids) refuse a request whose current turn (since the latest user
  turn with text) has a model turn whose first function call lacks its
  signature: 400 `Function call is missing a thought_signature in
  functionCall parts…`.
- Call ids: Gemini 3 and later give each function call an `id` (the script's
  `id`, else a generated one), which pi-ai echoes in `functionResponse.id`.
  Earlier models send none; a result without one is matched to the script's
  tool call by name and order, so `expect` with `tool` works on both.

## Errors

Google's shape throughout: `{ error: { code, message, status, details? } }`,
`application/json; charset=UTF-8`.

| Case | Status |
|---|---|
| no key | 403 `PERMISSION_DENIED` "Method doesn't allow unregistered callers…" |
| a key not shaped `AIza…` | 400 `INVALID_ARGUMENT` "API key not valid. Please pass a valid API key." with `ErrorInfo` reason `API_KEY_INVALID` |
| no credit left | 402 "Your prepayment credits are depleted. …" |
| a model not in the catalog | 404 `NOT_FOUND` "models/<id> is not found for API version v1beta…" |
| no `contents`, a bad role, empty parts | 400 `INVALID_ARGUMENT` with Google's field message |
| an unknown path or method | 404 `NOT_FOUND` "Method not found." |
| script `error` | its kind's status, in Google's names: `rate-limit` 429 `RESOURCE_EXHAUSTED` (`retryAfter` as a `RetryInfo` `retryDelay`, as Google sends it; there is no `Retry-After` header), `overloaded` 503 `UNAVAILABLE`, `server` 500 `INTERNAL`, `timeout` 504 `DEADLINE_EXCEEDED`, `auth` 400 `API_KEY_INVALID`, `quota` 402, `network` 503; an explicit `status` is kept |

The 402 is documented by Google (Prepay at $0: "HTTP 402 Payment Required");
its `status` string (`RESOURCE_EXHAUSTED` here) and the message's second
sentence are not confirmed.

| Fixture | Account |
|---|---|
| `gemini`, `gemini-low` | Gemini API key (`GEMINI_API_KEY`, route `google`): $10, 5¢ of credit |

## Not simulated yet

The free tier and its per-model rate limits (requests and tokens per minute
and day); tiered prices (Gemini 2.5 Pro above 200k prompt tokens: the catalog
has one price); explicit context caches (`cachedContents`, storage cost) and
implicit caching (cached input only from the script's `usage`);
`countTokens`, `batchGenerateContent`, embeddings, Files, Live; images,
audio and other modalities in responses; safety blocks and their finish
reasons; `UNEXPECTED_TOOL_CALL` for undeclared functions; the OpenAI-compatible
endpoint (`/v1beta/openai/`); Vertex AI (pi-ai's `google-vertex`).

Gemini sign-ins: pi-ai 0.87.1 has no Google sign-in (no `google-gemini-cli`
or Antigravity provider, no `cloudcode-pa.googleapis.com` client), so there
is no Gemini Plan to simulate.
