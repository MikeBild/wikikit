# WikiKit — Interface Contracts (v0.1)

**This document is the binding contract between all builder agents.** Where an
implementation and this document disagree, this document wins; if the contract
itself must change, change it here first, then the code. Everything is scoped
per the approved plan (headless, HTTP/REST + MCP only, Postgres source of
truth, Bun single binary).

House conventions (non-negotiable):

- TypeScript strict ESM on Bun. No build step in dev. Factory-function DI:
  `createX(config, deps)` — never classes-with-singletons.
- zod v4 at every boundary (HTTP request/response, MCP tool input, LLM
  structured output). Tables prefixed `wk_`, API keys prefixed `wk_`,
  env vars prefixed `WIKIKIT_*`.
- Every space-scoped SQL query filters by `space_id`. Every state change writes
  an outbox event and/or `wk_agent_runs` entry. No ORM, no web framework.
- Errors are terminal, actionable envelopes (§8) — never bare strings.

---

## 1. Database schema (`src/db/migrations/0000_wk_baseline.sql`)

Postgres ≥ 16. `pgcrypto` for `gen_random_uuid()`. All timestamps
`timestamptz`. All `id` columns are `uuid primary key default gen_random_uuid()`
unless noted. `updated_at` maintained by triggers or explicit UPDATE — builder's
choice, but it must be maintained.

### 1.1 `wk_spaces`

```sql
CREATE TABLE wk_spaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text NOT NULL,
  settings    jsonb NOT NULL DEFAULT '{}',           -- predicates + functional_predicates cardinality contract; language ('en'|'de'|'simple') selects the search configuration
  epoch       bigint NOT NULL DEFAULT 0,             -- bumped on every approved proposal; drives ETag on list endpoints
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

### 1.2 `wk_sources`

```sql
CREATE TABLE wk_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  content_hash  text NOT NULL,                       -- sha256 hex of raw_content — the idempotency anchor
  kind          text NOT NULL CHECK (kind IN ('markdown','text','url','import')),
  url           text,                                -- set when kind='url'
  title         text,
  raw_content   text NOT NULL,                       -- archived verbatim, never mutated
  markdown      text NOT NULL,                       -- normalized markdown projection (identical to raw for kind='markdown')
  metadata      jsonb NOT NULL DEFAULT '{}',
  language      text CHECK (language IS NULL OR language IN ('en','de','simple')),  -- retrieval-index override (0016)
  -- Sync contract (0019): write-once at INSERT, set only by recordStreamVersion.
  stream_id             uuid REFERENCES wk_source_streams(id) ON DELETE SET NULL,
  source_version        text,          -- the version under which this content was FIRST observed
  observed_at           timestamptz,
  effective_at          timestamptz,
  supersedes_source_id  uuid REFERENCES wk_sources(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, content_hash)
);
CREATE INDEX wk_sources_space_created_idx ON wk_sources (space_id, created_at DESC);
```

### 1.2a `wk_source_streams` (connector sync contract)

```sql
-- The MUTABLE identity of one external document (external_source_id, e.g.
-- 'gdrive:file123'). Every pushed version is an immutable wk_sources row;
-- the stream's head pointer carries current truth. A content REVERT moves
-- the head back to the old row (content-hash dedup refuses a duplicate).
-- deleted_at is the tombstone: soft, idempotent, resurrected by a later
-- push. Cited sources stay undeletable (wk_citations RESTRICT) — the
-- 'tombstoned-sources' lint rule surfaces affected visible claims; whether a
-- claim gets deprecated is a human decision through a normal proposal.
CREATE TABLE wk_source_streams (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id            uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  external_source_id  text NOT NULL CHECK (length(external_source_id) BETWEEN 1 AND 500),
  latest_source_id    uuid REFERENCES wk_sources(id),   -- head pointer
  latest_version      text,
  latest_observed_at  timestamptz,
  metadata            jsonb NOT NULL DEFAULT '{}',      -- connector-owned
  deleted_at          timestamptz,                      -- tombstone
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, external_source_id)
);
```

Sync matrix (ingest with `external_source_id`): same id + same version + same
content → `200 {status:'unchanged'}` (head advance, no job, no LLM); same
version + different content → `409 sync_version_conflict` (connector bug,
loud); new version + known content (revert/no-change save) → `200 unchanged`
with the head moved; new version + new content → normal pipeline with the
`supersedes_source_id` chain; known content whose earlier work is still
pending → converge on that proposal instead of 409 (connectors retry
blindly). Ingests WITHOUT `external_source_id` keep the byte-exact 409
semantics. Endpoints: `GET /v1/spaces/{space}/source-streams`
(knowledge:read), `DELETE /v1/spaces/{space}/source-streams/{external_source_id}`
(knowledge:propose, idempotent tombstone).

### 1.3 `wk_concepts`

```sql
CREATE TABLE wk_concepts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id             uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  slug                 text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,126}$'),
  title                text NOT NULL,
  current_revision_id  uuid,                         -- FK added AFTER wk_concept_revisions exists (circular)
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, slug)
);
```

`current_revision_id` is NULL until the first proposal touching the concept is
approved — concepts with only `proposed` revisions are invisible to readers.

### 1.4 `wk_concept_revisions` (immutable)

```sql
CREATE TABLE wk_concept_revisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  concept_id    uuid NOT NULL REFERENCES wk_concepts(id) ON DELETE CASCADE,
  rev           integer NOT NULL,                    -- 1-based, monotonic per concept
  status        text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','current','superseded','rejected')),
  title         text NOT NULL,
  summary       text NOT NULL DEFAULT '',
  markdown      text NOT NULL,
  base_revision_id uuid REFERENCES wk_concept_revisions(id),  -- revision this was synthesized against; NULL for new concepts
  agent_meta    jsonb NOT NULL DEFAULT '{}',         -- shape: §1.14 AgentMeta
  proposal_id   uuid,                                -- FK added after wk_change_proposals exists
  search_vector tsvector,                            -- INSERT-only trigger (rows are immutable)
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (concept_id, rev)
);
ALTER TABLE wk_concepts ADD CONSTRAINT wk_concepts_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES wk_concept_revisions(id);
CREATE INDEX wk_concept_revisions_search_idx ON wk_concept_revisions USING gin (search_vector);
CREATE INDEX wk_concept_revisions_proposal_idx ON wk_concept_revisions (proposal_id);
```

Rows are never UPDATEd except for the `status` flip inside
`wk_apply_proposal`/`wk_reject_proposal`. Content columns are immutable.

### 1.5 `wk_claims`

```sql
CREATE TABLE wk_claims (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id     uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  concept_id   uuid NOT NULL REFERENCES wk_concepts(id) ON DELETE CASCADE,
  subject      text NOT NULL,                        -- concept slug where possible
  predicate    text NOT NULL,                        -- from the space's controlled vocabulary
  object       text NOT NULL,
  status       text NOT NULL DEFAULT 'proposed'
               CHECK (status IN ('proposed','draft','verified','disputed','deprecated')),
  confidence   real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  valid_from   timestamptz,
  valid_until  timestamptz,
  proposal_id  uuid,
  agent_meta   jsonb NOT NULL DEFAULT '{}',
  search_vector tsvector,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wk_claims_frame_idx  ON wk_claims (space_id, subject, predicate);
CREATE INDEX wk_claims_concept_idx ON wk_claims (concept_id, status);
CREATE INDEX wk_claims_search_idx  ON wk_claims USING gin (search_vector);
```

### 1.6 `wk_citations`

```sql
CREATE TABLE wk_citations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id   uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  claim_id   uuid NOT NULL REFERENCES wk_claims(id) ON DELETE CASCADE,
  source_id  uuid NOT NULL REFERENCES wk_sources(id) ON DELETE RESTRICT,
  quote      text NOT NULL,                          -- verbatim excerpt supporting the claim
  locator    text NOT NULL DEFAULT '',               -- e.g. 'heading: Deployment', 'lines 40-52'
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wk_citations_claim_idx ON wk_citations (claim_id);
```

### 1.7 `wk_relations`

```sql
CREATE TABLE wk_relations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id         uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  from_concept_id  uuid NOT NULL REFERENCES wk_concepts(id) ON DELETE CASCADE,
  to_concept_id    uuid NOT NULL REFERENCES wk_concepts(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('related','part_of','depends_on','contradicts','supersedes')),
  status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','removed')),
  proposal_id      uuid,
  -- Pending-removal MARKER (0014): stamped on the still-ACTIVE row by a
  -- proposal's relations_removed staging — never a status flip before
  -- approval, so every reader keeps seeing the edge during review. Approve
  -- flips the marked row to 'removed' (soft delete); reject touches nothing.
  -- The marker is KEPT after either terminal state so the proposal's diff
  -- stays reviewable (single-slot provenance, like proposal_id re-adoption).
  removal_proposal_id uuid REFERENCES wk_change_proposals(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, from_concept_id, to_concept_id, kind)
);
```

#### Federation (0023)

`wk_relations.to_space_id` (nullable, `NULL` = intra-space) lets a relation
point at a concept in another space. Staging accepts qualified
`other-space:slug` targets when (1) the target space is declared in the
source space's `settings.imports` AND (2) the staging principal can see both
spaces (space-scoped keys → 403). The target must already EXIST as a
readable concept — no cross-space writes, ever; citations stay strictly
intra-space (federation links knowledge, never provenance). Reads label the
target space (`relations[].space`), space-scoped keys get foreign targets
elided, `GET /v1/spaces/{space}/search?include_imports=true` fans out over
declared imports with per-hit provenance (`space`, `searched_spaces`), and
the `broken-cross-space-links` lint rule (warn) flags dangling
`[[space:slug]]` markdown links. Briefings label concepts as `space:slug`.

### 1.8 `wk_decisions`

```sql
CREATE TABLE wk_decisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id     uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  slug         text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,126}$'),
  title        text NOT NULL,
  context      text NOT NULL,
  decision     text NOT NULL,
  rationale    text NOT NULL DEFAULT '',
  alternatives jsonb NOT NULL DEFAULT '[]',          -- [{option, reason_rejected}]
  status       text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','superseded')),
  proposal_id  uuid,
  agent_meta   jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, slug)
);
```

### 1.9 `wk_change_proposals`

```sql
CREATE TABLE wk_change_proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id     uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','approved','rejected','failed')),
  title        text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  input_hash   text NOT NULL,                        -- sha256 over ordered source hashes + prompt_version — dedup anchor
  source_ids   uuid[] NOT NULL DEFAULT '{}',
  agent_meta   jsonb NOT NULL DEFAULT '{}',
  reviewer     text,
  review_note  text,
  review_channel text CHECK (review_channel IN ('rest','mcp_elicitation')),
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wk_change_proposals_pending_dedup
  ON wk_change_proposals (space_id, input_hash) WHERE status = 'pending';
```

Proposal _content_ is real rows in the target tables with `status='proposed'` +
`proposal_id` — never a JSON diff blob. Stale-base detection: each proposed
revision carries `base_revision_id`; `wk_apply_proposal` fails if the concept's
`current_revision_id` no longer matches.

Add the deferred FKs once this table exists:

```sql
ALTER TABLE wk_concept_revisions ADD CONSTRAINT wk_concept_revisions_proposal_fk
  FOREIGN KEY (proposal_id) REFERENCES wk_change_proposals(id) ON DELETE SET NULL;
