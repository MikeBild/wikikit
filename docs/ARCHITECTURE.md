# Architecture

WikiKit is a headless TypeScript service on Bun — strict ESM, factory-function
DI (`createX(config, deps)`), no ORM, no web framework (`node:http`
compatible), zod v4 at every boundary. PostgreSQL is the single source of
truth; Markdown and OKF are import/export projections. The only interfaces are
HTTP/REST and MCP — no CLI (ops flags only), no web UI.

## The knowledge lifecycle

1. **Ingest** archives the source verbatim (`sha256` content hash = the
   idempotency anchor; a hash hit answers `409 already_ingested`).
2. **Classify** (one cheap LLM call) maps the source onto the existing concept
   index: which concepts are affected, which new ones are warranted.
3. **Synthesize** (one LLM call per concept) produces a new revision —
   markdown, summary, claims with verbatim quotes and confidences, relations,
   and — when the source is a meeting (`source_kind: "meeting"`) — the explicit
   decisions it records, staged as proposed `wk_decisions` (the decision-log
   pattern: an agent stages decisions, a human promotes them). Every call is
   recorded in the `wk_agent_runs` ledger, and
   `{model, prompt_version, input_hash, usage, source_ids}` is stamped into
   the `agent_meta` of every generated row.
4. **Contradiction detection** is deterministic: same `(subject, predicate)`,
   different `object` → flagged in the proposal.
5. **Propose**: one transaction inserts the revisions, claims, citations,
   relations, decisions and the ChangeProposal, plus an outbox event.
6. **Review**: a human (or governed workflow) reads the structured diff
   (`GET /v1/proposals/{id}`, also as `text/markdown` via Accept) and calls
   approve or reject — a deliberate, separate act.
7. **Apply** is a single SQL function (`wk_apply_proposal`): old revision →
   `superseded`, proposed → `current`, pointer repointed, claims →
   `verified` (contradicting pairs → both `disputed` + a `contradicts`
   relation), relations/decisions activated, space epoch bumped, webhooks
   emitted — atomically.

### Staged rows, not diff blobs

Proposal content is **real rows** in the target tables with
`status='proposed'` and a `proposal_id` — never a JSON diff. Approving is a
status flip inside one SQL function behind a row lock, so concurrent reviews
serialize and double-applies fail cleanly (`proposal_not_pending`). Every
proposed revision carries the `base_revision_id` it was synthesized against;
apply fails with `stale_base` when the concept has moved on — newer knowledge
is never silently clobbered.

### Visibility by construction

Readers (search, concept reads, exports) join through
`wk_concepts.current_revision_id` and visible claim statuses
(`verified | disputed | deprecated`). Proposed content is not filtered out —
it is structurally unreachable. The full-text search runs through the
whitelisted `wk_search()` SQL function, which only joins current revisions.

### Classification is a revisable claim, not a schema

Categorizations and relations are claims/relations with a source, a status and
a lifecycle — never a fixed taxonomy. When a new source contradicts an old
classification, both claims become `disputed` and the disagreement is visible
(and lintable) instead of silently resolved. Disputed knowledge is reported as
disputed by `/query` and the MCP read tools.

## Request lifecycle (REST)

```
client ──▶ src/http/server.ts
  1. request id (12-hex, echoed as x-request-id) + draining check
  2. route match against the ROUTES registry
  3. auth: wk_ key → HMAC(pepper) lookup → Principal {scopes, spaceId}
  4. route-level scope check; body size cap; zod validation (params/query/body)
  5. handler: resolveSpace(slug) → space-level scope check → domain call
  6. typed domain errors → the terminal error envelope {error, code,
     request_id, next_best_actions}
```

The `{space}` path segment is the space slug; handlers resolve it once and
pass `space.id` down — every space-scoped SQL query filters by `space_id`.

## Module map (`src/`)

