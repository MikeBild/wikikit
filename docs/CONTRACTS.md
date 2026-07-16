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
  settings    jsonb NOT NULL DEFAULT '{}',           -- incl. predicate vocabulary: {"predicates": ["is","has_status",...]}
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
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, content_hash)
);
CREATE INDEX wk_sources_space_created_idx ON wk_sources (space_id, created_at DESC);
```

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
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, from_concept_id, to_concept_id, kind)
);
```

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
  scopes       text[] NOT NULL,                      -- subset of {'knowledge:read','knowledge:propose','knowledge:approve','admin','*'}
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
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  input       jsonb NOT NULL,                        -- validated IngestRequest, verbatim
  source_id   uuid REFERENCES wk_sources(id),
  proposal_id uuid REFERENCES wk_change_proposals(id),
  error       jsonb,                                 -- {code, message} on failure
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX wk_ingest_jobs_queue_idx ON wk_ingest_jobs (created_at) WHERE status = 'queued';
```

### 1.13 `wk_agent_runs` (LLM audit ledger — written for EVERY LLM call)

```sql
CREATE TABLE wk_agent_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id       uuid NOT NULL REFERENCES wk_spaces(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('classify','synthesize','answer','adjudicate')),
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
--    contradicting (subject,predicate) pairs → both 'disputed' + ensure a
--    'contradicts' relation; relations/decisions proposed → 'active'.
-- 4. Proposal → 'approved' (reviewer, note, reviewed_at); space epoch += 1;
--    outbox events 'wikikit.proposal.approved' + 'wikikit.concept.updated' per concept.
-- Errors: 'proposal_not_found', 'proposal_not_pending', 'stale_base'.
CREATE FUNCTION wk_apply_proposal(p_proposal_id uuid, p_reviewer text, p_note text DEFAULT NULL)
RETURNS jsonb;  -- {proposal_id, status:'approved', concepts:[slug,...], claims_verified:int, claims_disputed:int}

-- Atomic reject. Proposed rows KEEP their rows (audit) but flip:
-- revisions → 'rejected', claims stay 'proposed' pinned to the rejected proposal
-- (invisible everywhere: readers filter on verified/disputed/deprecated),
-- relations → 'removed', decisions stay 'proposed'. Proposal → 'rejected';
-- outbox 'wikikit.proposal.rejected'.
CREATE FUNCTION wk_reject_proposal(p_proposal_id uuid, p_reviewer text, p_note text DEFAULT NULL)
RETURNS jsonb;  -- {proposal_id, status:'rejected'}

-- FTS over current revisions + visible claims. Proposed content is invisible
-- BY CONSTRUCTION: the revision join goes through wk_concepts.current_revision_id.
-- p_kind: NULL | 'concept' | 'claim'.
CREATE FUNCTION wk_search(p_space_id uuid, p_query text, p_kind text DEFAULT NULL, p_limit int DEFAULT 20)
RETURNS TABLE (kind text, concept_slug text, claim_id uuid, title text, headline text, rank real);
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
  /** Whitelisted SQL function call. ONLY 'wk_apply_proposal' | 'wk_reject_proposal' | 'wk_search'. Anything else throws. */
  call<R = Record<string, unknown>>(fn: WhitelistedFn, args: unknown[]): Promise<R[]>
  /** Insert an outbox event inside the CURRENT transaction (must be called on a tx-bound Db for atomicity). */
  emitEvent(spaceId: string, eventType: WebhookEventType, payload: Record<string, unknown>): Promise<void>
}
export type WhitelistedFn = 'wk_apply_proposal' | 'wk_reject_proposal' | 'wk_search'

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

## 3. LLM provider (`src/llm/provider.ts`, `src/llm/anthropic.ts`, `src/llm/fake.ts`)

