# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report vulnerabilities privately via
[GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or by email to <mike@mikebild.com>.

You can expect an acknowledgement within a few days. Please include a
description of the issue, steps to reproduce and the affected version. You
will be credited in the fix release unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## Trust model

- **API keys are the only identity.** Keys (`wk_...`) are stored solely as
  `HMAC-SHA256(pepper, raw key)` and compared in constant time; the raw key is
  shown exactly once at creation. An unrecognized or revoked key gets
  `401 unauthorized`; a recognized key missing the required scope (or scoped
  to another space) gets `403 insufficient_scope` — two distinct failure
  modes by design.
- **The review gate is the safety boundary for agent writes.** Keys with
  `knowledge:propose` can only _stage_ content; nothing becomes visible
  knowledge without a `knowledge:approve` action. The MCP tool palette
  deliberately contains no approve tool.
- **Ingested URLs are fetched by the server.** Treat the `knowledge:propose`
  scope accordingly: a proposer can make WikiKit issue outbound HTTP requests
  to arbitrary hosts (the acquired content still only lands in the staging
  area).
- **Webhook targets are operator-configured (admin scope) and SSRF-guarded:**
  in production, deliveries to private/loopback addresses are refused unless
  `WIKIKIT_WEBHOOK_ALLOW_PRIVATE` is explicitly enabled.
- **LLM boundary:** source material is sent to the configured Anthropic
  models during ingest/query. Do not ingest content you may not share with
  your model provider; run without `ANTHROPIC_API_KEY` for a fully LLM-free
  deployment.

## Hardening notes for operators

- Treat `WIKIKIT_KEY_PEPPER`, the database credentials and every webhook
  secret as independent production secrets. Rotating the pepper invalidates
  every issued key — rotate keys instead.
- Keep the service bound to localhost (`HOST=127.0.0.1`) behind a reverse
  proxy (Caddy, nginx) that terminates TLS; set `WIKIKIT_TRUST_PROXY=1` only
  behind a trusted proxy.
- Mint scoped, space-scoped keys instead of sharing the bootstrap `*` key;
  never give the `knowledge:approve` scope to an autonomous agent.
- Verify the Standard Webhooks signature (`webhook-signature: v1,<HMAC>` over
  `id.timestamp.body`, plus a timestamp window) at every receiver. Accepting
  unsigned deliveries is not acceptable.
- `/metrics` is unauthenticated Prometheus output — keep it gated at the
  proxy if your edge would otherwise expose it.
- Migrations run embedded in the binary under an advisory lock; never apply
  application SQL by hand.
- Back up PostgreSQL — it is the single source of truth. Markdown/OKF exports
  are projections, useful as portable snapshots but not a substitute for
  database backups.
