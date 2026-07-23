# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.18.0 - 2026-07-23

### Added

- Admin REST for SSO identity grants (migration
  `0028_wk_identity_grants_admin`, scope `admin`):
  - `GET /v1/identities` lists every grant (provider, subject, email,
    display_name, `allowed_scopes` ceiling, `grant_source`, revocation and
    seen timestamps) — never tokens or hashes.
  - `PUT /v1/identities/{provider}/{subject}` idempotently creates/updates a
    grant. `role` XOR `scopes`: the named roles `reader`/`contributor`/
    `reviewer` are server-side shortcuts expanded into scope sets and never
    stored; `knowledge:approve` deliberately has NO shortcut and must be
    granted as an explicit scopes array. Sending both (or neither on a new
    grant, or an unconfigured provider id) is `422 unprocessable`. A PUT on a
    revoked grant without `restore:true` is `409 identity_revoked` —
    `restore:true` is the only way to clear a revocation.
  - `DELETE /v1/identities/{provider}/{subject}` revokes the grant and
    additionally kills the identity's live OAuth access/refresh tokens and
    pending authorization codes (idempotent).
- `wk_oauth_identities` grows `display_name` and `grant_source`
  (`admin`/`seed`/`signup`/`bootstrap`); pre-existing self-signup rows are
  backfilled as `signup`, allowlist rows as `bootstrap`. The deploy seeder
  manages only rows with `grant_source='seed'`; a manual PUT (stamped
  `admin`) takes the row out of the seeder's hands permanently.

### Changed

- The `wk_oauth_identities` row is now the SINGLE AuthZ truth, effective
  immediately (the auth path reads the row per request/token issue, no
  restart): a stored `allowed_scopes` ceiling wins over the ENV allowlist,
  and an allowlisted login mirrors the provider's `allowed_scopes` into the
  row (`grant_source='bootstrap'`) instead of resetting the per-row ceiling
  to NULL. Rows with `grant_source` `admin`/`seed`/`signup` are never
  overwritten by the allowlist path. The ENV allowlist is bootstrap-only;
  WikiKit warns at boot when it exceeds two entries.
- `POST /v1/identity/sessions` admits identities through the same DB-grant
  contract as the browser SSO callback: operator-granted identities work
  without an ENV allowlist entry, and the issued identity API key carries the
  stored ceiling (an unknown identity is now `403 access_denied` instead of
  `401 invalid_token`).

### Security

- `revoked_at` always wins: a revoked identity is denied even while its
  subject/email still stands in the ENV allowlist, and no login path
  un-revokes a row (previously an allowlisted login reset `revoked_at` to
  NULL, silently re-admitting revoked identities). Revocation also kills the
  identity's live OAuth tokens; re-admission is exclusively the explicit
  admin-REST restore.

## 0.17.0 - 2026-07-23

### Added

- URL-mode elicitation fallback for `wikikit_review_proposal` (MCP
  2025-11-25): the native in-client form stays the primary review channel —
  in a terminal client the in-terminal review dialog — and only when the
  client has no `elicitation.form`, or advertises one and provably never
  renders it, does the tool fall back to `elicitation.url`. The human
  consents to open the embedded review page
  (`GET /review/{id}?via=elicitation`), the tool returns
  `outcome: "url_review_started"` without blocking, the decision lands on the
  page with the reviewer's own key, and the server sends
  `notifications/elicitation/complete` to exactly the originating session
  (best-effort; `wikikit_proposals` polling stays the durable path).
- New audited review channel `url_elicitation` (migration
  `0027_wk_url_elicitation_channel`): the review page reports elicitation
  provenance via an optional `via` body field on the REST review endpoints —
  informational only, no auth effect.

### Fixed

- A form-mode cancel arriving faster than any human could read the form (a
  client that advertises `elicitation.form` but auto-cancels without
  rendering it) is no longer reported as a human cancel: the review degrades
  to the URL consent or the `human_review_required` hand-off, so the agent
  gets actionable instructions instead of repeated silent cancels.
- Elicitation capability detection now follows the spec's backwards
  compatibility rule: an empty `elicitation: {}` client capability counts as
  form support.

## 0.16.1 - 2026-07-23

### Fixed

- Coverage-gap lexeme capture now resolves the space's text-search config
  through the db.call whitelist instead of inlining the SQL function —
  db.query's identifier guard (correctly) rejected the inlined call, so
  opt-in gap topics silently recorded nothing.

## 0.16.0 - 2026-07-23

### Added

- Coverage insights endpoint `GET /v1/spaces/{space}/stats/coverage`
  (migration `0026_wk_coverage_stats`, schema `wikikit.coverage-stats.v1`):
  open disputed claims with the age of the oldest one, review latency and
  approve/reject counts for a window, concept freshness (share not updated
  for 90+ days), the most-read concepts (per-day aggregate read counters for
  explicit REST/MCP concept reads — actor-free by design), the most-linked
  concepts (inbound active relations), and — opt-in via
  `WIKIKIT_COVERAGE_GAP_TOPICS_ENABLED` (default `false`) — the stemmed
  lexemes of questions the base could not answer (never the question text;
  rows expire with the usage retention window).

## 0.15.0 - 2026-07-23

### Added

- Demand-vs-coverage telemetry (migration `0025_wk_usage_no_answer`): when a
  query call answers honestly that the knowledge base does not cover the
  question, the knowledge-surface usage row records the new outcome
  `no_answer` instead of `success` (transport rows keep their status
  semantics — a 200 stays a 200). Usage stats gain `no_answer` and
  `no_answer_ratio` metrics, measuring demand the curated base does not yet
  cover. Failed requests are never counted as `no_answer`.