-- same pattern for wk_claims.proposal_id, wk_relations.proposal_id, wk_decisions.proposal_id
```

### 1.10 `wk_api_keys`

```sql
CREATE TABLE wk_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,                 -- hex HMAC-SHA256(pepper, full key string)
  scopes       text[] NOT NULL,                      -- subset of {'knowledge:read','knowledge:propose','knowledge:review','knowledge:approve','admin','*'}
  space_id     uuid REFERENCES wk_spaces(id) ON DELETE CASCADE,  -- NULL = all spaces
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
```

Key format: `wk_<43 chars base64url of 32 random bytes>`. Plaintext is returned
exactly once at creation and never stored. Auth accepts
`Authorization: Bearer <key>` or `X-API-Key: <key>`. 401 = unknown/revoked key;
403 `insufficient_scope` = known key, missing scope or wrong space.

### 1.11 Webhooks (transactional outbox)

```sql
CREATE TABLE wk_outbox_events (
  id            bigserial PRIMARY KEY,
  space_id      uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  event_type    text NOT NULL,                       -- §6 event names
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz                          -- NULL = pending pickup by the delivery worker
);
CREATE INDEX wk_outbox_pending_idx ON wk_outbox_events (id) WHERE dispatched_at IS NULL;

CREATE TABLE wk_webhook_endpoints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id       uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  url            text NOT NULL,
  secret         text NOT NULL,                      -- whsec_-style; used for the v1,<HMAC> signature
  events         text[] NOT NULL DEFAULT '{}',       -- empty = all event types
  active         boolean NOT NULL DEFAULT true,
  failure_count  integer NOT NULL DEFAULT 0,         -- circuit breaker state
  disabled_until timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wk_webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id      uuid NOT NULL REFERENCES wk_webhook_endpoints(id) ON DELETE CASCADE,
  event_id         bigint NOT NULL REFERENCES wk_outbox_events(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','delivering','delivered','failed','dead')),
  attempt          integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  response_status  integer,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wk_webhook_deliveries_due_idx ON wk_webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending','failed');
```

### 1.12 `wk_ingest_jobs`

```sql
CREATE TABLE wk_ingest_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id    uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','quota_blocked')),
  input       jsonb NOT NULL,                        -- validated IngestRequest, verbatim
  source_id   uuid REFERENCES wk_sources(id),
  proposal_id uuid REFERENCES wk_change_proposals(id),
  error       jsonb,                                 -- {code, message} on failure
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  heartbeat_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX wk_ingest_jobs_queue_idx ON wk_ingest_jobs (created_at) WHERE status = 'queued';
```

### 1.13 `wk_agent_runs` (LLM audit ledger — written for EVERY LLM call)

```sql
CREATE TABLE wk_agent_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id       uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('classify','synthesize','answer','distill','adjudicate')),
  model          text NOT NULL,
  prompt_version text NOT NULL,                      -- §3.4 constants, e.g. 'synthesize.v1'
  input_hash     text NOT NULL,                      -- sha256 of the fully rendered prompt input
  usage          jsonb NOT NULL DEFAULT '{}',        -- {input_tokens, output_tokens, cache_read_input_tokens?}
  duration_ms    integer NOT NULL DEFAULT 0,
  ingest_job_id  uuid REFERENCES wk_ingest_jobs(id) ON DELETE SET NULL,
  proposal_id    uuid REFERENCES wk_change_proposals(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wk_agent_runs_space_idx ON wk_agent_runs (space_id, created_at DESC);
```

### 1.14 `agent_meta` jsonb shape (revisions, claims, decisions, proposals)

```json
{
  "model": "claude-sonnet-5",
  "prompt_version": "synthesize.v1",
  "input_hash": "<sha256 hex>",
  "usage": { "input_tokens": 0, "output_tokens": 0 },
  "source_ids": ["<uuid>", "..."]
}
```

Manual (human/agent-authored via `POST .../proposals`) rows use
`{"model": "manual", "prompt_version": "manual", ...}`.

### 1.15 SQL functions (the ONLY write path for review decisions)

Callable exclusively through the RPC whitelist in `src/db/postgres.ts` (§2.1).

```sql
-- Atomic approve. Analog of ck_activate_release.
-- 1. SELECT ... FOR UPDATE the proposal row (serializes concurrent reviews)
--    and each affected wk_concepts row.
-- 2. Stale-base check: for every proposed revision, concept.current_revision_id
--    must equal revision.base_revision_id → else RAISE 'stale_base'.
-- 3. Flip: old current revisions → 'superseded'; proposed → 'current';
--    concepts.current_revision_id repointed; claims proposed → 'verified';
--    collisions on settings.functional_predicates → both 'disputed' + ensure
--    a 'contradicts' relation; undeclared predicates remain multi-valued;
--    relations/decisions proposed → 'active'; relations MARKED for removal
--    (removal_proposal_id = this proposal, still 'active') → 'removed'
--    (soft delete, marker kept for audit; a stolen marker or an already-
--    removed edge matches nothing — the returned count is the signal).
--    The concept-lock set includes the endpoints of marked relations.
-- 4. Proposal → 'approved' (reviewer, note, review_channel, reviewed_at); space epoch += 1;
--    outbox events 'wikikit.proposal.approved' + 'wikikit.concept.updated' per concept.
-- Errors: 'proposal_not_found', 'proposal_not_pending', 'stale_base'.
CREATE FUNCTION wk_apply_proposal(
  p_proposal_id uuid,
  p_reviewer text,
  p_note text DEFAULT NULL,
  p_review_channel text DEFAULT 'rest'
)
RETURNS jsonb;  -- {proposal_id, status:'approved', review_channel, concepts:[slug,...], claims_verified:int, claims_disputed:int, claims_deprecated:int, relations_removed:int}

-- Atomic reject. Proposed rows KEEP their rows (audit) but flip:
-- revisions → 'rejected', claims stay 'proposed' pinned to the rejected proposal
-- (invisible everywhere: readers filter on verified/disputed/deprecated),
-- relations → 'removed', decisions stay 'proposed'. Relations MARKED for
-- removal are untouched by construction (the flip is guarded status='proposed'):
-- they stay ACTIVE and keep the marker, so the rejected diff remains readable.
-- Proposal → 'rejected'; outbox 'wikikit.proposal.rejected'.
CREATE FUNCTION wk_reject_proposal(
  p_proposal_id uuid,
  p_reviewer text,
  p_note text DEFAULT NULL,
  p_review_channel text DEFAULT 'rest'
)
RETURNS jsonb;  -- {proposal_id, status:'rejected', review_channel}

-- FTS over current revisions + visible claims. Proposed content is invisible
-- BY CONSTRUCTION: the revision join goes through wk_concepts.current_revision_id.
-- p_kind: NULL | 'concept' | 'claim'.
-- The text search configuration is per space: wk_spaces.settings.language
-- ('en' | 'de' | 'simple', default 'en') selects wk_english / wk_german /
-- simple — both built with unaccent as a filtering dictionary, so indexing,
-- query parsing and headlines are accent-insensitive symmetrically. A
-- pg_trgm fallback matches typo'd concept slugs (similarity >= 0.45) and
-- titles (word_similarity >= 0.6) with fixed rank contributions (5.0 * slug
-- similarity, 3.0 * title word-similarity) below the exact-slug boost (10.0).
CREATE FUNCTION wk_search(p_space_id uuid, p_query text, p_kind text DEFAULT NULL, p_limit int DEFAULT 20)
RETURNS TABLE (kind text, concept_slug text, claim_id uuid, title text, headline text, rank real);

-- Recomputes one space's derived search vectors (revisions + claims +
-- source chunks) under its CURRENT settings.language. Idempotent. Called by
-- the settings handler whenever the effective language changes; also a
-- manual repair tool.
CREATE FUNCTION wk_reindex_space(p_space_id uuid)
RETURNS jsonb;  -- {space_id, revisions:int, claims:int, chunks:int}

-- Ranked FTS over archived source chunks (wk_source_chunks) — the
-- 'source_evidence' retrieval tier. Everything archived is searchable here
-- BY DESIGN: the tier surfaces not-yet-curated material and is composed in
-- TypeScript strictly AFTER approved hits, only when the caller passes
-- mode=approved_then_sources. Never merged with wk_search: ts_rank values
-- across corpora are not comparable; the tier separation IS the
-- explainability story. Chunks are heading-aligned derived rows written at
-- archive time (chunkForRetrieval), healed by the backfill scan worker, and
-- rebuilt by wk_reindex_space; chunk vectors resolve per SOURCE
-- (wk_sources.language overrides the space default).
CREATE FUNCTION wk_search_sources(p_space_id uuid, p_query text, p_limit int DEFAULT 20)
RETURNS TABLE (source_id uuid, chunk_id uuid, chunk_index int, title text, url text, heading text, headline text, rank real);

-- OPTIONAL hybrid variants (exist only when pgvector is installed —
-- migration 0018 guards all vector DDL). Lexical + cosine arms fused by
-- Reciprocal Rank Fusion (k=60) over rank positions; rank = the RRF score,
-- matched_via ∈ lexical|vector|both. Visibility joins are restated in the
-- vector arm, so proposed content stays invisible by construction there too.
-- TypeScript calls these only after the startup pgvector probe AND with a
-- configured embedding provider (WIKIKIT_EMBEDDING_PROVIDER); any embedding
-- failure falls back to the lexical functions — retrieval never 503s.
CREATE FUNCTION wk_search_hybrid(p_space_id uuid, p_query text, p_embedding text, p_kind text DEFAULT NULL, p_limit int DEFAULT 20)
RETURNS TABLE (kind text, concept_slug text, claim_id uuid, title text, headline text, rank real, matched_via text);

CREATE FUNCTION wk_search_sources_hybrid(p_space_id uuid, p_query text, p_embedding text, p_limit int DEFAULT 20)
RETURNS TABLE (source_id uuid, chunk_id uuid, chunk_index int, title text, url text, heading text, headline text, rank real, matched_via text);

-- Review operations (0020). Split moves staged rows (revisions, claims —
-- citations ride on claim_id —, proposed relations, 0014 removal markers,
-- decisions) to child proposals by re-pointing proposal_id, atomically with
-- the parent flip and the outbox event. Full split (p_concepts NULL): one
-- pending child per staged concept plus one for decisions/leftover markers;
-- parent → terminal status 'split'. Subset = DEFER: named concepts move to
-- ONE child, the parent stays pending with a re-salted input_hash (a fresh
-- full re-ingest stages a NEW complete proposal instead of converging on the
-- partial one). Child input_hash = sha256(parent_hash + ':' + slug) —
-- deterministic, never trips the pending-dedup index.
-- Errors: proposal_not_found, proposal_not_pending, unknown_split_slug,
-- split_nothing_left, invalid_review_channel.
CREATE FUNCTION wk_split_proposal(p_proposal_id uuid, p_reviewer text, p_concepts text[] DEFAULT NULL, p_review_channel text DEFAULT 'rest')
RETURNS jsonb;  -- {parent:{id,status}, children:[{proposal_id, concepts}]}