### 3.1 Interface — exactly three methods

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
  /** False when no ANTHROPIC_API_KEY — callers answer 503 llm_not_configured. FakeProvider: true. */
  readonly configured: boolean
  /** Which existing concepts a source affects + which new concepts it warrants. Model: config.modelClassify. */
  classify(input: ClassifyInput): Promise<LlmResult<ClassifyOutput>>
  /** One call per affected concept: new revision + claims + relations. Model: config.modelSynthesis. */
  synthesize(input: SynthesizeInput): Promise<LlmResult<SynthesizeOutput>>
  /** Grounded Q&A over retrieved evidence with inline citations. Model: config.modelAnswer. */
  answer(input: AnswerInput): Promise<LlmResult<AnswerOutput>>
}

export function createAnthropicProvider(config: Config, deps?: { logger?: Logger }): LlmProvider
```

Anthropic specifics: `@anthropic-ai/sdk`, structured outputs
(`output_config.format` with the zod-derived JSON schema), `ANTHROPIC_BASE_URL`
honored natively by the SDK (test stub), prompt caching (`cache_control` on the
static system prompt block). Every call the caller persists to `wk_agent_runs`.

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
```

Zod schemas: `zClassifyOutput`, `zSynthesizeOutput`, `zAnswerOutput` — the
provider parses model responses through these and throws
`LlmOutputInvalidError` on failure (no silent partials).

### 3.3 FakeProvider (`src/llm/fake.ts`)

```ts
export interface FakeCall {
  method: 'classify' | 'synthesize' | 'answer'
  input: unknown
}
export interface FakeProvider extends LlmProvider {
  readonly calls: FakeCall[] // recorded in order — assertion surface for tests
}
export function createFakeProvider(overrides?: {
  classify?: (input: ClassifyInput) => ClassifyOutput
  synthesize?: (input: SynthesizeInput) => SynthesizeOutput
  answer?: (input: AnswerInput) => AnswerOutput
}): FakeProvider
```

Defaults (deterministic, no network): `classify` → affects nothing, proposes one
new concept derived from the source title; `synthesize` → echoes source
markdown, one claim `{subject: concept.slug, predicate: 'is', object: 'described', quote: first line, confidence: 0.9}`;
`answer` → `not_in_knowledge_base: true` for empty evidence, else concatenates
evidence. `run` meta uses `model: 'fake'`, real prompt_version constants, zero usage.

### 3.4 Prompt version constants (`src/llm/prompts/index.ts`)

```ts
export const PROMPT_VERSIONS = {
  classify: 'classify.v1',
  synthesize: 'synthesize.v1',
  answer: 'answer.v1',
  adjudicate: 'adjudicate.v1', // optional Haiku contradiction adjudication (cuttable)
} as const
```

Prompt files: `src/llm/prompts/{classify,synthesize,answer}.v1.ts` exporting
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
export function approveProposal(db: Db, args: { id: string; reviewer: string; note?: string }): Promise<ApplyResult> // ⚠ wraps db.call('wk_apply_proposal')
export function rejectProposal(db: Db, args: { id: string; reviewer: string; note?: string }): Promise<RejectResult> // ⚠ wraps db.call('wk_reject_proposal')

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
= error; `stale-claims`/`orphan-concepts` = warn; the rest = info.

### 4.1 Ingest pipeline (`src/ingest/pipeline.ts`)