## 0.15.1 - 2026-07-23

### Fixed

- The `/mcp` 401 `WWW-Authenticate` challenge now advertises the complete
  knowledge permission set from `scopes_supported`
  (`knowledge:read knowledge:propose knowledge:review knowledge:approve`)
  instead of only read/propose, so MCP clients offer review/approve on their
  consent surface too. `offline_access` is a token-mechanics scope and stays
  out of the challenge. Actual grants are still clamped to the identity's
  ceiling by the unchanged consent logic.

## 0.14.0 - 2026-07-23

### Added

- Self-signup for OIDC identities (`WIKIKIT_OAUTH_ENABLE_SIGNUP`, default
  `false`; migration `0024_wk_oauth_identity_signup`): when enabled, an
  unknown OIDC identity that authenticates at the SSO callback is
  auto-admitted and registered in `wk_oauth_identities` with its own
  per-identity permission ceiling of `knowledge:read` — never the provider's
  full `allowed_scopes` set. Disabled (the default) keeps today's behavior:
  unknown identities are rejected with the styled not-authorized page and the
  RFC 6749 `access_denied` client redirect. The switch governs only unknown
  identities — allowlist entries (`allowed_subjects`/`allowed_emails`) and
  already-registered identities keep working unchanged, allowlist removal
  still revokes access, and operator revocation (`revoked_at`) always wins
  over signup.

## 0.13.1 - 2026-07-23

### Fixed

- Browser GET failures in the OAuth login funnel (denied identity policy,
  unknown/expired/consumed login state, code-exchange errors) now answer
  humans with a "Sign-in failed" page in the shared auth shell instead of a
  raw JSON body; when the waiting OAuth client is known, the page's
  "Sign in again" action carries the RFC 6749 `error=access_denied` redirect
  so MCP connectors never hang. JSON stays the contract for
  token/register/API and `Accept: application/json`.

- Every "Continue with SSO" click now inserts its own login state with its
  own nonce and PKCE verifier instead of rewriting the pending row; earlier
  states stay valid until TTL, keeping the Back button safe.

## 0.13.0 - 2026-07-23

### Added

- Role presets for API keys (no migration): `POST /v1/api-keys` accepts
  `role: reader | contributor | reviewer` as an alternative to explicit
  scopes — three understandable bundles instead of a least-privilege maze.
  Roles expand to scopes at creation time and are never stored; scopes stay
  the only ground truth. Deliberately no `approver` preset:
  `knowledge:approve` remains an explicit, spelled-out grant.

- Cross-space federation (migration `0023_wk_space_refs`): relations can now
  point at concepts in OTHER spaces via qualified `other-space:slug` targets
  — allowed only when the target space is declared in the source space's
  `settings.imports` and the key can see both spaces (space-scoped keys get
  a deterministic 403), and only for targets that already exist as readable
  concepts (no cross-space writes, ever; citations stay strictly
  intra-space). Reads carry provenance (`relations[].space`; foreign targets
  are elided for space-scoped keys), search gains
  `include_imports=true` (fan-out over declared imports, every hit tagged
  with its origin `space` plus `searched_spaces`), briefings qualify
  concepts as `space:slug` and the context selector may add import-declared
  spaces at lower priority. A new `broken-cross-space-links` lint rule
  (warn) flags dangling `[[space:slug]]` markdown links. Knowledge is never
  copied between spaces.

- Richer claim semantics (migrations `0021_wk_claim_semantics` +
  `0022_wk_apply_claim_semantics`): claims can carry explicit temporal validity
  (`valid_from`/`valid_until` — written only when the source states them),
  a `context` partition of the frame (`region:eu`, `v2.x`), server-computed
  normalized objects (typed predicate registry
  `settings.predicate_defs` with explicit unit-conversion factors — no
  built-in ontology) and a staged, reviewer-visible `supersedes_claim_id`.
  The contradiction rule is now interval-, context- and normalization-aware
  everywhere it lives (pre-review matcher, staged-content lint, space lint,
  approval flip): disjoint validity is succession, not contradiction;
  `1 GiB` no longer contradicts `1024 MiB`; different regions coexist.
  Approval executes supersession deterministically (deprecate the target +
  `supersedes` relation; `claims_deprecated` in the result). Subject aliases
  (`settings.aliases`) resolve once at staging — stored claims are always
  canonical. The previously unwired `adjudicate.v1` prompt is now live: the
  pipeline classifies persisted-side frame collisions (capped per job,
  fail-open to the dispute path) — `complementary` verdicts exempt the claim
  from the dispute flip, `temporal` verdicts stage the supersession, and the
  proposal summary reports supersessions separately from contradictions.
  The synthesize prompt is evolved in place (temporal/context extraction,
  typed vocabulary rendering) — golden snapshots carry the reviewed diff.

- Review operations (migration `0020_wk_review_operations`): pending
  proposals can be **split** — fully (one pending child per concept plus one
  for decisions, parent → new terminal status `split`) or partially
  (**defer**: named concepts move to one child while the parent keeps its id
  and remainder) — via `POST /v1/proposals/{id}/split` (`knowledge:review`),
  atomically re-pointing every staged row including relation-removal
  markers. **Request-changes** (`POST /v1/proposals/{id}/request-changes`,
  note mandatory) rejects terminally with a machine-readable
  `changes_requested` flag — agents read the note as the revision brief for
  a fresh proposal. New `GET /v1/proposals/{id}/lint` checks STAGED content
  (uncited claims, frame collisions, stale base, dangling relation targets).
  The proposal wire gains `changes_requested`, `parent_proposal_id`,
  resolved `sources`, per-concept `stale` and full `claims` with citation
  quotes; new webhook events `wikikit.proposal.split` and
  `wikikit.proposal.changes_requested`.
