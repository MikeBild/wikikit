# Deployment

WikiKit deploys as a single self-contained binary behind a reverse proxy, with
a PostgreSQL 16+ database. `.env.defaults` is development-only and is ignored
whenever `NODE_ENV=production`; your process manager supplies the explicit
production environment (for example from `/etc/wikikit/.env`).

## Build

```bash
bun install
bun run build:binary        # → dist/wikikit
```

`build-binary.sh` regenerates the embedded migrations, compiles
`bin/wikikit.ts` with `bun build --compile` (the version is injected via
`--define WIKIKIT_BUILD_VERSION`), and verifies the fresh binary identifies
itself via `--version`. The result is one executable with no Bun/Node
installation and no `node_modules` on the host. Build per target platform
(`OUTFILE=dist/wikikit-linux-x64 ./build-binary.sh`); prebuilt Linux x64 and
macOS ARM64 binaries with a `SHA256SUMS` file are attached to GitHub releases.

## Run it

```bash
# dev (zero-config: Docker Postgres auto-provisioned, self-migrating)
bun run dev

# production
NODE_ENV=production \
DATABASE_URL=postgresql://wikikit:...@127.0.0.1:5432/wikikit \
WIKIKIT_KEY_PEPPER=<32+ random bytes> \
HOST=127.0.0.1 PORT=4060 \
./dist/wikikit
```

Ops flags (this is not a CLI product):

| Invocation          | Effect                                    |
| ------------------- | ----------------------------------------- |
| `wikikit`           | start the server                          |
| `wikikit --migrate` | apply embedded migrations and exit        |
| `wikikit --version` | print the version and exit (no DB needed) |

## Migration ownership

The binary embeds its migration journal and SQL bodies. On every boot and on
`--migrate`, one dedicated connection holds a PostgreSQL advisory lock while
pending migrations apply transactionally — concurrent instances serialize
safely. Deployment scripts only provision the database and login; they never
copy or execute SQL files. A migration failure aborts startup and keeps
`/ready` down, which lets the deploy pipeline roll back.

## Production checklist

- **Secrets first:** `DATABASE_URL` and `WIKIKIT_KEY_PEPPER` are mandatory —
  the process refuses to boot without them. Generate the pepper as 32+ random
  bytes; changing it later invalidates every issued key.
- **Bind locally behind a proxy:** `HOST=127.0.0.1`, terminate TLS in Caddy or
  nginx, set `WIKIKIT_TRUST_PROXY=1` so client information from
  `X-Forwarded-*` is honored, and set `WIKIKIT_PUBLIC_URL` to the public
  origin (it feeds the MCP Origin allowlist).
- **Scoped keys, not the bootstrap key:** mint separate `knowledge:read`,
  `knowledge:propose` and `knowledge:approve` keys via `POST /v1/api-keys`;
  never hand the approve scope to an autonomous agent.
- **SSRF guard on:** leave `WIKIKIT_WEBHOOK_ALLOW_PRIVATE` unset (production
  default `false`) so webhook deliveries cannot reach private/loopback
  targets.
- **LLM key is optional:** without `ANTHROPIC_API_KEY` the deployment serves
  every LLM-free feature; ingest/query answer `503 llm_not_configured`.
- **Run non-root** as a dedicated service account with systemd hardening.

## systemd

```ini
[Unit]
Description=WikiKit
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=wikikit
Group=wikikit
Environment=NODE_ENV=production
EnvironmentFile=/etc/wikikit/.env
ExecStart=/usr/local/bin/wikikit
Restart=on-failure
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/wikikit

[Install]
WantedBy=multi-user.target
```

## Health & lifecycle

- `GET /health` — liveness: `200 "ok"` while the process is up (no DB lookup).
- `GET /ready` — readiness: `200 {"status":"ready","version":"x.y.z"}`;
  `503 {"status":"draining",...}` during shutdown. Deploy health gates should
  match **both** the status and the expected release version — that makes the
  gate migration-aware (a binary that cannot reach its schema never reports
  ready).
- On `SIGTERM`/`SIGINT` the service fails `/ready` immediately, stops the
  outbox and ingest workers, drains in-flight requests, then exits 0 (30 s
  hard cap covers a hung LLM call).

A typical deploy: download the release binary, verify `SHA256SUMS`, move it
into place atomically (keep a `.prev` for rollback), restart the unit, then
gate on `/ready` returning `ready` **and** the new version within 90 s —
otherwise restore `.prev` and restart. Smoke-test `/health`, `/ready`,
`/openapi.json`, `/llms.txt`, a 401-without-key, an authenticated read and an
MCP initialize.

## Logging & metrics

Structured JSON logs go to stdout (one line per request, with the request id —
the same id the error envelope carries). API keys are never logged. Prometheus
metrics are at `/metrics`; it is unauthenticated, so keep it proxy-gated if
your edge exposes it.

## Release pipeline

CI runs lint → typecheck → unit (incl. drift gates) → contract → integration
(real Docker PostgreSQL). Pushing a SemVer tag matching `package.json` (e.g.
`v0.1.0`) builds the per-platform binaries via `build-binary.sh` and publishes
them with `SHA256SUMS` as a GitHub release. Continuous deployment then ships
the binary, restarts the unit and runs the smoke + e2e suites against the live
instance.