-- Terminal reject + machine-readable changes_requested flag; the note is
-- MANDATORY (error 'note_required') — it is the agent's revision brief for a
-- fresh proposal. Rewrites the just-emitted rejected outbox event to
-- wikikit.proposal.changes_requested in the same transaction. Deliberately
-- NOT a fifth non-terminal proposal state: WikiKit has no rebase, so acting
-- on feedback IS a new proposal.
CREATE FUNCTION wk_request_changes(p_proposal_id uuid, p_reviewer text, p_note text, p_review_channel text DEFAULT 'rest')
RETURNS jsonb;  -- reject result || {changes_requested: true}
```

---

## 2. Database access layer (`src/db/postgres.ts`, `src/db/migrate.ts`)

### 2.1 `Db` interface — everything downstream codes against this

```ts
export interface Db {
  /** Parameterized query. Table names referenced must be in the wk_ allowlist. */
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>
  /** Run fn inside a transaction; the passed Db is transaction-bound. Nested tx = savepoint or error, builder's choice — document it. */
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  /** Whitelisted SQL function call. ONLY the WhitelistedFn names below. Anything else throws. */
  call<R = Record<string, unknown>>(fn: WhitelistedFn, args: unknown[]): Promise<R[]>
  /** Insert an outbox event inside the CURRENT transaction (must be called on a tx-bound Db for atomicity). */
  emitEvent(spaceId: string, eventType: WebhookEventType, payload: Record<string, unknown>): Promise<void>
}
// Role presets (POST /v1/api-keys accepts role XOR scopes; expansion happens
// at creation, scopes stay the only stored truth — no role is ever persisted
// and requireScope never sees one):
//   reader      → knowledge:read
//   contributor → knowledge:read, knowledge:propose
//   reviewer    → knowledge:read, knowledge:propose, knowledge:review
// Deliberately NO 'approver' preset: knowledge:approve is the human gate and
// must be granted as an explicit, spelled-out scope. A future org model
// (principals/groups keyed off the provider-neutral identities, per-space
// grants) would move role evaluation into requireScope — possible precisely
// because scopes remain the ground truth today.

export type WhitelistedFn =
  | 'wk_apply_proposal'
  | 'wk_reject_proposal'
  | 'wk_search'
  | 'wk_search_sources'
  | 'wk_search_hybrid'
  | 'wk_search_sources_hybrid'
  | 'wk_reindex_space'
  | 'wk_split_proposal'
  | 'wk_request_changes'

export interface Database {
  db: Db
  close(): Promise<void>
}
export function createPostgres(config: Config): Database
```

### 2.2 Migrations

```ts
// src/db/migrate.ts
export interface MigrationReport {
  applied: string[]
  skipped: number
}
export function runMigrations(config: Config, logger: Logger): Promise<MigrationReport>
```

- SQL files `src/db/migrations/NNNN_name.sql` + `meta/_journal.json`
  (`{ "entries": [{ "idx": 0, "tag": "0000_wk_baseline" }, ...] }`).
- `scripts/gen-embedded-migrations.ts` generates `src/db/migrations/embedded.ts`
  exporting `EMBEDDED_MIGRATIONS: { tag: string; sql: string }[]` (committed;
  drift-tested against the .sql files).
- Boot self-migrates under PG advisory lock `pg_advisory_lock(hashtext('wikikit_migrations'))`.
- Applied migrations recorded in `wk_migrations (tag text primary key, applied_at timestamptz)`.

---

## 3. LLM provider (`src/llm/provider.ts`, `src/llm/aisdk.ts`, `src/llm/fake.ts`)

### 3.1 Interface — exactly four methods

```ts
export interface LlmUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
}
export interface LlmRunMeta {
  model: string
  prompt_version: string
  input_hash: string // sha256 hex of the canonical serialized input
  usage: LlmUsage
  duration_ms: number
}
export interface LlmResult<T> {
  output: T
  run: LlmRunMeta
}

export interface LlmProvider {
  /** False when the selected provider's key is unset — callers answer 503 llm_not_configured. FakeProvider: true. */
  readonly configured: boolean
  /** Env var holding the selected provider's key — the 503 names it. */
  readonly apiKeyEnv: string
  /** Which existing concepts a source affects + which new concepts it warrants. Model: config.modelClassify. */
  classify(input: ClassifyInput): Promise<LlmResult<ClassifyOutput>>
  /** One call per affected concept: new revision + claims + relations. Model: config.modelSynthesis. */
  synthesize(input: SynthesizeInput): Promise<LlmResult<SynthesizeOutput>>
  /** Grounded Q&A over retrieved evidence with inline citations. Model: config.modelAnswer. */
  answer(input: AnswerInput): Promise<LlmResult<AnswerOutput>>
  /** Session transcript → the durable rules a human taught. Empty is the expected result. Model: config.modelClassify. */
  distill(input: DistillInput): Promise<LlmResult<DistillOutput>>
}

export function createLlmProvider(config: Config, deps?: { logger?: Logger }): LlmProvider
```

Implemented on the Vercel AI SDK (`ai` + `@ai-sdk/anthropic`/`@ai-sdk/openai`/
`@ai-sdk/google`) — provider is config-selected (`WIKIKIT_LLM_PROVIDER`).
Structured output via `generateObject(schema)`; errors map to the typed set
(`content-filter` → refusal, `length`/`NoObjectGeneratedError` → invalid).
Anthropic prompt caching: the byte-stable system prompt is sent as a
`cache_control` leading user text part (AI SDK 7 forbids system messages in the
array), so every later call reads the cached prefix. `ANTHROPIC_BASE_URL`
honored for the anthropic provider (test stub). Every call the caller persists
to `wk_agent_runs`, including fresh + cache-read token usage.

### 3.2 Input/output types (zod schemas live in `src/llm/schemas.ts`)

```ts
export interface ConceptIndexEntry {
  slug: string
  title: string
  summary: string
}
export interface ClassifyInput {
  source: { title: string | null; markdown: string }
  conceptIndex: ConceptIndexEntry[]
}
export interface ClassifyOutput {
  affected: string[]
  new: { slug: string; title: string }[]
} // slugs

export interface SynthesizeInput {
  concept: { slug: string; title: string; currentMarkdown: string | null } // null = new concept
  source: { id: string; title: string | null; markdown: string }
  predicates: string[] // space vocabulary
  sourceKind?: 'meeting' | 'article' | 'note' // 'meeting' turns on decision mining
}
export interface SynthesizeOutput {
  title: string
  summary: string
  markdown: string
  claims: { subject: string; predicate: string; object: string; quote: string; confidence: number }[]
  relations: { to_slug: string; kind: 'related' | 'part_of' | 'depends_on' | 'contradicts' | 'supersedes' }[]
  // Explicit decisions the source records (meeting sources); each → a proposed
  // wk_decisions row (zCreateProposalArgs.decisions shape).
  decisions: {
    slug: string
    title: string
    context: string
    decision: string
    rationale: string
    alternatives: string[]
  }[]
}