- The human review page grew into a thin knowledge-ops surface: real line
  diffs (dependency-free LCS, CSP unchanged — zero external bytes), claims
  tables with expandable citation quotes and collision highlighting, a
  stale-base banner naming the moved concepts and the re-ingest remedy,
  staged-content lint, resolved sources, per-concept defer buttons and a
  request-changes action. Review-only keys (`knowledge:review`) can inspect,
  defer and request changes; approve/reject stay `knowledge:approve`.

- Versioned source-sync contract for external connectors (migration
  `0019_wk_source_sync`): ingest accepts `external_source_id`,
  `source_version`, `observed_at` and `effective_at`; every external
  document gets a `wk_source_streams` row (mutable head pointer + latest
  version + tombstone) while `wk_sources` stays a fully immutable
  append-only archive with write-once `supersedes_source_id` chains.
  Idempotent re-sync semantics: known content answers
  `200 {status:'unchanged'}` (head advance, no LLM) instead of 409 —
  connectors retry blindly; re-using a version marker for different content
  is a loud `409 sync_version_conflict`; content reverts move the head back
  without new rows. New endpoints `GET /v1/spaces/{space}/source-streams`
  and idempotent `DELETE /v1/spaces/{space}/source-streams/{external_source_id}`
  (tombstone; emits `wikikit.source.tombstoned`, resurrected by a later
  push). Tombstones never touch claims automatically — the new
  `tombstoned-sources` lint rule (warn) surfaces visible claims citing
  upstream-deleted documents for human review. Ingests without an external
  id keep today's semantics byte-for-byte.

- Optional hybrid retrieval (migration `0018_wk_embeddings`): with pgvector
  installed and `WIKIKIT_EMBEDDING_PROVIDER=openai|google` configured
  (Anthropic has no embeddings API), a background embedder fills a
  `wk_embeddings` side table for current revisions, visible claims and
  source chunks, and searches fuse the lexical and cosine arms via
  Reciprocal Rank Fusion (k=60) — deterministic, explainable
  (`matched_via: lexical|vector|both` on every hit), with visibility
  restated in the vector arm so proposed content stays invisible by
  construction. Everything degrades to pure lexical retrieval without
  pgvector, without a provider, or on any embedding failure — search never
  returns 503 because of embeddings. Local/CI Postgres image moves to
  `pgvector/pgvector:pg18` (plain-postgres deployments keep working: all
  vector DDL is guarded).

- Two retrieval tiers (migration `0017_wk_source_chunks`): archived sources
  are now chunked into a persisted, per-source-language retrieval index
  (`wk_source_chunks`, written at archive time and healed for existing
  sources by a background scan worker). Search and `/query` accept
  `mode: approved_only | approved_then_sources` — the default stays
  byte-identical to today; the opt-in mode appends archived source chunks as
  a separate `tier: 'source_evidence'` after every approved hit, never
  interleaved. Query answers (answer prompt evolved in place) must label statements
  grounded only in source evidence as uncurated and cite them as
  `[source:<id>]`; the wire gains `source_citations`. A found chunk feeds
  straight back into curation: proposal citations now accept `{ chunk_id }`,
  resolved server-side to the canonical `{source_id, verbatim quote}`.
  Ingest accepts an optional per-source `language` override.

- Multilingual search (migration `0016_wk_search_multilingual`): the space
  setting `settings.language` (`en` | `de` | `simple`, default `en`) now
  selects the PostgreSQL text search configuration per space — the v0.2
  landing zone named in migration 0001 becoming real. New configurations
  `wk_english`/`wk_german` install `unaccent` as a filtering dictionary, so
  indexing, `websearch` query parsing and headlines are accent-insensitive
  symmetrically; a query-side repair strips the German stopwords that
  survive unaccenting (`für` → `fur` etc.) from parsed queries. `pg_trgm`
  adds a deterministic typo-tolerance arm on concept slugs and titles with
  fixed, documented rank constants. Sources gain a nullable `language`
  column for per-source overrides. Changing a space's language recomputes
  its search vectors via the new whitelisted `wk_reindex_space` function.
  The migration re-vectorizes every existing revision and claim once — on
  large deployments expect the migration to hold locks noticeably longer
  than previous ones.
- German retrieval-quality benchmark: a seeded corpus and 30 golden queries
  with reviewed gating thresholds
  (`test/fixtures/retrieval/{corpus,golden}.de.json`), a CI gate
  (`test/integration/retrieval-eval.test.ts`, RUN_INTEGRATION=1) and a
  verbose tuning table (`bun scripts/retrieval-eval.ts`). Measured effect of
  the multilingual migration on the German set: recall@10 and MRR moved from
  0.467 (english stemming) to 0.967.

## 0.12.2 - 2026-07-23

### Changed

- Remove concrete production-domain and sibling-product references from the
  public documentation and enforce that boundary with a repository guard test.

## 0.12.1 - 2026-07-23

### Fixed

- Express the capture hook's transcript readability guard as an explicit
  conditional so the shipped shell hook passes the same ShellCheck gate used
  by CI.

## 0.12.0 - 2026-07-23

