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

| Variable                             | Purpose                                                                                                        | Default                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `HOST`                               | Bind address (`127.0.0.1` behind a proxy)                                                                      | `127.0.0.1`                                                        |
| `PORT`                               | HTTP listen port                                                                                               | `4060`                                                             |
| `WIKIKIT_PUBLIC_URL`                 | Canonical public base URL — OAuth issuer/resource and MCP origin allowlist; HTTPS required in production       | `http://127.0.0.1:4060`                                            |
| `DATABASE_URL`                       | PostgreSQL connection string (tables prefixed `wk_`). **Required in production**                               | dev: `postgresql://postgres:wikikit-local@127.0.0.1:55442/wikikit` |
| `WIKIKIT_KEY_PEPPER`                 | HMAC-SHA256 pepper for hashing `wk_` API keys at rest. **Required in production**                              | dev: `wikikit-local-key-pepper`                                    |
| `WIKIKIT_BOOTSTRAP_API_KEY`          | Pin the bootstrap admin key (`wk_...`)                                                                         | (empty; dev generates one and prints it once at boot)              |
| `DEPLOYMENT_ENVIRONMENT`             | Stable deployment identity attached to structured logs                                                         | `production` in production, otherwise `development`                |
| `WIKIKIT_LLM_PROVIDER`               | LLM provider the AI SDK routes to: `anthropic` \| `openai` \| `google`                                         | `anthropic`                                                        |
| `ANTHROPIC_API_KEY`                  | Key for `anthropic` provider. Enables LLM features (ingest, query); no default anywhere                        | (unset → ingest/query answer `503 llm_not_configured`)             |
| `OPENAI_API_KEY`                     | Key for `openai` provider (used when `WIKIKIT_LLM_PROVIDER=openai`)                                            | (unset)                                                            |
| `GOOGLE_GENERATIVE_AI_API_KEY`       | Key for `google` provider (used when `WIKIKIT_LLM_PROVIDER=google`)                                            | (unset)                                                            |
| `ANTHROPIC_BASE_URL`                 | Anthropic API base override (test stubs, proxies); honored when provider is `anthropic`                        | (empty)                                                            |
| `WIKIKIT_MODEL_SYNTHESIS`            | Model for concept synthesis (one call per affected concept)                                                    | `claude-sonnet-5`                                                  |
| `WIKIKIT_MODEL_CLASSIFY`             | Cheap/filter model: source classification (one call per ingest) **and** session distillation (one per capture) | `claude-haiku-4-5`                                                 |
| `WIKIKIT_MODEL_ANSWER`               | Model for grounded Q&A (`POST .../query`)                                                                      | `claude-sonnet-5`                                                  |
| `WIKIKIT_MAX_BODY_BYTES`             | Max request body size → `413` (1 KiB – 250 MiB)                                                                | `10485760` (10 MiB)                                                |
| `WIKIKIT_MAX_INGEST_TOKENS`          | Chunking threshold for large sources (1 000 – 1 000 000)                                                       | `100000`                                                           |
| `WIKIKIT_INGEST_CONCURRENCY`         | Parallel ingest pipeline workers (1–16)                                                                        | `2`                                                                |
| `WIKIKIT_INGEST_LEASE_MS`            | Worker lease duration; an expired running job is reaped as `worker_lost` (10 s–24 h)                           | `900000` (15 min)                                                  |
| `WIKIKIT_INGEST_HEARTBEAT_MS`        | Lease renewal cadence; must be less than half the lease duration (1 s–1 h)                                     | `30000`                                                            |
| `WIKIKIT_WEBHOOK_POLL_MS`            | Outbox poll interval (ms)                                                                                      | `5000` (`.env.defaults`: `1000`)                                   |
| `WIKIKIT_WEBHOOK_TIMEOUT_MS`         | Per-delivery HTTP timeout (ms)                                                                                 | `10000`                                                            |
| `WIKIKIT_WEBHOOK_MAX_ATTEMPTS`       | Delivery attempts (exponential backoff + jitter) before a delivery is `dead`                                   | `10`                                                               |
| `WIKIKIT_WEBHOOK_CIRCUIT_THRESHOLD`  | Consecutive endpoint failures before the circuit breaker pauses it for 15 min                                  | `5`                                                                |
| `WIKIKIT_WEBHOOK_ALLOW_PRIVATE`      | Allow webhook deliveries to private/loopback targets — SSRF guard; keep `false` in production                  | `true` outside production, `false` in production                   |
| `WIKIKIT_TRUST_PROXY`                | Trust `X-Forwarded-*` headers (only behind a trusted reverse proxy)                                            | `false`                                                            |
| `WIKIKIT_MCP_SESSION_TTL_MS`         | Idle TTL for MCP sessions (sessions are leases, swept when idle)                                               | `1800000` (30 min)                                                 |
| `WIKIKIT_MCP_MAX_SESSIONS`           | MCP session hard cap; oldest-idle sessions are evicted at the cap                                              | `200`                                                              |
| `WIKIKIT_MCP_ELICITATION_TIMEOUT_MS` | Maximum native MCP review-form wait; timeout fails closed before mutation (10 s–30 min)                        | `300000` (5 min)                                                   |
| `WIKIKIT_USAGE_TELEMETRY_ENABLED`    | Enable the privacy-bounded product usage ledger                                                                | `false`                                                            |
| `WIKIKIT_USAGE_HMAC_SECRET`          | Independent secret for product-local actor/session HMACs; required when telemetry is enabled                   | (unset)                                                            |
| `WIKIKIT_USAGE_RETENTION_DAYS`       | Raw usage event retention (31–365 days)                                                                        | `90`                                                               |
| `WIKIKIT_OAUTH_DCR_ENABLED`          | Enable RFC 7591 dynamic registration for ChatGPT and other remote MCP clients                                  | `true`                                                             |
| `WIKIKIT_OAUTH_CODE_TTL_MS`          | OAuth authorization-code lifetime (1–15 min)                                                                   | `600000` (10 min)                                                  |
| `WIKIKIT_OAUTH_ACCESS_TOKEN_TTL_MS`  | OAuth access-token lifetime (5 min–24 h)                                                                       | `3600000` (1 h)                                                    |
| `WIKIKIT_OAUTH_REFRESH_TOKEN_TTL_MS` | OAuth rotating refresh-token lifetime (1 h–90 d)                                                               | `2592000000` (30 d)                                                |
| `WIKIKIT_OAUTH_ALLOWED_SCOPES`       | Interactive identity permission ceiling: comma-separated read/propose/approve                                  | `knowledge:read,knowledge:propose`                                 |
| `WIKIKIT_OAUTH_PROVIDERS`            | Single JSON list of named `api_key`, `token_bridge`, and `oidc` adapters                                       | API-key record                                                     |
| `LOG_LEVEL`                          | `debug` \| `info` \| `warn` \| `error`                                                                         | `info`                                                             |
| `NODE_ENV`                           | `production` activates the guards below and disables `.env.defaults`                                           | (unset)                                                            |

