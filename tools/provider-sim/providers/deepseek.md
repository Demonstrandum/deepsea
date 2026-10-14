# DeepSeek (simulated)

| Host | Endpoints | Account |
|---|---|---|
| `api.deepseek.com` | `POST /anthropic/v1/messages` (DeepSeek's own adapter), `POST /chat/completions`, `/v1/chat/completions`, `GET /models`, `GET /user/balance` | a balance; empty is 402 |

Reasoning streams as `reasoning_content`, as DeepSeek's OpenAI-compatible API sends it.

| Fixture | Account |
|---|---|
| `deepseek`, `deepseek-empty` | DeepSeek key: $10, empty balance |