### Added

- Ship the missing UserPromptSubmit example hook (`wikikit-context.sh`) —
  per-prompt space selection via `POST /v1/agent/context`, reading the
  optional `.wikikit/agent.json` manifest — plus PowerShell 5.1 counterparts
  of all three lifecycle hooks (`wikikit-briefing.ps1`, `wikikit-context.ps1`,
  `wikikit-capture.ps1`) so native Windows needs no Git Bash, jq or Node.
- Serve an embedded agent hooks installer from every WikiKit server:
  `GET /install.sh` (strict POSIX, rustup-style, curl→wget fallback) and
  `GET /install.ps1` (PowerShell 5.1, TLS 1.2), with the six hook scripts
  individually downloadable at `GET /install/hooks/{script}`. The installer
  detects Claude Code, Codex and Cursor, merges hook entries without ever
  clobbering existing configuration, is idempotent on re-run, supports
  `--uninstall`, and keeps secrets in `~/.wikikit/env` (chmod 600) instead of
  harness configs.
- Document Cursor as a lifecycle-capable harness (hooks.json `version: 1`,
  `sessionStart`/`beforeSubmitPrompt`/`stop`) alongside Claude Code and Codex
  in the coding-agent integration guide and both LLM documents.

### Changed

- All example hooks source `~/.wikikit/env` (environment variables still win),
  so harness configs stay bare script paths with no inline secrets.
- Make OIDC identity subject-first: `sub` is mandatory, while email is optional
  and used only with `email_verified=true`. Each provider must still explicitly
  allow the exact subject, a verified email, or both.

## 0.11.0 - 2026-07-22

### Changed

- Make API-key and direct OIDC the complete WikiKit-owned MCP authentication
  model. WikiKit owns its OIDC client, callback, policy, sessions and secrets;
  no shared or externally hosted cross-product auth component is supported.
- Keep the family-wide SSO-first UI and public provider-neutral contract while
  implementing and configuring every auth operation inside WikiKit itself.
- Update README, contracts, configuration, OpenAPI and both LLM documents to
  the corrected independent-product architecture.

### Removed

- Remove the hosted assertion-adapter protocol and its POST callback surface.

## 0.10.0 - 2026-07-22

### Added

- Publish the complete common MCP-auth OpenAPI contract, including safe
  provider discovery and provider-neutral assertion exchange at
  `POST /v1/identity/sessions` with the shared
  `{api_key,principal_id,context_id,email}` response.
- Verify OIDC identity assertions through issuer discovery, pinned audience,
  cached remote keys, verified email and WikiKit's explicit identity policy.

### Changed

- Upgrade every WikiKit login and consent page to `mcp-auth-v2`, byte-identical
  shared styles, an opaque `login_state` handoff, and the fixed user actions
  `Continue with SSO` then `Continue with API key`.
- Keep configured provider labels and products out of the UI and public route
  model while preserving WikiKit-owned scopes, spaces, data and deployment.
- Update README, contracts, configuration, OpenAPI and both LLM documents to
  the exact common auth operation and schema contract.

### Removed

- Retain no provider-named routes, response aliases or compatibility parsing.

## 0.9.3 - 2026-07-22

### Changed

- Make all browser-auth examples and historical auth descriptions use only
  provider-neutral protocols, ids and endpoints.
- Extend the architecture contract to reject concrete provider products in
  both the auth runtime and its operator documentation.

## 0.9.2 - 2026-07-22

### Changed

- Replace the remaining provider-specific bootstrap migrations with a
  provider-neutral external-identity baseline and structural provider metadata.
- Extend the architecture contract to scan embedded migration sources so a
  clean installation cannot pass through a retired provider-specific schema.

### Migration

- Existing installations rename the two historical migration journal tags
  once before the binary cutover. The already-neutral production schema and
  all knowledge data remain unchanged; WikiKit backfills only the new hashes.

## 0.9.1 - 2026-07-22

### Added

- Enforce the provider-neutral auth boundary with a repository contract test:
  runtime auth may expose only generic identity routes and protocol
  discriminators, never vendor-named branches, configuration keys or route
  aliases.

## 0.9.0 - 2026-07-22

### Added

- Add proposal-staged relation removals: `relations_removed` on
  `POST /v1/spaces/{space}/proposals` and `wikikit_propose` marks existing
  active relations for removal; the structured diff, markdown rendering and
  the human review page show the pending removals, approval deactivates the
  marked edges atomically (soft delete, audit marker kept), and rejection
  leaves them untouched. Removal-only proposals are valid.
- Add one provider-neutral MCP browser-auth list that can offer one scoped API
  key plus multiple named direct OIDC adapters concurrently;
  provider products are configuration values rather than WikiKit modes.
- Apply verified-email and explicit allow-list policy to direct OIDC adapters
  without adding provider-specific branches.
- Add revocable operator sessions with an eight-hour idle limit, 24-hour
  absolute cap, live identity revalidation, explicit logout and account
  switching.
- Add the shared `mcp-auth-v1` sign-in and consent card with the WikiKit `W`
  badge and an OAuth 2.1 security scheme in OpenAPI.

### Changed

- Replace every provider-specific login route and config branch with
  `/v1/identity/login/start`, `/v1/identity/login/callback`,
  `/v1/identity/logout`, and the `protocol` discriminator. No legacy provider
  shape or route is accepted.

- Bind consent strictly to scopes requested by the client, supported by the
  server and currently permitted for the identity. `knowledge:read` remains
  mandatory and is never silently added to a request that omitted it.