```ts
export interface IngestPipeline {
  /** Insert a queued wk_ingest_jobs row and return its id (fast, no LLM). */
  enqueue(db: Db, spaceId: string, args: IngestRequest): Promise<{ ingest_id: string }>
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
references it, or a queued/running/done job produced it. Otherwise (the
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
export type Scope = 'knowledge:read' | 'knowledge:propose' | 'knowledge:approve' | 'admin'

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

| Method | Path                                          | Scope             | Handler                        | Request schema(s)                        | 2xx Response schema                                                               |
| ------ | --------------------------------------------- | ----------------- | ------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/v1/spaces`                                  | admin             | `createSpaceHandler`           | body `zCreateSpaceRequest`               | 201 `zSpaceResponse`                                                              |
| GET    | `/v1/spaces/{space}`                          | knowledge:read    | `getSpaceHandler`              | params `zSpaceParams`                    | 200 `zSpaceResponse`                                                              |
| POST   | `/v1/spaces/{space}/ingest`                   | knowledge:propose | `createIngestHandler`          | body `zIngestRequest`                    | 202 `zIngestAcceptedResponse` + `Location: /v1/ingests/{id}`                      |
| GET    | `/v1/ingests/{id}`                            | knowledge:propose | `getIngestHandler`             | params `zIdParams`                       | 200 `zIngestStatusResponse`                                                       |
| GET    | `/v1/spaces/{space}/sources`                  | knowledge:read    | `listSourcesHandler`           | query `zListQuery`                       | 200 `zSourceListResponse`                                                         |
| GET    | `/v1/spaces/{space}/sources/{id}`             | knowledge:read    | `getSourceHandler`             | params `zSpaceIdParams`                  | 200 `zSourceResponse`                                                             |
| GET    | `/v1/spaces/{space}/decisions`                | knowledge:read    | `listDecisionsHandler`         | query `zListQuery`                       | 200 `zDecisionListResponse`                                                       |
| GET    | `/v1/spaces/{space}/decisions/{slug}`         | knowledge:read    | `getDecisionHandler`           | params `zDecisionParams`                 | 200 `zDecisionResponse`                                                           |
| GET    | `/v1/spaces/{space}/concepts`                 | knowledge:read    | `listConceptsHandler`          | query `zListQuery`                       | 200 `zConceptListResponse` (ETag = `"<space-epoch>"`, 304 on If-None-Match)       |
| GET    | `/v1/spaces/{space}/concepts/{slug}`          | knowledge:read    | `getConceptHandler`            | params `zConceptParams`                  | 200 `zConceptResponse`                                                            |
| GET    | `/v1/spaces/{space}/concepts/{slug}/history`  | knowledge:read    | `getConceptHistoryHandler`     | params `zConceptParams`                  | 200 `zConceptHistoryResponse`                                                     |
| GET    | `/v1/spaces/{space}/search`                   | knowledge:read    | `searchHandler`                | query `zSearchQuery`                     | 200 `zSearchResponse`                                                             |
| POST   | `/v1/spaces/{space}/query`                    | knowledge:read    | `queryHandler`                 | body `zQueryRequest`                     | 200 `zQueryResponse` (503 `llm_not_configured` without key)                       |
| GET    | `/v1/spaces/{space}/proposals`                | knowledge:read    | `listProposalsHandler`         | query `zProposalListQuery`               | 200 `zProposalListResponse`                                                       |
| POST   | `/v1/spaces/{space}/proposals`                | knowledge:propose | `createProposalHandler`        | body `zCreateProposalRequest`            | 201 `zProposalCreatedResponse`                                                    |
| GET    | `/v1/proposals/{id}`                          | knowledge:read    | `getProposalHandler`           | params `zIdParams`                       | 200 `zProposalDetailResponse` (or `text/markdown` via Accept)                     |
| POST   | `/v1/proposals/{id}/approve`                  | knowledge:approve | `approveProposalHandler`       | body `zReviewRequest`                    | 200 `zProposalReviewResponse`                                                     |
| POST   | `/v1/proposals/{id}/reject`                   | knowledge:approve | `rejectProposalHandler`        | body `zReviewRequest`                    | 200 `zProposalReviewResponse`                                                     |
| GET    | `/v1/spaces/{space}/lint`                     | knowledge:read    | `lintHandler`                  | params `zSpaceParams`                    | 200 `zLintResponse`                                                               |
| GET    | `/v1/spaces/{space}/export`                   | knowledge:read    | `exportHandler`                | query `zExportQuery`                     | 200 `application/zip` stream                                                      |
| POST   | `/v1/spaces/{space}/import`                   | knowledge:propose | `importHandler`                | body: zip (`application/zip`) or MD tree | 202 `zProposalCreatedResponse`                                                    |
| GET    | `/v1/spaces/{space}/webhooks`                 | admin             | `listWebhooksHandler`          | params `zSpaceParams`                    | 200 `zWebhookListResponse`                                                        |
| POST   | `/v1/spaces/{space}/webhooks`                 | admin             | `createWebhookHandler`         | body `zCreateWebhookRequest`             | 201 `zWebhookResponse` (secret shown once)                                        |
| GET    | `/v1/spaces/{space}/webhooks/{id}/deliveries` | admin             | `listWebhookDeliveriesHandler` | params `zSpaceIdParams`                  | 200 `zDeliveryListResponse`                                                       |
| POST   | `/v1/api-keys`                                | admin             | `createApiKeyHandler`          | body `zCreateApiKeyRequest`              | 201 `zApiKeyCreatedResponse` (plaintext key shown once)                           |
| GET    | `/health`                                     | —                 | `healthHandler`                | —                                        | 200 `text/plain` `"ok"`                                                           |
| GET    | `/ready`                                      | —                 | `readyHandler`                 | —                                        | 200 `zReadyResponse` `{status:'ready', version}`; 503 while draining/not migrated |
| GET    | `/metrics`                                    | —                 | `metricsHandler`               | —                                        | 200 Prometheus text                                                               |
| GET    | `/openapi.json`                               | —                 | `openapiHandler`               | —                                        | 200 OpenAPI 3.1 from `buildOpenApi(ROUTES)`                                       |
| GET    | `/llms.txt`                                   | —                 | `llmsTxtHandler`               | —                                        | 200 `text/plain`                                                                  |
| GET    | `/llms-full.txt`                              | —                 | `llmsFullTxtHandler`           | —                                        | 200 `text/plain`                                                                  |