export interface AnswerEvidence {
  kind: 'concept' | 'claim'
  slug: string | null
  text: string
  status: string | null
}
export interface AnswerInput {
  question: string
  evidence: AnswerEvidence[]
}
export interface AnswerOutput {
  answer_markdown: string
  cited_slugs: string[]
  not_in_knowledge_base: boolean
}
export interface DistillInput {
  transcript: string // a coding-agent session, tail-capped by the caller
}
export interface DistillOutput {
  // Empty is the EXPECTED result: most sessions teach nothing durable.
  // `quote` is verbatim from the transcript — the evidence a reviewer checks.
  learnings: { title: string; rule: string; quote: string }[]
}
```

Zod schemas: `zClassifyOutput`, `zSynthesizeOutput`, `zAnswerOutput`,
`zDistillOutput` — the provider parses model responses through these and throws
`LlmOutputInvalidError` on failure (no silent partials).

### 3.3 FakeProvider (`src/llm/fake.ts`)

```ts
export interface FakeCall {
  method: 'classify' | 'synthesize' | 'answer' | 'distill'
  input: unknown
}
export interface FakeProvider extends LlmProvider {
  readonly calls: FakeCall[] // recorded in order — assertion surface for tests
}
export function createFakeProvider(overrides?: {
  classify?: (input: ClassifyInput) => ClassifyOutput
  synthesize?: (input: SynthesizeInput) => SynthesizeOutput
  answer?: (input: AnswerInput) => AnswerOutput
  distill?: (input: DistillInput) => DistillOutput
}): FakeProvider
```

Defaults (deterministic, no network): `classify` → affects nothing, proposes one
new concept derived from the source title; `synthesize` → echoes source
markdown, one claim `{subject: concept.slug, predicate: 'is', object: 'described', quote: first line, confidence: 0.9}`;
`answer` → `not_in_knowledge_base: true` for empty evidence, else concatenates
evidence; `distill` → no learnings (the routine-session case, so "nothing is
staged" is the behavior a test gets for free). `run` meta uses `model: 'fake'`,
real prompt_version constants, zero usage.

### 3.4 Prompt version constants (`src/llm/prompts/index.ts`)

```ts
export const PROMPT_VERSIONS = {
  classify: 'classify.v1',
  synthesize: 'synthesize.v1',
  answer: 'answer.v1',
  distill: 'distill.v1', // coding-agent session transcript → durable rules
  adjudicate: 'adjudicate.v1', // optional Haiku contradiction adjudication (cuttable)
} as const
```

Prompt files: `src/llm/prompts/{classify,synthesize,answer,distill,adjudicate}.v1.ts` exporting
`system: string` and `render(input): string`. Any prompt text change requires a
new version constant (prompt regression = product regression; goldens in
`test/unit/`).

---

## 4. Domain module signatures (`src/domain/*.ts`)

Transport-agnostic; consumed identically by REST and MCP. Convention: **every
exported function takes `(db: Db, spaceId: string, args)`** — spaceId always
explicit, never ambient. Exceptions (global-by-id lookups) are marked ⚠ and
must still verify space visibility internally where a key is space-scoped.
Functions throw typed errors (§8.2); transports map them to envelopes.

```ts
// src/domain/spaces.ts  (spaceId-less by nature)
export function createSpace(
  db: Db,
  args: { slug: string; name: string; settings?: Record<string, unknown> },
): Promise<Space>
export function getSpaceBySlug(db: Db, slug: string): Promise<Space> // throws NotFoundError

// src/domain/sources.ts
export function listSources(
  db: Db,
  spaceId: string,
  args: { limit?: number; before?: string },
): Promise<{ items: SourceSummary[]; next_before: string | null }>
export function getSource(db: Db, spaceId: string, args: { id: string }): Promise<Source>
export function createSource(
  db: Db,
  spaceId: string,
  args: {
    kind: 'markdown' | 'text' | 'url' | 'import'
    url?: string
    title?: string
    raw: string
    markdown: string
  },
): Promise<{ source: Source; created: boolean }> // created=false on hash hit (idempotent) → HTTP layer answers 409 already_ingested

// src/domain/concepts.ts
export function listConcepts(
  db: Db,
  spaceId: string,
  args: { limit?: number; after?: string },
): Promise<{ items: ConceptSummary[]; next_after: string | null; epoch: number }>
export function getConcept(db: Db, spaceId: string, args: { slug: string }): Promise<ConceptDetail> // markdown + claims + citations + relations + rev
export function getConceptHistory(db: Db, spaceId: string, args: { slug: string }): Promise<RevisionSummary[]> // incl. agent_meta
export function getConceptIndex(db: Db, spaceId: string): Promise<ConceptIndexEntry[]> // compact index for classify

// src/domain/claims.ts
export function listClaimsForConcept(
  db: Db,
  spaceId: string,
  args: { conceptId: string; statuses?: ClaimStatus[] },
): Promise<ClaimWithCitations[]>
export function findContradictions(
  db: Db,
  spaceId: string,
  args: { claims: ClaimTriple[] },
): Promise<ContradictionPair[]> // deterministic exact-frame matcher

// src/domain/relations.ts
export function listRelations(db: Db, spaceId: string, args: { conceptId: string }): Promise<Relation[]>

// src/domain/decisions.ts
export function listDecisions(db: Db, spaceId: string, args: { limit?: number }): Promise<DecisionSummary[]>
export function getDecision(db: Db, spaceId: string, args: { slug: string }): Promise<Decision>

// src/domain/proposals.ts
export function listProposals(
  db: Db,
  spaceId: string,
  args: { status?: ProposalStatus; limit?: number },
): Promise<ProposalSummary[]>
export function getProposal(db: Db, args: { id: string }): Promise<ProposalDetail> // ⚠ global id; returns space_id — transport enforces key/space match
export function createProposal(
  db: Db,
  spaceId: string,
  args: CreateProposalArgs,
): Promise<{ proposal_id: string; status: 'pending' }>
export type ReviewChannel = 'rest' | 'mcp_elicitation'
export function approveProposal(
  db: Db,
  args: { id: string; reviewer: string; note?: string; reviewChannel?: ReviewChannel },
): Promise<ApplyResult> // ⚠ wraps db.call('wk_apply_proposal')
export function rejectProposal(
  db: Db,
  args: { id: string; reviewer: string; note?: string; reviewChannel?: ReviewChannel },
): Promise<RejectResult> // ⚠ wraps db.call('wk_reject_proposal')

// CreateProposalArgs — the staging write used by ingest, import, and manual POST .../proposals.
// Inserts proposal + proposed revisions/claims/citations/relations/decisions + outbox event in ONE db.tx.
export interface CreateProposalArgs {
  title: string
  summary?: string
  input_hash: string
  source_ids: string[]
  agent_meta: Record<string, unknown>
  concepts: {
    slug: string
    title: string
    summary: string
    markdown: string
    // Stale-base anchor override: the revision this content was SYNTHESIZED
    // against. null = explicitly "new concept"; absent = fall back to the
    // concept's current pointer at staging time (manual proposals). The
    // ingest pipeline passes the id it read BEFORE its LLM calls so a
    // concurrent approval inside the synthesis window fails stale_base.
    base_revision_id?: string | null
    claims: {
      subject: string
      predicate: string
      object: string
      confidence: number
      citations: { source_id: string; quote: string; locator?: string }[]
    }[]
    relations: { to_slug: string; kind: RelationKind }[]
  }[]
  decisions?: {
    slug: string
    title: string
    context: string
    decision: string
    rationale?: string
    alternatives?: unknown[]
  }[]
  // Removals of EXISTING active relations — top-level (edge-level, not
  // per-concept), so a removal-only proposal needs no fake revision. Staging
  // stamps removal_proposal_id on the still-active row (400 if the edge is
  // not an active relation; endpoints are locked, never auto-created).
  // Approval flips the marked rows to 'removed' atomically; rejection leaves
  // them active. The same edge cannot be both added and removed in one
  // proposal (boundary refine); across proposals, staging an ADD of an edge
  // whose removal is pending is likewise a 400 (the add would stage nothing
  // and could not restore the edge if the removal were approved first).
  // Dedup: for proposals carrying relations_removed the effective
  // (space_id, input_hash) dedup key is sha256(input_hash + canonical
  // removal set) — identical retries converge, different removal sets with
  // the same documented sourceless hash stage as distinct proposals.
  relations_removed?: { from_slug: string; to_slug: string; kind: RelationKind }[]
}

// src/domain/lint.ts  (LLM-free, pure SQL)
export function lintSpace(db: Db, spaceId: string): Promise<LintReport>
export interface LintFinding {
  rule:
    | 'contradictions'
    | 'missing-citations'
    | 'broken-relations'
    | 'stale-claims'
    | 'orphan-concepts'
    | 'empty-concepts'
    | 'unreviewed-proposals'
    | 'dangling-sources'
    | 'tombstoned-sources'
  severity: 'error' | 'warn' | 'info'
  message: string
  concept_slug?: string
  claim_id?: string
  details?: Record<string, unknown>
}
export interface LintReport {
  findings: LintFinding[]
  counts: { error: number; warn: number; info: number }
}
```

Severity mapping is fixed: `contradictions`/`missing-citations`/`broken-relations`
= error; `stale-claims`/`orphan-concepts`/`tombstoned-sources` = warn; the rest
= info. `tombstoned-sources` flags visible claims citing sources whose stream
the connector tombstoned (upstream document deleted) — surfacing only, never an
automatic status flip: whether the claim gets deprecated is a human decision
made through a normal proposal.

### 4.1 Ingest pipeline (`src/ingest/pipeline.ts`)

```ts
export interface IngestPipeline {
  /** Insert a queued wk_ingest_jobs row and return its id (fast, no LLM). Sync
   *  inputs (external_source_id) may short-circuit to {status:'unchanged',
   *  source_id, stream_id} when the content is already archived — connectors
   *  retry blindly, so known content is a head-pointer advance, never a 409. */
  enqueue(db: Db, spaceId: string, args: IngestRequest): Promise<{ ingest_id: string } | IngestUnchanged>
  /** Worker loop: claim queued jobs (FOR UPDATE SKIP LOCKED), run acquire→archive→dedup→classify→synthesize→detect→propose. */
  start(): void
  stop(): Promise<void>
}
export function createIngestPipeline(config: Config, db: Db, llm: LlmProvider, logger: Logger): IngestPipeline
```

Dedup: content-hash hit on an existing source → job finishes `failed` with
`{code: 'already_ingested', message, source_id}` when invoked sync-style, and
the HTTP 409 path applies when the hash is checked at enqueue time (enqueue MUST
pre-check the hash for markdown/text bodies so the 409 is synchronous;
URL acquisition defers the check to the worker). A hash hit only conflicts
while the archived source is still doing work — a pending/approved proposal
references it, or a queued/running/done/quota_blocked job produced it. Otherwise (the
previous job FAILED after archiving) the re-submit proceeds and the worker
reuses the archived source row: re-submitting identical content is the §9.1
recovery path and must not dead-end on its own archive.

### 4.2 Query & search (`src/query/`)

```ts
// src/query/search.ts — LLM-free
export function search(
  db: Db,
  spaceId: string,
  args: { q: string; kind?: 'concept' | 'claim'; limit?: number },
): Promise<SearchHit[]>
export interface SearchHit {
  kind: 'concept' | 'claim'
  slug: string | null
  claim_id: string | null
  title: string
  headline: string
  rank: number
}

// src/query/answer.ts — LLM (answer.v1); throws LlmNotConfiguredError without a key
export function answerQuestion(
  db: Db,
  spaceId: string,
  llm: LlmProvider,
  args: { question: string; top_k?: number },
): Promise<QueryAnswer>
export interface QueryAnswer {
  answer_markdown: string // inline [slug] citations; disputed claims flagged explicitly
  citations: { slug: string; title: string }[]
  not_in_knowledge_base: boolean // true → answer says so, no hallucinated content
  agent_run_id: string
}
```

### 4.3 Export / import (`src/export/`)

```ts
export type BundleFormat = 'md' | 'okf'
// Streams a zip; concept claims round-trip losslessly via frontmatter.
export function exportSpace(
  db: Db,
  spaceId: string,
  args: { format: BundleFormat },
): Promise<ReadableStream<Uint8Array>>
// Parses an uploaded bundle → sources directly + ONE ChangeProposal (review gate).
export function importBundle(
  db: Db,
  spaceId: string,
  args: { data: Uint8Array; format: BundleFormat },
): Promise<{ proposal_id: string; sources_created: number }>
```

All OKF knowledge is isolated in `src/export/okf.ts` behind the format switch;
the vendored spec lives at `docs/okf-v0.1.md`; every manifest carries
`okf_version: "0.1"` + a generator stamp.

---

## 5. HTTP surface

### 5.1 `ROUTES` registry entry shape (`src/http/routes.ts`)

Single source of truth — handlers, OpenAPI, drift tests and llms.txt all derive
from this array.

```ts
export type Scope = 'knowledge:read' | 'knowledge:propose' | 'knowledge:review' | 'knowledge:approve' | 'admin'