- Allow reviewer credentials to inspect proposal details while keeping the
  irreversible approve/reject boundary on `knowledge:approve`.

### Removed

- Remove the former provider-specific configuration and login endpoints with
  no aliases or compatibility parser. Deployments must supply canonical
  `protocol` records before starting 0.9.0.

### Security

- Persist only opaque session/token hashes, recheck revocation and expiry at
  consent and token use, and keep credentials and identity assertions out of
  rendered pages, logs and history.

## 0.8.0

### Added

- Scope-matched hand-off instructions: the key is the policy. On a client
  without form elicitation, `wikikit_review_proposal` still returns the
  `human_review_required` hand-off with the `review_url`, but a key the
  operator deliberately granted `knowledge:approve` is now instructed that it
  may execute the user's clearly stated approve/reject instruction from the
  conversation over REST, quoting the user's words in the audit note. A
  `knowledge:review` key keeps the strict hands-off journey unchanged. Audits
  record the key name and `review_channel: "rest"`.

## 0.7.0

### Added

- Embedded human review page at `GET /review/{id}` — the one-click
  out-of-band surface for MCP clients without native form elicitation
  (ChatGPT connectors). The public shell is content-free; the proposal diff
  loads in the browser with the reviewer's own `knowledge:approve`
  credential, and approve/reject record `review_channel: "rest"`.
- The `human_review_required` hand-off from `wikikit_review_proposal` now
  carries a ready-to-share `review_url`, and the agent instructions tell the
  agent to hand exactly that link to the user.

## 0.6.0

### Added

- Structured hand-off for MCP clients without native form elicitation:
  `wikikit_review_proposal` now returns
  `outcome: "human_review_required"` with explicit agent instructions instead
  of an error. The proposal stays pending; a human reviews it out-of-band and
  the agent polls `wikikit_proposals` for the result. The hand-off is counted
  as its own content-free usage outcome (`handoff`).
- New scope `knowledge:review` gating `wikikit_proposals` and
  `wikikit_review_proposal`. `knowledge:approve` implies it, so existing keys
  keep working unchanged; the reverse never holds. The REST approve/reject
  endpoints still require `knowledge:approve`, which becomes the
  human-operator credential — agent keys minted with `knowledge:review` can
  never approve over HTTP.
- Documented per-client review journeys (native-form client, non-form client,
  human operator over REST) with the explicitly forbidden moves: collecting
  approve/reject in chat, passing the decision as tool input, and calling the
  REST review endpoints on the human's behalf.

### Changed

- Passing `decision`/`note` to `wikikit_review_proposal` is refused with a
  targeted `approval_requires_human` error before schema validation or any
  database access, replacing the generic strict-schema rejection.
- `elicitation_not_supported` is now a fail-closed backstop for mid-review
  capability loss; its guidance no longer points agents at the REST
  approve/reject endpoints.

## 0.5.0

### Added

- Native MCP form elicitation for ChangeProposal review. The agent supplies
  only the proposal id; the human chooses approve or reject and writes the
  optional review note inside the connected client.
- Durable `review_channel` provenance (`rest` or `mcp_elicitation`) on proposal
  responses, Markdown/OKF audit logs and approved/rejected webhooks.
- Configurable `WIKIKIT_MCP_ELICITATION_TIMEOUT_MS` and content-free outcome
  telemetry for accepted, declined, cancelled, timed-out and unsupported
  review attempts.

### Changed

- `wikikit_review_proposal` now accepts only `{proposal_id}`. MCP POSTs use SSE
  so `elicitation/create` and its response remain associated with the original
  tool call. Clients must reconnect/rescan the changed tool contract.

### Security

- MCP review fails closed when the client lacks form elicitation, returns an
  invalid response, declines, cancels or times out. None of those paths invokes
  the protected SQL review functions, and form contents are excluded from
  logs and usage telemetry.

## 0.4.0

### Added

- Opt-in, append-only, privacy-bounded usage telemetry for HTTP, MCP and the
  semantic knowledge/review workflows. Product-local HMAC actor/session ids
  support exact-window adoption without storing content, prompts, queries,
  tool arguments/results, network identifiers, credentials or dynamic ids.
- New aggregate resources: global `GET /v1/stats/mcp` and space-scoped
  `GET /v1/spaces/{space}/stats/http`, `/stats/usage` and `/stats/reviews`.
  They expose value state/kind, ratio evidence, exact-window uniques,
  latency/size distributions, traffic classes and quality metadata.
- Raw usage retention cleanup plus explicit organic/synthetic/internal
  traffic classification for production canaries and report collectors.

### Security

- Usage collection remains off by default and fails boot when enabled without
  an independent `WIKIKIT_USAGE_HMAC_SECRET`. Anonymous HTTP traffic is never
  fingerprinted and reporting/probe traffic is classified as internal.

## 0.3.2

### Fixed

- Proposal review details now expose every staged decision — including its
  context, decision, rationale and alternatives — consistently through HTTP
  JSON, human-readable Markdown and MCP, so reviewers see all rows an approval
  would activate.

## 0.3.1

### Fixed

- Automatic space routing scores each prompt word once at its strongest match,
  preventing a word and its stem from making one generic description term look
  like multiple independent routing signals.

## 0.3.0

### Added

- Dynamic, task-aware multi-space context selection through the
  `/v1/agent/context` HTTP endpoint and the `wikikit_context` MCP tool, with
  explicit manual space selection available for every project.