`POST /mcp` (plus `GET`/`DELETE /mcp` for SSE/session-close per Streamable
HTTP) is intentionally **outside** the ROUTES registry and the OpenAPI surface;
it shares the auth middleware.

Notes binding all builders:

- The `{space}` path segment is the space **slug**; handlers resolve it once
  via `getSpaceBySlug` and pass `space.id` down as `spaceId`.
- A space-scoped key (`wk_api_keys.space_id` set) may only touch that space →
  otherwise 403 `insufficient_scope`. `'*'` and `admin` scopes imply all
  knowledge scopes; `admin` does not imply `'*'`.
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
  status: z.enum(['queued', 'running', 'done', 'failed']),
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
  scopes: z.array(z.enum(['knowledge:read', 'knowledge:propose', 'knowledge:approve', 'admin'])).min(1),
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
})
```

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

## 6. Webhooks (Standard Webhooks)

### 6.1 Event names (the `event_type` column and the payload `type` field)

```
wikikit.proposal.created
wikikit.proposal.approved
wikikit.proposal.rejected
wikikit.concept.updated
wikikit.ingest.failed
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

| Event                       | `data` shape                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `wikikit.proposal.created`  | `{ proposal_id, space, title, source_ids: string[], concepts: string[] /* slugs */, claims_count: number, contradictions_count: number }` |
| `wikikit.proposal.approved` | `{ proposal_id, space, reviewer, note: string \| null, concepts: string[] }`                                                              |
| `wikikit.proposal.rejected` | `{ proposal_id, space, reviewer, note: string \| null }`                                                                                  |
| `wikikit.concept.updated`   | `{ space, slug, rev: number, proposal_id }`                                                                                               |
| `wikikit.ingest.failed`     | `{ ingest_id, space, error: { code, message } }`                                                                                          |

Delivery worker: poll `wk_outbox_events` where `dispatched_at IS NULL`, fan out
one `wk_webhook_deliveries` row per matching active endpoint, exponential
backoff (`min(2^attempt, 300)s` + jitter) up to `webhookMaxAttempts`, then
`dead`. Circuit breaker: `webhookCircuitThreshold` consecutive failures →
endpoint `disabled_until = now() + 15min`.

---

## 7. MCP server (`src/mcp/`)

