# Configuration

WikiKit is configured entirely via environment variables (12-factor, prefix
`WIKIKIT_*`). Precedence, highest first:

1. **Process environment** — deploys set it; always wins.
2. **`.env`** — local overrides, gitignored. Copy
   [`.env.example`](../.env.example) to get started.
3. **`.env.defaults`** — committed development defaults. **Never read when
   `NODE_ENV=production`**, so a dev database URL or dev pepper can never leak
   into a real deployment.

Invalid values fail fast at startup — a mistyped limit refuses the boot
instead of producing a half-configured server.

| Variable                            | Purpose                                                                                                        | Default                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `HOST`                              | Bind address (`127.0.0.1` behind a proxy)                                                                      | `127.0.0.1`                                                        |
| `PORT`                              | HTTP listen port                                                                                               | `4060`                                                             |
| `WIKIKIT_PUBLIC_URL`                | Public base URL — the MCP origin allowlist (DNS-rebinding guard); trailing slash stripped                      | `http://127.0.0.1:4060`                                            |
| `DATABASE_URL`                      | PostgreSQL connection string (tables prefixed `wk_`). **Required in production**                               | dev: `postgresql://postgres:wikikit-local@127.0.0.1:55442/wikikit` |
| `WIKIKIT_KEY_PEPPER`                | HMAC-SHA256 pepper for hashing `wk_` API keys at rest. **Required in production**                              | dev: `wikikit-local-key-pepper`                                    |
| `WIKIKIT_BOOTSTRAP_API_KEY`         | Pin the bootstrap admin key (`wk_...`)                                                                         | (empty; dev generates one and prints it once at boot)              |
| `WIKIKIT_LLM_PROVIDER`              | LLM provider the AI SDK routes to: `anthropic` \| `openai` \| `google`                                         | `anthropic`                                                        |
| `ANTHROPIC_API_KEY`                 | Key for `anthropic` provider. Enables LLM features (ingest, query); no default anywhere                        | (unset → ingest/query answer `503 llm_not_configured`)             |
| `OPENAI_API_KEY`                    | Key for `openai` provider (used when `WIKIKIT_LLM_PROVIDER=openai`)                                            | (unset)                                                            |
| `GOOGLE_GENERATIVE_AI_API_KEY`      | Key for `google` provider (used when `WIKIKIT_LLM_PROVIDER=google`)                                            | (unset)                                                            |
| `ANTHROPIC_BASE_URL`                | Anthropic API base override (test stubs, proxies); honored when provider is `anthropic`                        | (empty)                                                            |
| `WIKIKIT_MODEL_SYNTHESIS`           | Model for concept synthesis (one call per affected concept)                                                    | `claude-sonnet-5`                                                  |
| `WIKIKIT_MODEL_CLASSIFY`            | Cheap/filter model: source classification (one call per ingest) **and** session distillation (one per capture) | `claude-haiku-4-5`                                                 |
| `WIKIKIT_MODEL_ANSWER`              | Model for grounded Q&A (`POST .../query`)                                                                      | `claude-sonnet-5`                                                  |
| `WIKIKIT_MAX_BODY_BYTES`            | Max request body size → `413` (1 KiB – 250 MiB)                                                                | `10485760` (10 MiB)                                                |
| `WIKIKIT_MAX_INGEST_TOKENS`         | Chunking threshold for large sources (1 000 – 1 000 000)                                                       | `100000`                                                           |
| `WIKIKIT_INGEST_CONCURRENCY`        | Parallel ingest pipeline workers (1–16)                                                                        | `2`                                                                |
| `WIKIKIT_WEBHOOK_POLL_MS`           | Outbox poll interval (ms)                                                                                      | `5000` (`.env.defaults`: `1000`)                                   |
| `WIKIKIT_WEBHOOK_TIMEOUT_MS`        | Per-delivery HTTP timeout (ms)                                                                                 | `10000`                                                            |
| `WIKIKIT_WEBHOOK_MAX_ATTEMPTS`      | Delivery attempts (exponential backoff + jitter) before a delivery is `dead`                                   | `10`                                                               |
| `WIKIKIT_WEBHOOK_CIRCUIT_THRESHOLD` | Consecutive endpoint failures before the circuit breaker pauses it for 15 min                                  | `5`                                                                |
| `WIKIKIT_WEBHOOK_ALLOW_PRIVATE`     | Allow webhook deliveries to private/loopback targets — SSRF guard; keep `false` in production                  | `true` outside production, `false` in production                   |
| `WIKIKIT_TRUST_PROXY`               | Trust `X-Forwarded-*` headers (only behind a trusted reverse proxy)                                            | `false`                                                            |
| `WIKIKIT_MCP_SESSION_TTL_MS`        | Idle TTL for MCP sessions (sessions are leases, swept when idle)                                               | `1800000` (30 min)                                                 |
| `WIKIKIT_MCP_MAX_SESSIONS`          | MCP session hard cap; oldest-idle sessions are evicted at the cap                                              | `200`                                                              |
| `LOG_LEVEL`                         | `debug` \| `info` \| `warn` \| `error`                                                                         | `info`                                                             |
| `NODE_ENV`                          | `production` activates the guards below and disables `.env.defaults`                                           | (unset)                                                            |

## Zero-config development

`./wikikit` (or `bun run dev`) with **nothing** configured boots a complete
local stack:

- A dedicated Docker PostgreSQL 16 container (`wikikit-local-postgres`, port
  `55442`, named volume) is provisioned automatically to match the committed
  `.env.defaults` connection string.
- Migrations self-apply under a PostgreSQL advisory lock.
- A `default` space is created and a bootstrap API key with scope `*` is
  generated and printed **once** to stdout.

The provider API keys are the only settings with no default: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY`. Only the one matching
`WIKIKIT_LLM_PROVIDER` is read — without it every LLM-free feature (search,
read, history, lint, export, import, review) works normally, while ingest and
query answer `503 llm_not_configured` naming the key that provider needs.

## Production guards

With `NODE_ENV=production` the zero-config behavior flips off:

- `.env.defaults` is ignored entirely; no Docker auto-provisioning; no dev
  bootstrap (spaces and keys are provisioned explicitly).
- `DATABASE_URL` and `WIKIKIT_KEY_PEPPER` are **mandatory** — the process
  refuses to boot without them.
- `WIKIKIT_WEBHOOK_ALLOW_PRIVATE` defaults to `false` (SSRF guard).

`ANTHROPIC_API_KEY` stays deliberately optional in production: LLM-free
deployments (search/read/lint/export as a knowledge mirror) are first-class.

## Notes

- Changing `WIKIKIT_KEY_PEPPER` invalidates **every** issued API key (hashes
  no longer match) — rotate keys, not the pepper.
- The env loader mutates `process.env` because downstream libraries (`pg`, the
  AI SDK reading the provider API keys / `ANTHROPIC_BASE_URL`) read it directly.
- Every variable here is drift-tested: a `WIKIKIT_*` variable read by
  `src/config.ts` but missing from this file (or from `docs/llms-full.txt`)
  fails CI.