- Compact session briefings through `/v1/agent/briefing` and
  `wikikit_briefing`, plus discovery through `/v1/spaces` and
  `wikikit_spaces`.
- Per-space routing settings for stable descriptions, activation hints,
  priorities, and always-on behavior without a fixed primary/secondary
  taxonomy.
- WikiKit now ships immutable, code-versioned system knowledge for agents as
  `wikikit_guide`, `wikikit://system/agent-guide`, and `/agent-guide.md`.
  It includes dynamic multi-space routing and capability-based no-CLI setup
  for MCP clients without seeding tenant data.
- `/.well-known/llms.txt` and `/.well-known/llms-full.txt` mirror the embedded
  discovery documents for zero-configuration agent and connector discovery.

## 0.2.3

### Fixed

- The test suite strips an ambient `JOURNAL_STREAM` via a bun test preload,
  so logger tests no longer fail on systemd-launched or journal-forwarded
  environments (this broke the v0.2.2 release build). No runtime changes
  beyond 0.2.2.

## 0.2.2

### Added

- Log lines carry sd-daemon priority prefixes (`<3>` error, `<4>` warn) when
  running under systemd, so `journalctl -p err` surfaces application errors.
- Ingest jobs that hit provider quota exhaustion are parked in a new
  `quota_blocked` state with a `resume_at` parsed from the provider message
  (fallback +6h) and retried automatically, instead of failing permanently.

### Fixed

- OAuth authorize requests without PKCE parameters are rejected with
  400 `invalid_request` instead of failing with a 500 on the not-null
  constraint of `code_challenge`.
- Grounding drops ("quote not verbatim in source") are logged at info
  instead of warn — they are the validator succeeding, not a problem.

## 0.2.1

### Fixed

- Ingest status documentation now matches the existing no-review-work contract:
  `done` always carries the archived `source_id`, while `proposal_id` is null
  when classification finds no affected or new knowledge. HTTP OpenAPI, MCP
  tool help, README and LLM documentation now describe the same behavior.
- Release artifacts once again match the exact documented source revision and
  self-reported version, replacing the temporary 0.2.0 documentation hotfix.

## 0.2.0

### Added

- Space-scoped `/v1/spaces/{space}/stats/*` product analytics for ingest,
  knowledge growth/review, LLM usage and webhooks. Aggregates are read from
  WikiKit's PostgreSQL database and reuse existing `knowledge:read` keys.
- W3C Trace Context continuation and OpenTelemetry-aligned service,
  deployment, event, trace and span fields in structured runtime logs.

### Changed

- LLM call telemetry now distinguishes successful and failed provider calls;
  ingest and provider telemetry are wired into the production composition
  root instead of existing only as metric helpers.

## 0.1.15

### Changed

- Public documentation now describes the deployed remote-MCP contract
  consistently: product-local API-key and direct OIDC providers,
  the interactive `knowledge:approve` ceiling, and the separate proposal
  inspection/review tools.
- ChatGPT setup documents that an app scans and stores its tool and OAuth-scope
  contract. Recreate or rescan a connector after adding tools or scopes; do
  not silently elevate an existing grant.

### Fixed

- `llms.txt` now correctly identifies `wikikit_decisions` as a
  `knowledge:read` tool; only proposal inspection and final review require
  `knowledge:approve`.

## 0.1.14

### Added

- MCP proposal review is now complete: `wikikit_proposals` exposes the full
  staged diff and `wikikit_review_proposal` performs an explicit, confirmed
  approve/reject decision. Both require `knowledge:approve`.
- Remote MCP OAuth supports standard OIDC Authorization Code + PKCE providers
  and a provider-neutral chooser.
  Identity-provider allow-lists and the read/propose/approve permission ceiling
  are independently configurable.

### Changed

- OAuth does not grant `knowledge:approve` by default; a client must request it
  and the selected identity provider must explicitly allow it.

## 0.1.13

### Fixed

- Allow the already validated OAuth client origin in the consent page's CSP
  `form-action`, so browser-enforced CSP permits the successful authorization
  redirect back to ChatGPT.

## 0.1.12

### Fixed

- OIDC-authenticated MCP consent preserves the original PKCE challenge across
  browser login, allowing the authorization-code exchange to complete.

## 0.1.11

### Changed

- Remote MCP OAuth can use direct OIDC. WikiKit verifies the identity and an
  explicit email allow-list before showing OAuth consent, so ChatGPT need not
  receive a WikiKit operator API key.

### Security

- OIDC login states are opaque, single-use and server-stored. OAuth grants
  remain scoped, refresh rotation remains intact, and an inactive external
  identity immediately invalidates its MCP bearer token.

## 0.1.10

### Added

- OAuth 2.1 authorization for public remote MCP clients such as ChatGPT:
  protected-resource and authorization-server discovery, safe dynamic public
  client registration, authorization code + PKCE S256, consent, scoped bearer
  tokens, rotating refresh tokens and token revocation.
- Hourly OAuth housekeeping for expired authorization artifacts, revoked token
  retention and unused dynamically registered clients.

### Security

- OAuth tokens are HMAC-hashed at rest, bound to the canonical `/mcp`
  resource, and revalidated against the backing WikiKit API key on every
  exchange and MCP request. Refresh-token replay revokes the whole token
  family. OAuth grants cannot obtain human-only approval or admin privileges.

## 0.1.9

### Added

- Durable ingest leases with unique owners, heartbeats and bounded expiry.
  Long-running LLM work now renews its lease, while crashed workers still end
  as auditable `worker_lost` failures.
