# OpenRouter (simulated)

| Host | Endpoints | Account |
|---|---|---|
| `openrouter.ai` | `POST /api/v1/chat/completions` (OpenAI format), `POST /api/v1/messages` (Anthropic format: pi-ai sends Anthropic models there), `GET /api/v1/models`, `GET /api/v1/generation?id=` (a response's cost), `GET /api/v1/key`, `GET /api/v1/credits` | credit and usage; no credit left is 402 |

The chat-completion stream carries `usage.cost`, and `/api/v1/generation?id=` answers a response's `total_cost`, as OpenRouter does; both are what the simulator charged.

| Fixture | Account |
|---|---|
| `openrouter`, `openrouter-low`, `openrouter-empty` | OpenRouter key: $10, 5¢, no credit |