## Remote MCP identity providers

`WIKIKIT_OAUTH_PROVIDERS` is the only browser identity configuration after a
remote client has completed OAuth discovery and PKCE:

- `api_key` uses an existing scoped WikiKit operator key.
- `token_bridge` redirects to a configured hosted login adapter and verifies
  the returned JWT against its configured issuer, audience and JWKS URL.
- `oidc` uses standard discovery and Authorization Code + PKCE.
- Multiple enabled methods and OIDC entries share one provider chooser.

The browser surface never inherits vendor or configured labels. It renders the
versioned `mcp-auth-v2` card with `Continue with SSO` first and `Continue with
API key` second. Every adapter uses the same `/v1/identity/login/start`,
`/v1/identity/login/callback`, `/v1/identity/logout`, provider discovery and
session-exchange routes; provider ids are opaque configuration values.

`WIKIKIT_OAUTH_ALLOWED_SCOPES` is an identity permission ceiling, not a client
request. It defaults to `knowledge:read,knowledge:propose`. Add
`knowledge:review` for identities that inspect proposals and start the MCP
review, and `knowledge:approve` (which implies `knowledge:review`) only for
trusted human reviewers who may also use the REST approve/reject endpoints; a
client must still ask for a scope and the consent page displays it. Scope
merely exposes the MCP review tool: WikiKit still collects the actual decision
from a human through native form elicitation. A client that cannot show the form gets a pending
`human_review_required` hand-off with a `review_url`; the human decides on
that embedded review page (or over REST) as themselves. `admin` is never issued
to an interactive OAuth identity.