Streamable HTTP at `/mcp`, `@modelcontextprotocol/sdk` ^1.29. One SDK `Server`
per session; handlers close over the `Principal`. Sessions are leases:
idle TTL sweep (`mcpSessionTtlMs`), hard cap (`mcpMaxSessions`) with
oldest-idle eviction, in-flight retain counter; session owner =
`keyId:principal` — a different key on a known session id → 404; unknown
session → JSON-RPC `-32001`. Origin-header validation; `mcp-protocol-version`
checked against SDK `SUPPORTED_PROTOCOL_VERSIONS`. Tool input schemas are the
SAME zod objects as REST (via `toJsonSchemaCompat` → draft-07 with
`additionalProperties: false`).

**Scope-gating = tool visibility**: `tools/list` returns only tools whose scope
the key holds. There is deliberately NO approve tool — approval is REST-only.
No in-band elicitation. Errors use the §8 envelope serialized into the tool
result (`isError: true`), never bare strings.

### 7.1 Tool table (binding — names, schemas, outputs, scopes, all four annotations)

| Tool                    | Scope             | Input schema (zod, in `src/mcp/tools.ts`)                                                    | Output (JSON in content)                                                                          | readOnly | destructive | idempotent | openWorld |
| ----------------------- | ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- | ----------- | ---------- | --------- |
| `wikikit_search`        | knowledge:read    | `{ space: string, q: string, kind?: 'concept'\|'claim', limit?: number (1-50, default 20) }` | `{ hits: SearchHit[] }` (§4.2)                                                                    | `true`   | `false`     | `true`     | `false`   |
| `wikikit_read`          | knowledge:read    | `{ space: string, slug: string }`                                                            | `zConceptResponse` shape (§5.3)                                                                   | `true`   | `false`     | `true`     | `false`   |
| `wikikit_sources`       | knowledge:read    | `{ space: string, slug?: string, source_id?: string }` (exactly one of slug/source_id)       | `{ sources: { id, kind, url, title, content_hash, created_at, cited_by_claims: number }[] }`      | `true`   | `false`     | `true`     | `false`   |
| `wikikit_decisions`     | knowledge:read    | `{ space: string, slug?: string }` (omit slug → list)                                        | slug → one decision; else `{ decisions: { slug, title, status, created_at }[] }`                  | `true`   | `false`     | `true`     | `false`   |
| `wikikit_history`       | knowledge:read    | `{ space: string, slug: string }`                                                            | `{ revisions: { rev, status, created_at, agent_meta }[] }`                                        | `true`   | `false`     | `true`     | `false`   |
| `wikikit_lint`          | knowledge:read    | `{ space: string }`                                                                          | `LintReport` (§4)                                                                                 | `true`   | `false`     | `true`     | `false`   |
| `wikikit_ingest`        | knowledge:propose | `zIngestRequest` + `{ space: string }`                                                       | `{ status: 'running', ingest_id, poll_with: 'wikikit_ingest_status' }` (async ack — never blocks) | `false`  | `true`      | `true`     | `true`    |
| `wikikit_ingest_status` | knowledge:propose | `{ ingest_id: string (uuid) }`                                                               | `zIngestStatusResponse` shape (§5.3)                                                              | `true`   | `false`     | `true`     | `false`   |
| `wikikit_propose`       | knowledge:propose | structured proposal: `{ space: string } & zCreateProposalRequest`                            | `{ proposal_id, status: 'pending' }`                                                              | `false`  | `true`      | `true`     | `false`   |

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

| Code                                                                       | HTTP | Thrown as               |
| -------------------------------------------------------------------------- | ---- | ----------------------- |
| `bad_request` (zod details in `error`)                                     | 400  | `ValidationError`       |
| `unauthorized`                                                             | 401  | `UnauthorizedError`     |
| `insufficient_scope`                                                       | 403  | `ForbiddenError`        |
| `not_found`                                                                | 404  | `NotFoundError`         |
| `already_ingested` (envelope carries `source_id`)                          | 409  | `ConflictError`         |
| `proposal_not_pending`                                                     | 409  | `ConflictError`         |
| `stale_base`                                                               | 409  | `ConflictError`         |
| `body_too_large`                                                           | 413  | `PayloadTooLargeError`  |
| `rate_limited`                                                             | 429  | `RateLimitError`        |
| `internal_error` (message NEVER leaks internals)                           | 500  | anything unrecognized   |
| `llm_not_configured` (`next_best_actions: ["set ANTHROPIC_API_KEY", ...]`) | 503  | `LlmNotConfiguredError` |
| `draining`                                                                 | 503  | shutdown state          |