- Administrative `GET /v1/api-keys` and idempotent
  `DELETE /v1/api-keys/{id}` endpoints. Inventory responses expose usage and
  revocation metadata but never plaintext keys or hashes; space-scoped admins
  remain confined to their own space.

### Changed

- Contradiction detection is cardinality-aware. Only predicates explicitly
  listed in a space's `settings.functional_predicates` are single-valued;
  undeclared predicates are multi-valued and complementary objects stay
  verified. The migration reconciles disputes and synthetic contradiction
  relations produced by the old blanket matcher.
- Lint excludes revisions explicitly marked as structural migration references
  from empty/orphan findings. Isolated Subkit-migrated content pages receive
  deterministic relations to their domain anchor; genuine claim-free pages
  remain visible as hygiene findings.

### Fixed

- Exact concept-slug search now bypasses PostgreSQL web-search hyphen operator
  parsing and receives a stable rank boost. Existing non-null vectors remain
  untouched; legacy null vectors are backfilled.
- The ingest reaper no longer judges liveness from the original `started_at`,
  which previously killed healthy jobs after 15 minutes when concurrency was
  greater than one.

## 0.1.8

**No runtime changes** — the binary is byte-identical to v0.1.7 (verified by
building both and comparing hashes). Upgrading is optional; this release exists
so the work below is in the record.

### Changed

- The two drift suites are now one (`test/unit/drift.test.ts`). They checked
  overlapping things with slightly different scanners, and that split cost
  accuracy rather than merely duplicating effort: the stricter of the two
  env-var scanners forced `WIKIKIT_SKIP_DOTENV` — a test-harness-only
  variable — into the operator documentation, because "a drift test wants it"
  is indistinguishable from "an operator needs it" when there is more than one
  list. Each of the 12 surviving checks was verified to still fail when the
  drift it guards is introduced; the 5 tests that disappeared were duplicates,
  not coverage.
- `docs/ARCHITECTURE.md` now lists every drift gate (the prompt-file and
  provider-key guards were missing) and states that codegen drift stays
  separate in `embedded-drift.test.ts` on purpose.
- `CONTRIBUTING.md` points at the test-tier table instead of restating the
  tiers a second time, 30 lines below it — the copy did not know about e2e.

## 0.1.7

### Added

- **Coding-agent loop for Claude Code and Codex**
  ([docs/coding-agent-integration.md](docs/coding-agent-integration.md)): a
  SessionStart hook injects the space's concept index plus a grounding rule, and
  a SessionEnd/Stop hook captures what the session taught. Ready-to-use hook
  scripts in [`examples/agent-hooks/`](examples/agent-hooks) — no CLI, just curl
  and jq, and every failure path exits silently so a knowledge base being down
  can never break a session.
- **Session distillation** (`POST /v1/spaces/{space}/agent/sessions`): post a
  coding-agent transcript; the server distils **only durable rules a human
  explicitly taught or corrected** and stages them as one ChangeProposal. A
  routine session answers `no_learnings` and writes nothing — capture is a
  filter first, so the review queue stays worth reading. The transcript is
  distilled and dropped, never archived (transcripts carry secrets; sources are
  kept forever). Distilled rules flow through the normal ingest pipeline, so
  they inherit content-hash dedup (re-teaching a rule → `already_captured`, not
  a duplicate), the grounding guard, and contradiction detection against
  existing knowledge.
- **Push gate** (`bun run gate`, `bun run hooks:install`): one command runs
  every check CI runs — lint, typecheck, unit + contract, integration, e2e —
  and installs as a `pre-push` hook, so a red CI run should be a surprise. It
  fails loudly when Docker is missing rather than quietly checking less than
  you think, and prints any `SKIP=` bypass in the summary.
- **E2E tier** (`test/e2e`, `bun run test:e2e`): the real `ai` +
  `@ai-sdk/anthropic` against a stub Anthropic endpoint
  (`config.anthropicBaseUrl`), so the vendor edge is covered — request shape,
  `cache_control` placement, usage mapping, error mapping. Every other tier
  injects `FakeProvider` and is blind to all of it: losing prompt caching
  multiplies the input-token bill while nothing else fails. No key, no network,
  no cost.
- **Benchmarks** (`benchmarks/`, `bun run bench`): deterministic and
  network-free — prompt rendering, the grounding guard's O(claims × source)
  normalization, the markdown pipeline, chunking. It reports and never gates
  (wall-clock assertions are flaky and train people to bypass gates); the cost
  regression that _does_ gate is the new `test/unit/prompt-budget.test.ts`,
  which caps system-prompt tokens — a prompt is billed on every call of its
  kind, forever, and nothing else noticed it growing.
- **MCP self-description**: the server now advertises a `resources` capability
  and returns usage `instructions` on `initialize`. `resources/list` /
  `resources/read` serve `llms.txt` and `llms-full.txt` over MCP, so an
  agent that can only speak MCP can still read the documentation written for it.

### Changed

- `503 llm_not_configured` now names the key of the **selected** provider — an
  `openai` deployment is no longer told to set `ANTHROPIC_API_KEY`.
- The `LlmProvider` interface gains a fourth method, `distill()`.

### Fixed

- Documentation drift across README, CHANGELOG, `docs/CONTRACTS.md` §10,
  `.env.example` and `.env.defaults`, all of which had gone stale since v0.1.3.
  Drift tests now cover them, plus the env templates and the CHANGELOG itself —
  the docs CI checks stayed accurate, the ones it did not check did not.