The provider array uses one shared `protocol` discriminator. Provider ids are
unique; `api_key` may occur once, while `token_bridge` and `oidc` may occur
several times. OIDC `scopes` must include `openid`.
JWT bridge claim paths default to `sub`, `email`, and `email_verified`.
Set `subject_claim`, `email_claim`, or `email_verified_claim` to a safe dotted
path when an adapter nests the same semantics (for example
`user_metadata.email_verified`). Verification must still resolve to the
boolean value `true`; it cannot be disabled.

```json
[
  {
    "protocol": "api_key",
    "id": "api-key",
    "label": "WikiKit API key"
  },
  {
    "protocol": "token_bridge",
    "id": "external-identity",
    "label": "External identity",
    "login_url": "https://login.example.com/wikikit/",
    "issuer_url": "https://identity.example.com",
    "audience": "wikikit",
    "jwks_url": "https://identity.example.com/.well-known/jwks.json",
    "allowed_emails": ["reviewer@example.com"]
  },
  {
    "protocol": "oidc",
    "id": "workforce-oidc",
    "label": "Workforce OIDC",
    "issuer_url": "https://identity.example.com",
    "client_id": "<public-or-confidential-client-id>",
    "client_secret": "<optional-confidential-client-secret>",
    "scopes": "openid profile email",
    "allowed_emails": ["reviewer@example.com"],
    "allowed_scopes": ["knowledge:read", "knowledge:propose", "knowledge:review", "knowledge:approve"]
  }
]
```

Do not put this JSON in version control when it has a `client_secret`; inject
it through the production secret store. Register
`${WIKIKIT_PUBLIC_URL}/v1/identity/login/callback` as every OIDC provider's
redirect URI and keep `WIKIKIT_PUBLIC_URL` on its canonical HTTPS origin. All
adapters use only `/v1/identity/login/start`,
`/v1/identity/login/callback`, and `/v1/identity/logout`.

`GET /v1/identity/providers` returns only the safe common discovery projection:
`protocol`, opaque `id`, canonical `label` (`SSO` or `API key`) and the
protocol metadata needed by a client (`login_url` or `issuer`).
`POST /v1/identity/sessions` accepts only a configured `provider_id` plus an
`identity_token` and returns `{api_key,principal_id,context_id,email}`. It never
accepts a caller-supplied issuer or a provider-specific payload shape.

## Privacy-safe usage telemetry

Usage telemetry is deliberately opt-in. Set
`WIKIKIT_USAGE_TELEMETRY_ENABLED=true` and supply a dedicated random
`WIKIKIT_USAGE_HMAC_SECRET`; do not reuse `WIKIKIT_KEY_PEPPER`. The service
then writes append-only, product-local events and deletes raw rows after
`WIKIKIT_USAGE_RETENTION_DAYS` (default 90; allowed 31–365).

The ledger stores only controlled operation/route/tool names, status/outcome,
traffic and request source, durations, sizes/counts, active MCP capacity and
product-local HMAC actor/session ids. It never stores source or generated
content, prompts, search/question text, MCP arguments/results, raw URL paths or
query strings, IP address, user agent, OAuth/API credentials, e-mail, space
slug, or dynamic object ids. Anonymous HTTP requests receive neither an actor
nor session fingerprint. The HMAC scope is WikiKit only; aggregate consumers
must not join it to actor ids from another product.

Authenticated callers may set `X-WikiKit-Traffic-Class` to `organic`,
`synthetic`, or `internal`, and `X-WikiKit-Request-Source` to `api`, `gateway`,
`scheduler`, or `manual`. Unauthenticated values are ignored. Health,
readiness, metrics, documentation and statistics/report collection routes are
always `internal`. Optional `X-WikiKit-Session-Id` is HMACed only for an
authenticated caller.

Usage queries accept `bucket=hour|day|month|year`, RFC 3339 `from`/`to`,
`tz=UTC`, `traffic_class=organic|synthetic|internal|all`, and at most two
comma-separated, surface-specific `group_by` dimensions. Each response is
`wikikit.usage-stats.v1`, reports exact full-window actor/session uniques,
keeps ratio numerator/denominator evidence, distinguishes zero from missing,
declares `sampled:false`, and never returns raw events.

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
- `WIKIKIT_PUBLIC_URL` must be the canonical HTTPS origin. OAuth discovery,
  audience binding and ChatGPT redirects derive from it.
- `WIKIKIT_WEBHOOK_ALLOW_PRIVATE` defaults to `false` (SSRF guard).

Product stats reuse existing space-scoped `knowledge:read` keys. No additional
credential or local aggregate checkpoint is required.

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