export interface RouteDef {
  method: 'get' | 'post'
  path: string // OpenAPI template style: '/v1/spaces/{space}/concepts/{slug}'
  scope: Scope | null // null = public (health/docs endpoints)
  summary: string
  handler: string // exported handler function name — drift-tested against the router
  request?: {
    params?: string // zod schema NAME exported from src/http/schemas.ts
    query?: string
    body?: string //   "" — names, not schema objects, so OpenAPI gen + drift tests can introspect
  }
  responses: Record<number, { schema?: string; type: string; desc: string }>
}
export const ROUTES: RouteDef[]
export function buildOpenApi(routes: RouteDef[], opts: { version: string }): OpenApiDocument // src/http/openapi.ts
```

### 5.2 Complete route table (v1 — binding)

| Method | Path                                          | Scope                              | Handler                        | Request schema(s)                                         | 2xx Response schema                                                                      |
| ------ | --------------------------------------------- | ---------------------------------- | ------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/v1/spaces`                                  | knowledge:read                     | `listSpacesHandler`            | —                                                         | 200 `zSpaceListResponse`                                                                 |
| POST   | `/v1/spaces`                                  | admin                              | `createSpaceHandler`           | body `zCreateSpaceRequest`                                | 201 `zSpaceResponse`                                                                     |
| GET    | `/v1/agent/briefing`                          | knowledge:read                     | `agentBriefingHandler`         | query `zAgentBriefingQuery`                               | 200 `zAgentBriefingResponse`                                                             |
| POST   | `/v1/agent/context`                           | knowledge:read                     | `agentContextHandler`          | body `zAgentContextRequest`                               | 200 `zAgentContextResponse`                                                              |
| GET    | `/v1/spaces/{space}`                          | knowledge:read                     | `getSpaceHandler`              | params `zSpaceParams`                                     | 200 `zSpaceResponse`                                                                     |
| POST   | `/v1/spaces/{space}/settings`                 | admin                              | `updateSpaceSettingsHandler`   | params `zSpaceParams`; body `zUpdateSpaceSettingsRequest` | 200 `zSpaceResponse`                                                                     |
| POST   | `/v1/spaces/{space}/ingest`                   | knowledge:propose                  | `createIngestHandler`          | body `zIngestRequest`                                     | 202 `zIngestAcceptedResponse` + `Location: /v1/ingests/{id}`                             |
| POST   | `/v1/spaces/{space}/ingest/document`          | knowledge:propose                  | `ingestDocumentHandler`        | query `zIngestDocumentQuery`, raw body                    | 202 `zIngestAcceptedResponse` (415 unsupported_document, 422 document_extraction_failed) |
| POST   | `/v1/spaces/{space}/agent/sessions`           | knowledge:propose                  | `captureSessionHandler`        | body `zCaptureSessionRequest`                             | 200 `zCaptureSessionResponse` (503 llm_not_configured)                                   |
| GET    | `/v1/ingests/{id}`                            | knowledge:propose                  | `getIngestHandler`             | params `zIdParams`                                        | 200 `zIngestStatusResponse`                                                              |
| GET    | `/v1/spaces/{space}/sources`                  | knowledge:read                     | `listSourcesHandler`           | query `zListQuery`                                        | 200 `zSourceListResponse`                                                                |
| GET    | `/v1/spaces/{space}/sources/{id}`             | knowledge:read                     | `getSourceHandler`             | params `zSpaceIdParams`                                   | 200 `zSourceResponse`                                                                    |
| GET    | `/v1/spaces/{space}/decisions`                | knowledge:read                     | `listDecisionsHandler`         | query `zListQuery`                                        | 200 `zDecisionListResponse`                                                              |
| GET    | `/v1/spaces/{space}/decisions/{slug}`         | knowledge:read                     | `getDecisionHandler`           | params `zDecisionParams`                                  | 200 `zDecisionResponse`                                                                  |
| GET    | `/v1/spaces/{space}/concepts`                 | knowledge:read                     | `listConceptsHandler`          | query `zListQuery`                                        | 200 `zConceptListResponse` (ETag = `"<space-epoch>"`, 304 on If-None-Match)              |
| GET    | `/v1/spaces/{space}/concepts/{slug}`          | knowledge:read                     | `getConceptHandler`            | params `zConceptParams`                                   | 200 `zConceptResponse`                                                                   |
| GET    | `/v1/spaces/{space}/concepts/{slug}/history`  | knowledge:read                     | `getConceptHistoryHandler`     | params `zConceptParams`                                   | 200 `zConceptHistoryResponse`                                                            |
| GET    | `/v1/spaces/{space}/search`                   | knowledge:read                     | `searchHandler`                | query `zSearchQuery`                                      | 200 `zSearchResponse`                                                                    |
| POST   | `/v1/spaces/{space}/query`                    | knowledge:read                     | `queryHandler`                 | body `zQueryRequest`                                      | 200 `zQueryResponse` (503 `llm_not_configured` without key)                              |
| GET    | `/v1/spaces/{space}/proposals`                | knowledge:read \| knowledge:review | `listProposalsHandler`         | query `zProposalListQuery`                                | 200 `zProposalListResponse`                                                              |
| POST   | `/v1/spaces/{space}/proposals`                | knowledge:propose                  | `createProposalHandler`        | body `zCreateProposalRequest`                             | 201 `zProposalCreatedResponse`                                                           |
| GET    | `/v1/proposals/{id}`                          | knowledge:read \| knowledge:review | `getProposalHandler`           | params `zIdParams`                                        | 200 `zProposalDetailResponse` (or `text/markdown` via Accept)                            |
| POST   | `/v1/proposals/{id}/approve`                  | knowledge:approve                  | `approveProposalHandler`       | body `zReviewRequest`                                     | 200 `zProposalReviewResponse`                                                            |
| POST   | `/v1/proposals/{id}/reject`                   | knowledge:approve                  | `rejectProposalHandler`        | body `zReviewRequest`                                     | 200 `zProposalReviewResponse`                                                            |
| GET    | `/v1/spaces/{space}/lint`                     | knowledge:read                     | `lintHandler`                  | params `zSpaceParams`                                     | 200 `zLintResponse`                                                                      |
| GET    | `/v1/spaces/{space}/export`                   | knowledge:read                     | `exportHandler`                | query `zExportQuery`                                      | 200 `application/zip` stream                                                             |
| POST   | `/v1/spaces/{space}/import`                   | knowledge:propose                  | `importHandler`                | body: zip (`application/zip`) or MD tree                  | 202 `zProposalCreatedResponse`                                                           |
| GET    | `/v1/spaces/{space}/webhooks`                 | admin                              | `listWebhooksHandler`          | params `zSpaceParams`                                     | 200 `zWebhookListResponse`                                                               |
| POST   | `/v1/spaces/{space}/webhooks`                 | admin                              | `createWebhookHandler`         | body `zCreateWebhookRequest`                              | 201 `zWebhookResponse` (secret shown once)                                               |
| GET    | `/v1/spaces/{space}/webhooks/{id}/deliveries` | admin                              | `listWebhookDeliveriesHandler` | params `zSpaceIdParams`                                   | 200 `zDeliveryListResponse`                                                              |
| GET    | `/v1/api-keys`                                | admin                              | `listApiKeysHandler`           | —                                                         | 200 `zApiKeyListResponse` (never plaintext/hash)                                         |
| POST   | `/v1/api-keys`                                | admin                              | `createApiKeyHandler`          | body `zCreateApiKeyRequest`                               | 201 `zApiKeyCreatedResponse` (plaintext key shown once)                                  |
| DELETE | `/v1/api-keys/{id}`                           | admin                              | `revokeApiKeyHandler`          | params `zIdParams`                                        | 200 `zApiKeyRevokedResponse` (idempotent)                                                |
| GET    | `/v1/stats/mcp`                               | admin                              | `mcpUsageStatsHandler`         | query `zUsageStatsQuery`                                  | 200 `zUsageStatsResponse`                                                                |
| GET    | `/v1/spaces/{space}/stats/http`               | knowledge:read                     | `httpUsageStatsHandler`        | params `zSpaceParams`; query `zUsageStatsQuery`           | 200 `zUsageStatsResponse`                                                                |
| GET    | `/v1/spaces/{space}/stats/usage`              | knowledge:read                     | `knowledgeUsageStatsHandler`   | params `zSpaceParams`; query `zUsageStatsQuery`           | 200 `zUsageStatsResponse`                                                                |
| GET    | `/v1/spaces/{space}/stats/coverage`           | knowledge:read                     | `coverageStatsHandler`         | params `zSpaceParams`; query `zCoverageStatsQuery`        | 200 `zCoverageStatsResponse`                                                             |
| GET    | `/v1/spaces/{space}/stats/reviews`            | knowledge:read                     | `reviewUsageStatsHandler`      | params `zSpaceParams`; query `zUsageStatsQuery`           | 200 `zUsageStatsResponse`                                                                |
| GET    | `/v1/spaces/{space}/stats/ingests`            | knowledge:read                     | `ingestStatsHandler`           | params `zSpaceParams`; query `zStatsQuery`                | 200 `zIngestStatsResponse`                                                               |
| GET    | `/v1/spaces/{space}/stats/knowledge`          | knowledge:read                     | `knowledgeStatsHandler`        | params `zSpaceParams`; query `zStatsQuery`                | 200 `zKnowledgeStatsResponse`                                                            |
| GET    | `/v1/spaces/{space}/stats/llm`                | knowledge:read                     | `llmStatsHandler`              | params `zSpaceParams`; query `zStatsQuery`                | 200 `zLlmStatsResponse`                                                                  |
| GET    | `/v1/spaces/{space}/stats/webhooks`           | knowledge:read                     | `webhookStatsHandler`          | params `zSpaceParams`; query `zStatsQuery`                | 200 `zWebhookStatsResponse`                                                              |
| GET    | `/health`                                     | —                                  | `healthHandler`                | —                                                         | 200 `text/plain` `"ok"`                                                                  |
| GET    | `/ready`                                      | —                                  | `readyHandler`                 | —                                                         | 200 `zReadyResponse` `{status:'ready', version}`; 503 while draining/not migrated        |
| GET    | `/metrics`                                    | —                                  | `metricsHandler`               | —                                                         | 200 Prometheus text                                                                      |
| GET    | `/openapi.json`                               | —                                  | `openapiHandler`               | —                                                         | 200 OpenAPI 3.1 from `buildOpenApi(ROUTES)`                                              |
| GET    | `/review/{id}`                                | —                                  | `reviewPageHandler`            | params `zIdParams`                                        | 200 `text/html`                                                                          |
| GET    | `/agent-guide.md`                             | —                                  | `agentGuideHandler`            | —                                                         | 200 `text/markdown`                                                                      |
| GET    | `/llms.txt`                                   | —                                  | `llmsTxtHandler`               | —                                                         | 200 `text/plain`                                                                         |
| GET    | `/llms-full.txt`                              | —                                  | `llmsFullTxtHandler`           | —                                                         | 200 `text/plain`                                                                         |
| GET    | `/.well-known/llms.txt`                       | —                                  | `llmsTxtHandler`               | —                                                         | 200 `text/plain`                                                                         |
| GET    | `/.well-known/llms-full.txt`                  | —                                  | `llmsFullTxtHandler`           | —                                                         | 200 `text/plain`                                                                         |
| GET    | `/install.sh`                                 | —                                  | `installShHandler`             | —                                                         | 200 `text/plain` (agent hooks installer, base URL pre-resolved)                          |
| GET    | `/install.ps1`                                | —                                  | `installPs1Handler`            | —                                                         | 200 `text/plain` (agent hooks installer, base URL pre-resolved)                          |
| GET    | `/install/hooks/{script}`                     | —                                  | `installHookScriptHandler`     | params `zInstallHookScriptParams`                         | 200 `text/plain` (closed enum of the six hook scripts)                                   |

`POST /mcp` (plus `GET`/`DELETE /mcp` for SSE/session-close per Streamable
HTTP) is intentionally **outside** the ROUTES registry and the OpenAPI surface;
it shares the auth middleware.

Usage telemetry contract:

- Collection is disabled unless `WIKIKIT_USAGE_TELEMETRY_ENABLED=true` and
  `WIKIKIT_USAGE_HMAC_SECRET` is present. Raw events expire after
  `WIKIKIT_USAGE_RETENTION_DAYS`.
- The append-only `wk_usage_events` row may contain controlled surface,
  operation, route template, tool name, method/status/outcome, traffic/source,
  duration/size/count/capacity and product-local HMAC actor/session fields.
  It MUST NOT contain content, prompts, queries/questions, MCP arguments or
  results, raw paths/query strings, IP/UA, e-mail, credentials, space slugs or
  dynamic ids. Anonymous HTTP MUST have null actor/session fields.
- `wikikit.usage-stats.v1` supports only UTC bounded windows,
  organic/synthetic/internal/all traffic and no more than two allow-listed
  dimensions. Totals MUST be queried across the exact full window; bucket
  uniques/percentiles MUST NOT be summed. Ratio metrics carry numerator and
  denominator; value state distinguishes zero from missing; `sampled=false`.
- Outcome `no_answer` marks a `/query` call the knowledge base answered
  honestly with "not covered" (HTTP 200; recorded on the knowledge-surface
  row only, transport rows keep status semantics). `no_answer` /
  `no_answer_ratio` in usage stats are the demand-vs-coverage signal: demand
  the curated base does not yet cover.
- Actor/session HMAC scope is WikiKit-local. Collectors and Cockpit MUST NOT
  cross-join identities with another product.

Notes binding all builders:

- The `{space}` path segment is the space **slug**; handlers resolve it once
  via `getSpaceBySlug` and pass `space.id` down as `spaceId`.
- A space-scoped key (`wk_api_keys.space_id` set) may only touch that space →
  otherwise 403 `insufficient_scope`. `'*'` and `admin` scopes imply all
  knowledge scopes; `admin` does not imply `'*'`. `knowledge:approve` implies
  `knowledge:review` (the inspect/start-review subset); the reverse never
  holds — `knowledge:approve` stays the human-operator credential for the
  REST approve/reject endpoints. A scope cell with `|` is any-of: proposal
  inspection lives on both the read and the review surface, so the reviewer
  key the human review page asks for (`knowledge:approve`, implying
  `knowledge:review`) can load the diff it decides on without also holding
  `knowledge:read`.
- Request IDs: 12-hex `x-request-id` response header on every response; the
  same id appears in the error envelope and logs.