| Module           | Responsibility                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `config.ts`      | Env loader (`WIKIKIT_*`), precedence env > `.env` > `.env.defaults`, production guards                          |
| `app.ts`         | Composition root: `createApp(config, deps)` wires db → llm → pipeline → workers → http                          |
| `db/postgres.ts` | Safe query layer: `wk_` table allowlist, SQL-function whitelist (`db.call`), `db.tx`, outbox `emitEvent`        |
| `db/migrate.ts`  | Self-migration under a PG advisory lock; SQL files embedded via codegen (`embedded.ts`, drift-tested)           |
| `domain/`        | Transport-agnostic knowledge logic — consumed identically by REST and MCP                                       |
| `ingest/`        | The product core: acquire → archive → dedup → classify → synthesize → detect → propose                          |
| `llm/`           | 3-method provider interface (`classify`/`synthesize`/`answer`), Anthropic impl, FakeProvider, versioned prompts |
| `query/`         | `search.ts` (LLM-free FTS) and `answer.ts` (grounded Q&A with citations)                                        |
| `export/`        | Markdown tree + OKF bundle adapters behind one `BundleFormatAdapter`; import stages ONE proposal                |
| `http/`          | `routes.ts` (ROUTES registry + handlers), `openapi.ts`, `auth.ts`, `jobs.ts`, `server.ts`, `schemas.ts`         |
| `mcp/`           | Streamable HTTP server, session leases, tool palette, draft-07 schema conversion, error adapter                 |
| `webhooks.ts`    | Standard-Webhooks outbox worker: backoff, circuit breaker, `v1,<HMAC>` signatures                               |
| `markdown.ts`    | unified/remark frontmatter pipeline (parse/serialize, HTML→Markdown normalization)                              |

## One registry, many surfaces

`src/http/routes.ts` exports the `ROUTES` array — the single source of truth
for the HTTP surface. The router, the OpenAPI 3.1 document
(`buildOpenApi(ROUTES)`, served live at `/openapi.json` and snapshotted into
`docs/openapi.json`), the drift tests and the docs all derive from the same
array, so the spec cannot drift from the implementation. Entries reference
handlers and zod schemas **by name**, which keeps the registry introspectable
without executing handlers.

Drift detection (CI gates): route handlers ↔ ROUTES set-equality; the endpoint
lists in `docs/llms.txt` / `docs/llms-full.txt` ↔ ROUTES; every `WIKIKIT_*`
env var in `src/config.ts` documented in `docs/CONFIGURATION.md` **and**
`docs/llms-full.txt`; the MCP tool list ↔ `docs/llms-full.txt`; the committed
`docs/openapi.json` ↔ `buildOpenApi()`; `embedded.ts` ↔ `migrations/*.sql`.

## MCP server

Streamable HTTP at `POST /mcp`, deliberately outside ROUTES/OpenAPI, behind
the same key auth. One SDK server per session; handlers close over the
authenticated Principal. Sessions are **leases, not allocations**: idle-TTL
sweeper, hard cap with oldest-idle eviction, in-flight retain counter; a
foreign key on a known session id gets 404 (hijack guard), an unknown session
gets JSON-RPC `-32001` for clean re-initialization. Origin validation guards
against DNS rebinding. Tool input schemas are the same zod objects REST
validates with, converted to draft-07 JSON Schema with
`additionalProperties: false`; all four annotations are explicit on every
tool. Scope-gating is tool _visibility_ — and there is intentionally no
approve tool: agents stage, humans promote.

## Database access discipline

`db.query` only touches tables on the `wk_` allowlist; review decisions go
exclusively through `db.call` with a three-function whitelist
(`wk_apply_proposal`, `wk_reject_proposal`, `wk_search`). Outbox events are
inserted via `db.emitEvent` on a transaction-bound handle, so an event can
only exist for a state change that actually committed.

## Binary packaging

`build-binary.sh` runs `bun build bin/wikikit.ts --compile` — a true single
executable (all dependencies are pure JS), no unpack step, no Node runtime on
the host. The version is injected at compile time
(`--define WIKIKIT_BUILD_VERSION`) and verified by running `--version` on the
fresh binary; `/ready` reports it for the deploy health gate. Migrations are
embedded as generated string literals (`src/db/migrations/embedded.ts`) so
the binary migrates itself with no SQL files on disk.