- `SECURITY.md` described an Anthropic-only LLM boundary and did not mention
  that session capture sends whole transcripts to the model provider.
- Removed `test/evals/`, an empty placeholder referenced by nothing since the
  initial commit.

## 0.1.6

### Added

- **Document upload** (`POST /v1/spaces/{space}/ingest/document`): send a
  `pdf`, `docx`, `xlsx`, `md`, `txt` or `csv` file as the raw request body with
  a `?filename=` query param — the extension selects the extractor. The
  document is extracted to Markdown and enters the same pipeline as any other
  source: archived verbatim, deduped by content hash, synthesized, and staged
  as one pending ChangeProposal.

## 0.1.5

### Changed

- **Verbatim-quote grounding guard**: a synthesized claim is kept only when its
  supporting quote occurs verbatim in the source the model actually read
  (whitespace- and case-normalized). The schema always required a non-empty
  quote but never verified it — a paraphrased or invented quote is an
  unverifiable citation. Ungrounded claims are dropped and logged with a
  `dropped`/`kept` count. Benchmarked at 0 false positives across 43 real
  grounded claims.

## 0.1.4

### Added

- **Multi-provider LLM**: `WIKIKIT_LLM_PROVIDER` selects `anthropic` (default),
  `openai` or `google`, with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or
  `GOOGLE_GENERATIVE_AI_API_KEY` respectively. Switching provider is a config
  value, not a code change; an invalid value fails the boot.

### Changed

- **LLM calls run on the Vercel AI SDK 7** behind the unchanged three-method
  `LlmProvider` interface: classify/synthesize/answer are one
  `generateObject(schema)` call each, constrained to the same Zod objects the
  rest of the system validates with. Transient failures (429/5xx) are retried
  with backoff instead of failing an ingest on the first blip.
- Anthropic prompt caching now measures as intended — the byte-stable system
  prompt rides as a cache-controlled leading text part, so calls after the
  first read the cached prefix.

### Removed

- `@anthropic-ai/sdk` and `src/llm/anthropic.ts`, replaced by `ai` +
  `@ai-sdk/{anthropic,openai,google}`.

## 0.1.3

### Changed

- Documentation presents WikiKit standalone — all references to sibling
  products removed.

## 0.1.2

### Fixed

- `llms.txt` and `llms-full.txt` are embedded at compile time, so the release
  binary serves them instead of 404ing outside a source checkout.

## 0.1.1

### Fixed

- The MCP transport is mounted in `createApp`, fixing a `404` on `POST /mcp` in
  production builds.

## 0.1.0

Initial release: a headless, AI-native knowledge system for humans and agents.

### Added

- **Ingest pipeline** (`POST /v1/spaces/{space}/ingest`, async): sources
  (markdown, text or URL) are archived verbatim with sha256 dedup, classified
  against the concept index, synthesized into concept revisions with claims,
  citations and relations, checked for exact-frame contradictions, and staged
  as one pending ChangeProposal per run.
- **Review gate**: proposal content is staged as real rows, structurally
  invisible to readers; `GET /v1/proposals/{id}` renders a structured diff
  (JSON, or `text/markdown` via Accept); approve/reject are atomic SQL
  functions with stale-base protection, reviewer audit and space-epoch bump.
- **Claims model**: subject/predicate/object statements with confidence,
  verbatim-quote citations and a lifecycle
  (`proposed → verified → disputed → deprecated`); contradicting pairs are
  disputed on approval and linked with a `contradicts` relation.
- **Decisions** as first-class records (context, decision, rationale,
  alternatives), extracted from meeting-style sources.
- **LLM-free query core**: PostgreSQL full-text `search` with `<mark>`
  headlines, and `lint` (contradictions, missing citations, broken relations,
  stale claims, orphans, …) as a CI-consumable report.
- **Grounded Q&A** (`POST /v1/spaces/{space}/query`): answers only from
  retrieved evidence with inline citations, flags disputed claims, and says
  "not in the knowledge base" instead of hallucinating.
- **MCP server** (Streamable HTTP at `/mcp`): scope-gated tool visibility with
  `wikikit_spaces`, `wikikit_briefing`, `wikikit_context`, `wikikit_search`, `wikikit_read`, `wikikit_sources`, `wikikit_decisions`,
  `wikikit_history`, `wikikit_lint`, `wikikit_ingest`, `wikikit_ingest_status`,
  `wikikit_propose` — deliberately no approve tool; session leases with idle
  TTL, hard cap and hijack guards.
- **Export/import**: deterministic zip bundles as an Obsidian-friendly
  Markdown tree (claims round-trip losslessly via frontmatter) or as an OKF
  v0.1 bundle; imports pass the same review gate as LLM output.
- **Standard Webhooks**: signed events (`wikikit.proposal.created`,
  `proposal.approved`, `proposal.rejected`, `concept.updated`,
  `ingest.failed`) from a transactional outbox with backoff and a circuit
  breaker.
- **Auth**: scoped, optionally space-scoped `wk_` API keys hashed with an
  HMAC pepper; scopes `knowledge:read` / `knowledge:propose` /
  `knowledge:approve` / `admin`.
- **Ops**: OpenAPI 3.1 generated live from the route registry
  (`/openapi.json`, with a committed snapshot), `llms.txt`/`llms-full.txt`
  served, Prometheus `/metrics`, `/health` and `/ready` probes, structured
  JSON logs, graceful drain, self-migrating single Bun binary
  (`--migrate`/`--version` ops flags), zero-config local development, and
  drift tests keeping code, spec and docs in lockstep.