- Pagination is keyset: `?limit=&after=` (opaque cursor), response carries
  `next_after: string | null`.

### 5.3 HTTP zod schema module (`src/http/schemas.ts`) — layout contract

One module exporting **all** named request/response schemas referenced in §5.2
plus `zErrorEnvelope`. Names are exactly the strings in the route table
(`zIngestRequest`, `zConceptResponse`, ...). Key shapes:

```ts
export const zIngestRequest = z
  .object({
    markdown: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    url: z.string().url().optional(),
    title: z.string().max(500).optional(),
    source_kind: z.enum(['meeting', 'article', 'note']).optional(), // steers synthesis; 'meeting' → decision mining
  })
  .refine((v) => [v.markdown, v.text, v.url].filter(Boolean).length === 1, {
    message: 'exactly one of markdown|text|url is required',
  })

export const zIngestAcceptedResponse = z.object({ ingest_id: z.string().uuid(), status: z.literal('queued') })
export const zIngestStatusResponse = z.object({
  ingest_id: z.string().uuid(),
  status: z.enum(['queued', 'running', 'done', 'failed', 'quota_blocked']),
  proposal_id: z.string().uuid().nullable(),
  source_id: z.string().uuid().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
})

export const zQueryRequest = z.object({
  question: z.string().min(1).max(2000),
  top_k: z.number().int().min(1).max(50).default(8),
})
export const zReviewRequest = z.object({ note: z.string().max(2000).optional() }).default({})
export const zCreateApiKeyRequest = z.object({
  name: z.string().min(1).max(200),
  scopes: z
    .array(z.enum(['knowledge:read', 'knowledge:propose', 'knowledge:review', 'knowledge:approve', 'admin']))
    .min(1),
  space: z.string().optional(), // space slug; omitted = all spaces
})
```

`zConceptResponse` (the full read used by REST **and** `wikikit_read`):

```ts
export const zConceptResponse = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  markdown: z.string(),
  rev: z.number().int(),
  updated_at: z.string(),
  claims: z.array(
    z.object({
      id: z.string().uuid(),
      subject: z.string(),
      predicate: z.string(),
      object: z.string(),
      status: z.enum(['verified', 'disputed', 'deprecated']),
      confidence: z.number(),
      citations: z.array(z.object({ source_id: z.string().uuid(), quote: z.string(), locator: z.string() })),
    }),
  ),
  relations: z.array(
    z.object({ to_slug: z.string(), kind: z.enum(['related', 'part_of', 'depends_on', 'contradicts', 'supersedes']) }),
  ),
  agent_meta: z.record(z.string(), z.unknown()),
})
```

`zProposalDetailResponse` — the structured diff:

```ts
export const zProposalDetailResponse = z.object({
  id: z.string().uuid(),
  space: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'failed']),
  title: z.string(),
  summary: z.string(),
  created_at: z.string(),
  reviewer: z.string().nullable(),
  review_note: z.string().nullable(),
  review_channel: z.enum(['rest', 'mcp_elicitation']).nullable(),
  reviewed_at: z.string().nullable(),
  source_ids: z.array(z.string().uuid()),
  agent_meta: z.record(z.string(), z.unknown()),
  concepts: z.array(
    z.object({
      slug: z.string(),
      is_new: z.boolean(),
      old_markdown: z.string().nullable(),
      new_markdown: z.string(),
      claims_added: z.array(zClaimTriple),
      claims_disputed: z.array(zClaimTriple),
      claims_deprecated: z.array(zClaimTriple),
      relations_added: z.array(z.object({ to_slug: z.string(), kind: z.string() })),
    }),
  ),
  decisions: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      context: z.string(),
      decision: z.string(),
      rationale: z.string(),
      alternatives: z.array(z.unknown()),
    }),
  ),
  // Edge-level removals staged by this proposal (top-level: removal-only
  // proposals carry no concept entries). Present for terminal proposals too —
  // the removal marker survives approve and reject.
  relations_removed: z.array(z.object({ from_slug: z.string(), to_slug: z.string(), kind: z.string() })),
})
```

The approved branch of `zProposalReviewResponse` carries the apply counts,
including `relations_removed: z.number().int()` (Flip 6b row count).

### 5.4 Auth (`src/http/auth.ts`)

```ts
export interface Principal {
  keyId: string
  scopes: string[]
  spaceId: string | null
  name: string
}
export interface Auth {
  authenticate(headerValue: string | undefined): Promise<Principal> // throws UnauthorizedError
  requireScope(principal: Principal, scope: Scope, spaceId?: string): void // throws ForbiddenError('insufficient_scope')
  createKey(args: { name: string; scopes: string[]; spaceId?: string | null }): Promise<{ id: string; key: string }>
}
export function createAuth(config: Config, db: Db): Auth
```

Hash: `hex(hmacSHA256(config.keyPepper, fullKeyString))` compared via
constant-time equality. Bootstrap: in dev, when no admin key exists at boot,
generate one with scopes `['*']`, print **once** to stdout.

---

## 5.5 Session capture (`src/agent/sessions.ts`)

```ts
export const zCaptureSessionArgs: z.ZodType<{ transcript: string; title?: string }>
export interface CaptureResult {
  status: 'no_learnings' | 'queued' | 'already_captured'
  ingest_id: string | null
  learnings: number
  agent_run_id: string // always present — the distill call is always audited
}
export function captureSession(
  db: Db,
  spaceId: string,
  deps: { llm: LlmProvider; ingest: IngestPipeline },
  args: CaptureSessionArgs,
): Promise<CaptureResult>
export function capTranscript(transcript: string): string // keeps the TAIL over 200k chars
export function renderLearnings(learnings: DistillOutput['learnings']): string
```

Binding behavior:

- **Distillation is a FILTER, and runs first.** No learnings → no source, no
  proposal, no synthesis cost: a routine session costs one cheap call and
  writes only its `wk_agent_runs` row (`kind: 'distill'`). This is what keeps
  the review queue worth reading; a capture path that always produces something
  trains the operator to stop reviewing.
- **The transcript is distilled and DROPPED, never archived.** Sources are kept
  verbatim and forever; a transcript carries pasted secrets and scratch
  thinking, so only the distilled rules are persisted — after human approval.
  (The provider still sees the transcript — see `SECURITY.md`.)
- **Everything after distillation reuses the ingest pipeline.** `renderLearnings`
  output is enqueued as a normal `source_kind: 'note'` source, so capture
  inherits content-hash dedup, the verbatim-quote grounding guard,
  contradiction detection and the one-proposal review gate. It is `'note'`, not
  `'meeting'`: conventions are not decision records.
- **`renderLearnings` is deterministic** (no timestamps, no ids). Re-teaching a
  rule renders identical markdown → the same content hash → `already_captured`,
  never a duplicate proposal. A hook that fires after every session depends on
  this being a success rather than a 409.
- No API key → `LlmNotConfiguredError` (503) before any write.

---

## 6. Webhooks (Standard Webhooks)

### 6.1 Event names (the `event_type` column and the payload `type` field)

```
wikikit.proposal.created
wikikit.proposal.approved
wikikit.proposal.rejected
wikikit.concept.updated
wikikit.ingest.failed
wikikit.source.tombstoned
wikikit.proposal.split
wikikit.proposal.changes_requested
```

### 6.2 Delivery envelope

HTTP POST, `content-type: application/json`, Standard Webhooks headers:

```
webhook-id:        <wk_outbox_events.id as string, prefixed 'evt_'>
webhook-timestamp: <unix seconds>
webhook-signature: v1,<base64(hmacSHA256(secret, `${id}.${timestamp}.${body}`))>
```

Body (`zWebhookEnvelope`):

```json
{ "type": "wikikit.proposal.created", "timestamp": "<ISO 8601>", "data": { ... } }
```

### 6.3 Payload `data` schemas (`zWebhookPayloads` in `src/http/schemas.ts`)