---

## 9. State machines

### 9.1 Ingest job (`wk_ingest_jobs.status`)

```
queued ──(worker claims, sets started_at)──▶ running ──▶ done    (proposal_id set; outbox wikikit.proposal.created)
                                                   └────▶ failed  (error set;      outbox wikikit.ingest.failed)
```

Terminal: `done`, `failed`. Terminal states never regress (the flips are
guarded on `status='running'`). No retries in v0.1 — a failed job is
re-submitted by the client (the archive is reused; see §4.1 dedup). Jobs stuck
`running` past a reaper window (worker crash) are flipped to `failed` with
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
```

Readers (search, concept reads, export) only ever see `current` revisions and
`verified|disputed|deprecated` claims.

---

## 10. Environment variables (must stay in lockstep with `src/config.ts`, `docs/CONFIGURATION.md`, `docs/llms-full.txt` — drift-tested)

| Variable                            | Default                                                            | Notes                                                    |
| ----------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| `HOST`                              | `127.0.0.1`                                                        |                                                          |
| `PORT`                              | `4060`                                                             |                                                          |
| `WIKIKIT_PUBLIC_URL`                | `http://127.0.0.1:4060`                                            | trailing slash stripped                                  |
| `DATABASE_URL`                      | dev: `postgresql://postgres:wikikit-local@127.0.0.1:55442/wikikit` | **required in production**                               |
| `WIKIKIT_KEY_PEPPER`                | dev: `wikikit-local-key-pepper`                                    | **required in production**                               |
| `WIKIKIT_BOOTSTRAP_API_KEY`         | `` (dev: generated + printed once at boot)                         |                                                          |
| `ANTHROPIC_API_KEY`                 | `` — the only variable with no default anywhere                    | absent → LLM features answer 503 `llm_not_configured`    |
| `ANTHROPIC_BASE_URL`                | ``                                                                 | honored by the SDK; test stub target                     |
| `WIKIKIT_MODEL_SYNTHESIS`           | `claude-sonnet-5`                                                  |                                                          |
| `WIKIKIT_MODEL_CLASSIFY`            | `claude-haiku-4-5`                                                 |                                                          |
| `WIKIKIT_MODEL_ANSWER`              | `claude-sonnet-5`                                                  |                                                          |
| `WIKIKIT_MAX_BODY_BYTES`            | `10485760`                                                         | 1 KiB – 250 MiB                                          |
| `WIKIKIT_MAX_INGEST_TOKENS`         | `100000`                                                           | chunking threshold                                       |
| `WIKIKIT_INGEST_CONCURRENCY`        | `2`                                                                | 1–16                                                     |
| `WIKIKIT_WEBHOOK_POLL_MS`           | `5000` (dev default file: `1000`)                                  |                                                          |
| `WIKIKIT_WEBHOOK_TIMEOUT_MS`        | `10000`                                                            |                                                          |
| `WIKIKIT_WEBHOOK_MAX_ATTEMPTS`      | `10`                                                               |                                                          |
| `WIKIKIT_WEBHOOK_CIRCUIT_THRESHOLD` | `5`                                                                |                                                          |
| `WIKIKIT_WEBHOOK_ALLOW_PRIVATE`     | `!production`                                                      | SSRF guard                                               |
| `WIKIKIT_TRUST_PROXY`               | `false`                                                            |                                                          |
| `WIKIKIT_MCP_SESSION_TTL_MS`        | `1800000` (30 min)                                                 |                                                          |
| `WIKIKIT_MCP_MAX_SESSIONS`          | `200`                                                              |                                                          |
| `LOG_LEVEL`                         | `info`                                                             | debug/info/warn/error                                    |
| `NODE_ENV`                          | —                                                                  | `production` activates guards + disables `.env.defaults` |

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