| Event                                | `data` shape                                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wikikit.proposal.created`           | `{ proposal_id, space, title, source_ids: string[], concepts: string[] /* slugs */, claims_count: number, contradictions_count: number, relations_removed_count: number }` |
| `wikikit.proposal.approved`          | `{ proposal_id, space, reviewer, note: string \| null, review_channel: 'rest' \| 'mcp_elicitation', concepts: string[] }`                                                  |
| `wikikit.proposal.rejected`          | `{ proposal_id, space, reviewer, note: string \| null, review_channel: 'rest' \| 'mcp_elicitation' }`                                                                      |
| `wikikit.concept.updated`            | `{ space, slug, rev: number, proposal_id }`                                                                                                                                |
| `wikikit.ingest.failed`              | `{ ingest_id, space, error: { code, message } }`                                                                                                                           |
| `wikikit.source.tombstoned`          | `{ space, external_source_id, stream_id, source_id: string \| null }`                                                                                                      |
| `wikikit.proposal.split`             | `{ space, parent_id, parent_status: 'split' \| 'pending', children: [{ proposal_id, concepts: string[] }], reviewer }`                                                     |
| `wikikit.proposal.changes_requested` | rejected shape `\|\| { changes_requested: true }`                                                                                                                          |

Delivery worker: poll `wk_outbox_events` where `dispatched_at IS NULL`, fan out
one `wk_webhook_deliveries` row per matching active endpoint, exponential
backoff (`min(2^attempt, 300)s` + jitter) up to `webhookMaxAttempts`, then
`dead`. Circuit breaker: `webhookCircuitThreshold` consecutive failures →
endpoint `disabled_until = now() + 15min`.

---

## 7. MCP server (`src/mcp/`)

Streamable HTTP at `/mcp`, `@modelcontextprotocol/sdk` ^1.29. MCP POST
responses use the event-stream transport so the server can issue a native
`elicitation/create` request while a review tool call is in flight. One SDK `Server`
per session; handlers close over the `Principal`. Sessions are leases:
idle TTL sweep (`mcpSessionTtlMs`), hard cap (`mcpMaxSessions`) with
oldest-idle eviction, in-flight retain counter; session owner =
`keyId:principal` — a different key on a known session id → 404; unknown
session → JSON-RPC `-32001`. Origin-header validation; `mcp-protocol-version`
checked against SDK `SUPPORTED_PROTOCOL_VERSIONS`. Tool input schemas are the
SAME zod objects as REST (via `toJsonSchemaCompat` → draft-07 with
`additionalProperties: false`).

**Scope-gating = tool visibility**: `tools/list` returns only tools whose scope
the key holds. `knowledge:review` (implied by `knowledge:approve`) exposes
proposal inspection and the destructive, non-idempotent review tool; the REST
approve/reject endpoints still demand `knowledge:approve`, so an agent key
minted with `knowledge:review` can start the MCP review (where the human owns
the decision) but cannot approve over HTTP. The tool input contains only the
proposal id; agent-supplied `decision`/`note` input is refused with
`approval_requires_human` before schema validation. WikiKit requests the
decision and optional note from the human in a native MCP form. The agent
cannot provide or infer the decision. A client that does not advertise
`capabilities.elicitation.form` receives a non-error hand-off
`{ proposal_id, status:'pending', outcome:'human_review_required',
review_url, mutation_applied:false, poll_with:'wikikit_proposals',
agent_instructions }` — `review_url` is the public `/review/{id}` page where
the human decides with their own credential, and `agent_instructions` are
scope-matched: strict hands-off for `knowledge:review` keys, while
`knowledge:approve` (the operator's opt-in) permits executing the human's
explicit chat instruction over REST — and the proposal stays pending
for an out-of-band human review
(`elicitation_not_supported` remains the fail-closed backstop if the
capability disappears mid-flight). Decline, cancel, timeout, invalid data and
transport failure leave the proposal pending. Errors use the §8 envelope
serialized into the tool result (`isError: true`), never bare strings.

### 7.0 OAuth 2.1 for remote MCP clients

Unauthenticated `/mcp` responses advertise the protected resource through
`WWW-Authenticate` and `/.well-known/oauth-protected-resource` (including the
path-qualified variant). The challenge names the complete knowledge scope set
from `scopes_supported` (read/propose/review/approve, never the
`offline_access` mechanics scope); consent still clamps grants to the
identity's ceiling. The canonical `WIKIKIT_PUBLIC_URL` is the issuer and
the exact resource audience `${WIKIKIT_PUBLIC_URL}/mcp`. The authorization
server metadata is at `/.well-known/oauth-authorization-server`.

Remote public clients dynamically register at `POST /v1/oauth/register` (RFC
7591): at most five safe HTTPS or loopback redirect URIs, no client secret,
and a bounded per-source-address rate. Authorization is code-only, requires
PKCE `S256`, exact redirect URI and resource matching, and uses a short-lived
one-time code. `WIKIKIT_OAUTH_PROVIDERS` is the only browser-provider
configuration and may contain one `api_key` plus multiple directly configured
`oidc` adapters concurrently. Product names are never protocol branches.
A provider-neutral `302` from authorize leads to
`/v1/identity/login/start?login_state=<opaque>`. The `mcp-auth-v2` chooser
always presents `Continue with SSO` before `Continue with API key`; product
branding, scopes, policy and data stay WikiKit-owned. Provider labels cannot
change these actions.
Each `Continue with SSO` click mints its own login state (own nonce and PKCE
verifier); a pending state row is never rewritten, and earlier states stay
valid until their TTL so the browser Back button cannot poison an in-flight
IdP round trip. Browser `GET` failures in this funnel — denied identity
policy, unknown/expired/consumed login state, code-exchange errors — render a
`Sign-in failed` HTML page in the same shared shell; when the waiting OAuth
client's `redirect_uri` is validated and known, the page's `Sign in again`
action carries the RFC 6749 `error=access_denied` redirect back to the client
so MCP connectors never hang. The JSON `{error,error_description}` envelope
remains for non-browser endpoints and for `Accept: application/json`.
WikiKit performs OIDC discovery and Authorization Code + PKCE itself. The
immutable `sub` is mandatory; access requires an exact subject allow-list
match or a provider-verified email allow-list match. Unverified email claims
are ignored. With `WIKIKIT_OAUTH_ENABLE_SIGNUP=true` (default `false`) an
unknown OIDC identity is instead auto-admitted at the SSO callback: it is
registered in `wk_oauth_identities` with its own per-identity ceiling of
`knowledge:read` only — never the provider's `allowed_scopes` set. The switch
governs only unknown identities; allow-lists, already-registered identities
and operator revocation keep today's semantics. Its OIDC client,
secret, callback registration, sessions and identity records belong only to
this deployment; no shared cross-product authentication runtime exists.

The consent form has CSRF protection and persists only the minimum provider
identity, never an API key or an ID token. Interactive OAuth identities can
receive only `knowledge:read`, `knowledge:propose`, `knowledge:review`,
`knowledge:approve` and `offline_access`: every requested knowledge scope must
be within the global or per-provider allowed-scope ceiling, and
`knowledge:approve` is never granted by default. `admin` is never issued through an interactive OAuth identity.
Clients retain their issued scope set; adding an MCP tool or scope requires a
fresh connector scan/reconnect rather than silently elevating an old grant.
The displayed and issued grant is always client request ∩ server support ∩
current identity ceiling. `knowledge:read` is mandatory and a request that
explicitly omits it is denied rather than expanded. Every login method creates
the same revocable operator session with an eight-hour idle limit and 24-hour
absolute cap; authorize render and decision revalidate expiry, revocation and
current identity policy. The common `W` card exposes explicit logout/account
switching without combining WikiKit identities with another product.

The common non-browser boundary is `GET /v1/identity/providers` and
`POST /v1/identity/sessions`. Discovery returns configured methods in SSO-first
order with canonical labels. Assertion exchange accepts exactly
`{provider_id,identity_token}` and returns exactly
`{api_key,principal_id,context_id,email}`; WikiKit uses `context_id:null` and
keeps space authorization in the issued key. No provider-specific route or
legacy request/response alias exists.

`POST /v1/oauth/token` issues one-hour bearer tokens and, when
`offline_access` is granted, rotating 30-day refresh tokens. A refresh-token
replay revokes its entire token family. `POST /v1/oauth/revoke` is idempotent;
revoking a refresh token revokes its family. Every exchange and MCP bearer
authentication rechecks the source API key or interactive identity's current
revocation state. Raw secrets, external identity assertions,
authorization codes, access tokens and refresh tokens are never stored; only
keyed HMAC hashes and the minimal identity record are retained. Expired
artifacts and unused DCR clients are removed by the hourly housekeeping sweep.

**Self-description (binding)**: capabilities are `{ tools, resources }`, and
`initialize` returns `instructions` describing the read/write/review split and
the native human-form decision rule. WikiKit's immutable, code-bundled system
scope is available through the `wikikit_guide` tool and
`wikikit://system/agent-guide`. `resources/list` also exposes
`wikikit://docs/llms.txt` and `wikikit://docs/llms-full.txt`; all are read via
`resources/read` and served from the same embedded copies as the public HTTP
docs (`readDocsFile`). Resources are NOT scope-gated. Rationale: a pure-MCP client cannot
issue a plain GET, so without this the docs are unreachable for exactly the
audience they are written for.

### 7.1 Tool table (binding — names, schemas, outputs, scopes, all four annotations)

| Tool                      | Scope             | Input schema (zod, in `src/mcp/tools.ts`)                                                                                            | Output (JSON in content)                                                                                                                                                                                                                                                                                                            | readOnly | destructive | idempotent | openWorld |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ---------- | --------- |
| `wikikit_guide`           | knowledge:read    | `{}`                                                                                                                                 | `{ scope, resource_uri, public_path, version, markdown }`                                                                                                                                                                                                                                                                           | `true`   | `false`     | `true`     | `false`   |
| `wikikit_spaces`          | knowledge:read    | `{}`                                                                                                                                 | `{ spaces: { id, slug, name, description }[] }`                                                                                                                                                                                                                                                                                     | `true`   | `false`     | `true`     | `false`   |
| `wikikit_briefing`        | knowledge:read    | `{ spaces: string[] (1-10), budget_tokens?: number (500-4000) }`                                                                     | `{ markdown, spaces, budget_tokens, used_tokens, concepts_included, concepts_omitted }`                                                                                                                                                                                                                                             | `true`   | `false`     | `true`     | `false`   |
| `wikikit_context`         | knowledge:read    | `{ prompt, project_hint?, primary_space?, manual_spaces?, exclude_spaces?, max_spaces?, budget_tokens? }`                            | compact briefing plus selection mode and scored space matches                                                                                                                                                                                                                                                                       | `true`   | `false`     | `true`     | `false`   |
| `wikikit_search`          | knowledge:read    | `{ space: string, q: string, kind?: 'concept'\|'claim', limit?: number (1-50, default 20) }`                                         | `{ hits: SearchHit[] }` (§4.2)                                                                                                                                                                                                                                                                                                      | `true`   | `false`     | `true`     | `false`   |
| `wikikit_read`            | knowledge:read    | `{ space: string, slug: string }`                                                                                                    | `zConceptResponse` shape (§5.3)                                                                                                                                                                                                                                                                                                     | `true`   | `false`     | `true`     | `false`   |
| `wikikit_sources`         | knowledge:read    | `{ space: string, slug?: string, source_id?: string }` (exactly one of slug/source_id)                                               | `{ sources: { id, kind, url, title, content_hash, created_at, cited_by_claims: number }[] }`                                                                                                                                                                                                                                        | `true`   | `false`     | `true`     | `false`   |
| `wikikit_decisions`       | knowledge:read    | `{ space: string, slug?: string }` (omit slug → list)                                                                                | slug → one decision; else `{ decisions: { slug, title, status, created_at }[] }`                                                                                                                                                                                                                                                    | `true`   | `false`     | `true`     | `false`   |
| `wikikit_history`         | knowledge:read    | `{ space: string, slug: string }`                                                                                                    | `{ revisions: { rev, status, created_at, agent_meta }[] }`                                                                                                                                                                                                                                                                          | `true`   | `false`     | `true`     | `false`   |
| `wikikit_lint`            | knowledge:read    | `{ space: string }`                                                                                                                  | `LintReport` (§4)                                                                                                                                                                                                                                                                                                                   | `true`   | `false`     | `true`     | `false`   |
| `wikikit_ingest`          | knowledge:propose | `zIngestRequest` + `{ space: string }`                                                                                               | `{ status: 'running', ingest_id, poll_with: 'wikikit_ingest_status' }` (async ack — never blocks)                                                                                                                                                                                                                                   | `false`  | `true`      | `true`     | `true`    |
| `wikikit_ingest_status`   | knowledge:propose | `{ ingest_id: string (uuid) }`                                                                                                       | `zIngestStatusResponse` shape (§5.3)                                                                                                                                                                                                                                                                                                | `true`   | `false`     | `true`     | `false`   |
| `wikikit_propose`         | knowledge:propose | structured proposal: `{ space: string } & zCreateProposalRequest`                                                                    | `{ proposal_id, status: 'pending' }`                                                                                                                                                                                                                                                                                                | `false`  | `true`      | `true`     | `false`   |
| `wikikit_proposals`       | knowledge:review  | `{ space: string, proposal_id?: uuid, status?: ProposalStatus, limit?: 1-200 }`                                                      | summaries, or one complete public proposal diff including staged decisions and relations added/removed                                                                                                                                                                                                                              | `true`   | `false`     | `true`     | `false`   |
| `wikikit_review_proposal` | knowledge:review  | `{ proposal_id: uuid }` only; decision + optional note are human form fields; `decision`/`note` as input → `approval_requires_human` | accepted: approved/rejected result with `review_channel:'mcp_elicitation'`; declined/cancelled: `{ proposal_id, outcome, mutation_applied:false }`; no form capability: `{ proposal_id, status:'pending', outcome:'human_review_required', review_url, mutation_applied:false, poll_with:'wikikit_proposals', agent_instructions }` | `false`  | `true`      | `false`    | `false`   |

Annotation rationale (do not change silently): writes are `destructiveHint: true`
per the hard-won MCP rule ("never destructiveHint:false on real writes") even though
they only stage content — an honest write is a write. `idempotentHint: true` on
`wikikit_ingest` (content-hash dedup) and `wikikit_propose` (pending
`input_hash` unique index) because retrying with identical input converges on
the same row. `openWorldHint: true` only on `wikikit_ingest` (a `url` input
fetches an external host).

### 7.2 Error adapter (`src/mcp/error-adapter.ts`)

```ts
export function toToolError(
  err: unknown,
  requestId: string,
): { isError: true; content: [{ type: 'text'; text: string }] }
// text = JSON.stringify of the §8 envelope, ALWAYS including next_best_actions
// so agent clients terminate instead of looping.
```

---

## 8. Error envelope

### 8.1 Wire shape (`zErrorEnvelope`) — every non-2xx JSON response, and MCP tool errors

```json
{
  "error": "human-readable message",
  "code": "machine_code",
  "request_id": "a1b2c3d4e5f6",
  "next_best_actions": ["optional short imperative hints"]
}
```

### 8.2 Canonical codes ↔ HTTP status (typed errors in `src/domain/errors.ts`)

| Code                                                                                               | HTTP | Thrown as                         |
| -------------------------------------------------------------------------------------------------- | ---- | --------------------------------- |
| `bad_request` (zod details in `error`)                                                             | 400  | `ValidationError`                 |
| `unauthorized`                                                                                     | 401  | `UnauthorizedError`               |
| `insufficient_scope`                                                                               | 403  | `ForbiddenError`                  |
| `not_found`                                                                                        | 404  | `NotFoundError`                   |
| `already_ingested` (envelope carries `source_id`)                                                  | 409  | `ConflictError`                   |
| `proposal_not_pending`                                                                             | 409  | `ConflictError`                   |
| `stale_base`                                                                                       | 409  | `ConflictError`                   |
| `approval_requires_human` (`decision`/`note` passed as review tool input)                          | 400  | `HumanDecisionRequiredError`      |
| `elicitation_not_supported` (form capability vanished mid-review; backstop behind the hand-off)    | 409  | `ElicitationNotSupportedError`    |
| `invalid_elicitation_response` (form remained invalid after one bounded retry)                     | 400  | `InvalidElicitationResponseError` |
| `elicitation_timeout`                                                                              | 408  | `ElicitationTimeoutError`         |
| `elicitation_failed` (client/transport failed before a valid human decision)                       | 502  | `ElicitationFailedError`          |
| `body_too_large`                                                                                   | 413  | `PayloadTooLargeError`            |
| `rate_limited`                                                                                     | 429  | `RateLimitError`                  |
| `internal_error` (message NEVER leaks internals)                                                   | 500  | anything unrecognized             |
| `llm_not_configured` (`next_best_actions: ["set <the selected provider's key> and restart", ...]`) | 503  | `LlmNotConfiguredError`           |
| `draining`                                                                                         | 503  | shutdown state                    |

---

## 9. State machines

### 9.1 Ingest job (`wk_ingest_jobs.status`)

```
queued ──(worker claims, sets started_at)──▶ running ──▶ done    (proposal_id set; outbox wikikit.proposal.created)
                                                   └────▶ failed  (error set;      outbox wikikit.ingest.failed)
                                                   └────▶ quota_blocked ──(resume_at passes)──▶ queued
```

Terminal: `done`, `failed`. Terminal states never regress (the flips are
guarded on `status='running'`). No retries in v0.1 — a failed job is
re-submitted by the client (the archive is reused; see §4.1 dedup).
`quota_blocked` is NOT terminal and emits no outbox event: provider quota
exhaustion parks the job with a `resume_at` (parsed from the provider
message, +6h fallback), the worker stops claiming until then, and parked
jobs are requeued automatically once `resume_at` passes. Every
claimed job has a unique lease owner, `heartbeat_at`, and `lease_expires_at`;
a live worker renews the lease during long LLM calls. Expired leases (worker
crash) are flipped to `failed` with
`code: 'worker_lost'` AND emit `wikikit.ingest.failed` in the same
transaction — every failure path reaches the outbox.

### 9.2 Proposal (`wk_change_proposals.status`)

```
pending ──wk_apply_proposal──▶ approved   (terminal)
    │
    ├──wk_reject_proposal────▶ rejected   (terminal)
    └──(apply raises stale_base and the caller marks it)──▶ failed (terminal)
```

### 9.3 Revision / claim / relation status flips (inside the SQL functions only)

```
revision: proposed ─approve─▶ current ─(later approve of same concept)─▶ superseded
          proposed ─reject──▶ rejected
claim:    proposed ─approve─▶ verified ─(contradiction on approve)─▶ disputed ─▶ deprecated (via later proposal)
relation: proposed ─approve─▶ active   / ─reject─▶ removed
          active ─(approve of a proposal that staged its removal)─▶ removed
          (distinct writers of 'removed': a REJECTED add flips its own
           proposed row; an APPROVED removal flips a marked ACTIVE row —
           removal_proposal_id + the proposal's terminal status disambiguate)
```

Readers (search, concept reads, export) only ever see `current` revisions and
`verified|disputed|deprecated` claims.

---

## 10. Environment variables (must stay in lockstep with `src/config.ts`, `docs/CONFIGURATION.md`, `docs/llms-full.txt` — drift-tested)

| Variable                              | Default                                                            | Notes                                                       |
| ------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `HOST`                                | `127.0.0.1`                                                        |                                                             |
| `PORT`                                | `4060`                                                             |                                                             |
| `WIKIKIT_PUBLIC_URL`                  | `http://127.0.0.1:4060`                                            | OAuth issuer/resource + MCP origin; HTTPS in production     |
| `DATABASE_URL`                        | dev: `postgresql://postgres:wikikit-local@127.0.0.1:55442/wikikit` | **required in production**                                  |
| `WIKIKIT_KEY_PEPPER`                  | dev: `wikikit-local-key-pepper`                                    | **required in production**                                  |
| `WIKIKIT_BOOTSTRAP_API_KEY`           | `` (dev: generated + printed once at boot)                         |                                                             |
| `DEPLOYMENT_ENVIRONMENT`              | `development`                                                      | `production` in the production service                      |
| `WIKIKIT_LLM_PROVIDER`                | `anthropic`                                                        | `anthropic` \| `openai` \| `google`; invalid → boot fails   |
| `ANTHROPIC_API_KEY`                   | `` — no default anywhere                                           | read when provider is `anthropic`                           |
| `OPENAI_API_KEY`                      | `` — no default anywhere                                           | read when provider is `openai`                              |
| `GOOGLE_GENERATIVE_AI_API_KEY`        | `` — no default anywhere                                           | read when provider is `google`                              |
| `ANTHROPIC_BASE_URL`                  | ``                                                                 | honored when provider is `anthropic`; test stub target      |
| `WIKIKIT_MODEL_SYNTHESIS`             | `claude-sonnet-5`                                                  |                                                             |
| `WIKIKIT_MODEL_CLASSIFY`              | `claude-haiku-4-5`                                                 |                                                             |
| `WIKIKIT_MODEL_ANSWER`                | `claude-sonnet-5`                                                  |                                                             |
| `WIKIKIT_EMBEDDING_PROVIDER`          | `none`                                                             | `none` \| `openai` \| `google`; hybrid ranker opt-in        |
| `WIKIKIT_MODEL_EMBEDDING`             | `text-embedding-3-small`                                           | must be 1536-dim (google default: `gemini-embedding-001`)   |
| `WIKIKIT_MAX_BODY_BYTES`              | `10485760`                                                         | 1 KiB – 250 MiB                                             |
| `WIKIKIT_MAX_INGEST_TOKENS`           | `100000`                                                           | chunking threshold                                          |
| `WIKIKIT_INGEST_CONCURRENCY`          | `2`                                                                | 1–16                                                        |
| `WIKIKIT_INGEST_LEASE_MS`             | `900000`                                                           | 10 s–24 h                                                   |
| `WIKIKIT_INGEST_HEARTBEAT_MS`         | `30000`                                                            | 1 s–1 h; less than half the lease                           |
| `WIKIKIT_WEBHOOK_POLL_MS`             | `5000` (dev default file: `1000`)                                  |                                                             |
| `WIKIKIT_WEBHOOK_TIMEOUT_MS`          | `10000`                                                            |                                                             |
| `WIKIKIT_WEBHOOK_MAX_ATTEMPTS`        | `10`                                                               |                                                             |
| `WIKIKIT_WEBHOOK_CIRCUIT_THRESHOLD`   | `5`                                                                |                                                             |
| `WIKIKIT_WEBHOOK_ALLOW_PRIVATE`       | `!production`                                                      | SSRF guard                                                  |
| `WIKIKIT_TRUST_PROXY`                 | `false`                                                            |                                                             |
| `WIKIKIT_MCP_SESSION_TTL_MS`          | `1800000` (30 min)                                                 |                                                             |
| `WIKIKIT_MCP_MAX_SESSIONS`            | `200`                                                              |                                                             |
| `WIKIKIT_MCP_ELICITATION_TIMEOUT_MS`  | `300000` (5 min)                                                   | 10 s–30 min; no mutation after timeout                      |
| `WIKIKIT_USAGE_TELEMETRY_ENABLED`     | `false`                                                            | opt-in privacy-bounded usage ledger                         |
| `WIKIKIT_USAGE_HMAC_SECRET`           | ``                                                                 | required when telemetry is enabled; do not reuse key pepper |
| `WIKIKIT_USAGE_RETENTION_DAYS`        | `90`                                                               | 31–365 days                                                 |
| `WIKIKIT_COVERAGE_GAP_TOPICS_ENABLED` | `false`                                                            | opt-in gap-topic lexemes; never stores question text        |
| `WIKIKIT_OAUTH_DCR_ENABLED`           | `true`                                                             | RFC 7591 remote-client registration                         |
| `WIKIKIT_OAUTH_CODE_TTL_MS`           | `600000` (10 min)                                                  | 1–15 min                                                    |
| `WIKIKIT_OAUTH_ACCESS_TOKEN_TTL_MS`   | `3600000` (1 h)                                                    | 5 min–24 h                                                  |
| `WIKIKIT_OAUTH_REFRESH_TOKEN_TTL_MS`  | `2592000000` (30 d)                                                | 1 h–90 d; rotated on use                                    |
| `WIKIKIT_OAUTH_ALLOWED_SCOPES`        | `knowledge:read,knowledge:propose`                                 | interactive identity permission ceiling                     |
| `WIKIKIT_OAUTH_ENABLE_SIGNUP`         | `false`                                                            | auto-admit unknown OIDC identities at `knowledge:read`      |
| `WIKIKIT_OAUTH_PROVIDERS`             | API-key record                                                     | provider-neutral JSON list; external adapters use HTTPS     |
| `LOG_LEVEL`                           | `info`                                                             | debug/info/warn/error                                       |
| `NODE_ENV`                            | —                                                                  | `production` activates guards + disables `.env.defaults`    |

Only the key matching `WIKIKIT_LLM_PROVIDER` gates the LLM: absent → ingest and
query answer 503 `llm_not_configured`, naming **that** provider's key, while
every LLM-free feature keeps working. `NODE_ENV` is read from the process environment only and so has no row in
`.env.example`.

---

## 11. Composition root & binary flags (for reference)

```ts
// src/app.ts
export function createApp(config: Config, deps?: Partial<AppDeps>): App
export interface App {
  server: import('node:http').Server
  state: { draining: boolean }
  outbox: OutboxWorker
  ingest: IngestPipeline
  database: Database
}
export function start(config?: Config): Promise<App> // runMigrations → createApp → listen → workers
```

`bin/wikikit.ts` flag dispatch (ops flags only, NOT a CLI product):
no args → `start()`; `--migrate` → migrate and exit 0; `--version` → print
`VERSION` and exit 0. Compiled via
`bun build bin/wikikit.ts --compile --define 'WIKIKIT_BUILD_VERSION="<pkg version>"' --outfile dist/wikikit`.
