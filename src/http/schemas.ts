// HTTP zod schema module (CONTRACTS §5.3) — every named request/response
// schema referenced by the ROUTES registry, plus the §8.1 error envelope.
//
// WHY one module with NAMED exports: the route table references schemas by
// NAME (strings), so OpenAPI generation and the drift tests can introspect
// the registry without importing handler code. The SCHEMAS index at the
// bottom is the lookup table both consumers use — a route referencing a name
// that is not in the index fails the drift test, not a production request.
//
// WHY some schemas are re-exports from domain modules: zod-first means REST,
// MCP and the domain staging write must validate the SAME shape
// (zCreateProposalArgs is the canonical example). Where the wire shape and
// the domain shape are identical we alias instead of duplicating, so they can
// never drift apart.
import { z } from 'zod'
import { zCaptureSessionArgs } from '../agent/sessions.ts'
import { zClaimTriple } from '../domain/claims.ts'
import { REVIEW_CHANNELS, zCreateProposalArgs } from '../domain/proposals.ts'
import { zIngestInput } from '../ingest/acquire.ts'
import { SCHEDULE_KINDS, zScheduleSet } from '../schedule.ts'
import { WEBHOOK_EVENT_TYPES } from '../webhooks.ts'

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

// Path slugs mirror the DB CHECK constraints (§1.1, §1.3) so an impossible
// slug 400s at the boundary instead of running a query that can only miss.
const SPACE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
const CONCEPT_SLUG = /^[a-z0-9][a-z0-9-]{0,126}$/

/** Claim statuses visible to READERS (§9.3) — proposed/draft never leave the staging area. */
const zVisibleClaimStatus = z.enum(['verified', 'disputed', 'deprecated'])

const zRelationKind = z.enum(['related', 'part_of', 'depends_on', 'contradicts', 'supersedes'])

export { zClaimTriple }

// ---------------------------------------------------------------------------
// Error envelope (§8.1)
// ---------------------------------------------------------------------------

// loose: conflict envelopes carry extra fields (already_ingested → source_id)
// without each one needing its own named schema.
export const zErrorEnvelope = z.looseObject({
  error: z.string(),
  code: z.string(),
  request_id: z.string(),
  next_best_actions: z.array(z.string()).optional(),
})

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const zSpaceParams = z.object({ space: z.string().regex(SPACE_SLUG) })
export const zIdParams = z.object({ id: z.uuid() })
export const zSpaceIdParams = zSpaceParams.extend({ id: z.uuid() })
export const zConceptParams = zSpaceParams.extend({ slug: z.string().regex(CONCEPT_SLUG) })

// Closed set — the servable agent-hook scripts. Unknown names fail validation
// (400) instead of reaching the handler, and the drift test in
// install-embedded.test.ts pins this enum to the embedded assets.
export const zInstallHookScriptParams = z.object({
  script: z.enum([
    'wikikit-briefing.sh',
    'wikikit-context.sh',
    'wikikit-capture.sh',
    'wikikit-briefing.ps1',
    'wikikit-context.ps1',
    'wikikit-capture.ps1',
  ]),
})

// ---------------------------------------------------------------------------
// Query strings (z.coerce — query values arrive as strings)
// ---------------------------------------------------------------------------

// Both keyset cursors live here: concepts paginate forward by slug (`after`),
// sources paginate backward in time (`before`). One list-query schema keeps
// the wire surface uniform; each handler reads the cursor it supports.
export const zListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  after: z.string().max(500).optional(),
  before: z.string().max(500).optional(),
})

export const zSearchQuery = z.object({
  q: z.string().min(1).max(500),
  kind: z.enum(['concept', 'claim']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  // approved_then_sources appends the archived source-chunk tier
  // ('source_evidence') after every approved hit; limit applies per tier.
  mode: z.enum(['approved_only', 'approved_then_sources']).optional(),
  // 0023: additionally search the spaces declared in settings.imports.
  // Space-scoped keys get a deterministic 403 (they see exactly one space).
  include_imports: z.coerce.boolean().optional(),
  // Evidence-tier filters — they narrow the archived source chunks only, and
  // approved retrieval is answered byte-identically with or without them. They
  // do not switch the tier on: without mode=approved_then_sources there is no
  // evidence arm for them to narrow, and they are silently inert.
  // Half-open [evidence_from, evidence_to) over the source's ARCHIVE time.
  evidence_from: z.iso.datetime({ offset: true }).optional(),
  evidence_to: z.iso.datetime({ offset: true }).optional(),
  // Present on a source only when the ingesting client declared it, so this
  // filter excludes every source that never named a kind — most connector-fed
  // material among them. There is deliberately no 'report' value; see
  // CONTRACTS §4.2 for why "machine-fed vs hand-filed" is a different question.
  evidence_source_kind: z.enum(['meeting', 'article', 'note']).optional(),
})

export const zProposalListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'failed', 'split']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export const zExportQuery = z.object({ format: z.enum(['md', 'okf', 'obsidian']).default('md') })

// Import takes only the round-trip formats — the vault-mirror export
// (`obsidian`) is serialize-only, so the import route refuses it at the
// boundary instead of deep in the bundle machinery.
export const zImportQuery = z.object({ format: z.enum(['md', 'okf']).default('md') })

export const zAgentBriefingQuery = z.object({
  spaces: z.string().min(1).max(640),
  budget_tokens: z.coerce.number().int().min(500).max(4000).optional(),
})

export const zAgentContextRequest = z.object({
  prompt: z.string().max(12_000).default(''),
  project_hint: z.string().max(500).optional(),
  primary_space: z.string().regex(SPACE_SLUG).optional(),
  manual_spaces: z.array(z.string().regex(SPACE_SLUG)).max(20).optional(),
  exclude_spaces: z.array(z.string().regex(SPACE_SLUG)).max(100).optional(),
  max_spaces: z.number().int().min(1).max(10).optional(),
  budget_tokens: z.number().int().min(500).max(4000).optional(),
})

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

/**
 * Valid settings.language values — must match the CHECK/CASE lists in
 * migration 0016 (wk_space_search_config). Settings stay free-form except
 * for retrieval-critical keys, which are validated at the boundary.
 */
export const SPACE_LANGUAGES = ['en', 'de', 'simple'] as const

const zSpaceSettings = z.record(z.string(), z.unknown()).superRefine((settings, ctx) => {
  if ('language' in settings && !SPACE_LANGUAGES.includes(settings.language as never)) {
    ctx.addIssue({
      code: 'custom',
      path: ['language'],
      message: `settings.language must be one of: ${SPACE_LANGUAGES.join(', ')}`,
    })
  }
  // 0023: imports must be an array of valid space slugs. Naming a space that
  // does not exist YET is allowed (declaration of intent — it degrades to
  // skipped); a malformed slug is not.
  if ('imports' in settings) {
    const imports = settings.imports
    if (
      !Array.isArray(imports) ||
      imports.some((value) => typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['imports'],
        message: 'settings.imports must be an array of space slugs',
      })
    }
  }
})

export const zCreateSpaceRequest = z.object({
  slug: z.string().regex(SPACE_SLUG),
  name: z.string().min(1).max(200),
  settings: zSpaceSettings.optional(),
})

export const zUpdateSpaceSettingsRequest = z.object({
  settings: zSpaceSettings,
  replace: z.boolean().default(false),
})

export const zSpaceResponse = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  settings: z.record(z.string(), z.unknown()),
  epoch: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const zSpaceListResponse = z.object({ items: z.array(zSpaceResponse) })

// ---------------------------------------------------------------------------
// Charter — the per-space virtual document (authored markdown + derived overview)
// ---------------------------------------------------------------------------

/** ?rev=N reads a specific historical revision; omitted → the latest (current). */
export const zCharterQuery = z.object({
  rev: z.coerce.number().int().positive().optional(),
})

const zCharterOverview = z.object({
  concepts: z.number().int(),
  decisions: z.number().int(),
  sources: z.number().int(),
  index: z.array(z.object({ slug: z.string(), summary: z.string() })),
})

export const zCharterResponse = z.object({
  space: z.string(),
  /** null when the space has no charter (never written, or deleted). */
  rev: z.number().int().nullable(),
  markdown: z.string(),
  updated_at: z.string().nullable(),
  overview: zCharterOverview,
  /** The full virtual document (authored markdown + derived overview). */
  document: z.string(),
})

/** PUT result: the fresh document plus any ingest jobs opened for an overview edit. */
export const zCharterWriteResponse = zCharterResponse.extend({
  ingest_ids: z.array(z.string()),
})

export const zCharterVersionsResponse = z.object({
  items: z.array(
    z.object({
      rev: z.number().int(),
      status: z.enum(['current', 'superseded']),
      created_by: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
})

export const zAgentBriefingResponse = z.object({
  markdown: z.string(),
  spaces: z.array(z.string()),
  budget_tokens: z.number().int(),
  used_tokens: z.number().int(),
  concepts_included: z.array(z.string()),
  concepts_omitted: z.number().int(),
  /**
   * The review backlog of the briefed spaces, structured beside the markdown
   * lines that state it. `oldest_days` is null exactly when `total` is 0, and
   * per space exactly when that space's `pending` is 0 — the same null-not-zero
   * discipline as the health surfaces. These are FACT lines: the budget trim
   * removes pinned concepts, never these.
   */
  pending_changes: z.object({
    total: z.number().int().nonnegative(),
    oldest_days: z.number().int().nullable(),
    spaces: z.array(
      z.object({
        space: z.string(),
        pending: z.number().int().nonnegative(),
        oldest_days: z.number().int().nullable(),
      }),
    ),
  }),
})

export const zAgentContextResponse = zAgentBriefingResponse.extend({
  selection_mode: z.enum(['manual', 'automatic']),
  matches: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      score: z.number(),
      reasons: z.array(z.string()),
    }),
  ),
})

// ---------------------------------------------------------------------------
// Ingest (§5.3 verbatim)
// ---------------------------------------------------------------------------

// Alias, not copy (this module's own rule): the wire shape IS the pipeline's
// boundary schema — enqueue re-parses through zIngestInput, so a duplicate
// here could drift and make the HTTP boundary accept bodies the pipeline
// rejects (or vice versa for MCP's zIngestToolInput, built from the same
// object).
export const zIngestRequest = zIngestInput

export const zIngestAcceptedResponse = z.object({ ingest_id: z.uuid(), status: z.literal('queued') })

/**
 * Capture answer (200, not 202): the note is parked, nothing is running and
 * nothing needs polling — the row waits for POST /v1/ingests/{id}/process or
 * /discard. Distinct from the accepted ack on purpose: that one is
 * literal-typed 'queued' and promises a job in flight.
 */
export const zIngestCapturedResponse = z.object({
  status: z.literal('captured'),
  ingest_id: z.uuid(),
})

/**
 * Sync fast-path answer (200, not 202): the pushed content is already
 * archived — the stream head advanced (or already pointed here), no job, no
 * LLM, nothing to poll. Connectors treat this as success.
 */
export const zIngestUnchangedResponse = z.object({
  status: z.literal('unchanged'),
  source_id: z.uuid(),
  stream_id: z.uuid(),
})

/**
 * The two synchronous 200 answers of POST .../ingest, discriminated by
 * `status`: `unchanged` (sync fast-path) and `captured` (the note was parked).
 * One named union because a route declares exactly one schema per status code.
 */
export const zIngestSyncResponse = z.union([zIngestUnchangedResponse, zIngestCapturedResponse])

// Document upload (raw bytes body): the filename gives the extension used to
// pick the extractor (pdf/docx/xlsx/md/txt/csv).
export const zIngestDocumentQuery = z.object({
  filename: z.string().min(1).max(500).describe('Original filename incl. extension — selects the extractor'),
  source_kind: z.enum(['meeting', 'article', 'note']).optional(),
})

// Coding-agent session capture: transcript in, distilled rules staged as a
// proposal — or, for a routine session, nothing at all.
export const zCaptureSessionRequest = zCaptureSessionArgs

export const zCaptureSessionResponse = z.object({
  status: z
    .enum(['no_learnings', 'queued', 'already_captured'])
    .describe('no_learnings is the normal outcome — most sessions teach nothing durable'),
  ingest_id: z.uuid().nullable().describe('Set when status is queued — poll GET /v1/ingests/{id}'),
  learnings: z.number().int().describe('How many durable rules were distilled'),
  agent_run_id: z.uuid().describe('The distill call in the audit ledger — present even when nothing was learned'),
})

// The inbox list. `status` filters on the §9.1 states; `cursor` is the opaque
// `before` keyset cursor every archive list in this API uses, echoed back as
// next_before.
export const zIngestListQuery = z.object({
  status: z.enum(['queued', 'running', 'done', 'failed', 'quota_blocked', 'captured', 'discarded']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
})

export const zIngestStatusResponse = z.object({
  ingest_id: z.uuid(),
  // quota_blocked = parked on provider quota exhaustion; the worker requeues
  // it once the provider window reopens — no client action needed, keep
  // polling. captured = parked by a human (or a hook) until somebody promotes
  // or discards it; discarded is terminal and the row stays for the record.
  status: z.enum(['queued', 'running', 'done', 'failed', 'quota_blocked', 'captured', 'discarded']),
  proposal_id: z.uuid().nullable(),
  source_id: z.uuid().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  // ADDITIVE (0.38): the identity of a captured note. A parked row has no
  // source yet and the list never ships `input`, so without these two the
  // parked strip could show nothing but ids. Null on every other status.
  title: z.string().nullable().describe('Captured rows only: the submitted title'),
  excerpt: z.string().nullable().describe('Captured rows only: truncated text — the verbatim body stays in the job'),
  // Progress reporting. A long ingest is normal (one synthesis call per
  // affected concept, minutes each); what was missing is any way to tell a
  // slow job from a stuck one. phase is advisory and open — treat a value you
  // do not know as plain 'running'.
  phase: z
    .string()
    .nullable()
    .describe('Stage of a running job: acquire | classify | synthesize | decisions | adjudicate | propose'),
  progress: z
    .object({ done: z.number().int(), total: z.number().int() })
    .nullable()
    .describe('Position inside a countable stage — during synthesis, concepts finished of total'),
  // ADDITIVE (0.35): when the job was accepted. A queued job has no started_at
  // and no finished_at, so until this field existed the one state a job spends
  // most of its life in carried no time at all — and the space-scoped list, which
  // orders by it, had nothing to show for "waiting since".
  created_at: z.string().describe('When the job was accepted (ISO 8601)'),
  started_at: z.string().nullable().describe('When a worker claimed the job (ISO 8601)'),
  heartbeat_at: z
    .string()
    .nullable()
    .describe('Last lease renewal — a recent value means the worker is alive (ISO 8601)'),
  finished_at: z.string().nullable().describe('When the job reached a terminal state (ISO 8601)'),
})

/**
 * A page of this space's ingest jobs. The rows are byte-identical to the single
 * status read (same producer — toJobStatus in src/http/jobs.ts), which is what
 * lets the inbox render a row and the detail poll interchangeably.
 */
export const zIngestListResponse = z.object({
  items: z.array(zIngestStatusResponse),
  next_before: z.string().nullable(),
})

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const zSourceSummary = z.object({
  id: z.uuid(),
  kind: z.enum(['markdown', 'text', 'url', 'import']),
  url: z.string().nullable(),
  title: z.string().nullable(),
  content_hash: z.string(),
  created_at: z.string(),
})

export const zSourceListResponse = z.object({
  items: z.array(zSourceSummary),
  next_before: z.string().nullable(),
})

export const zSourceResponse = zSourceSummary.extend({
  raw_content: z.string(),
  markdown: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  // Per-source retrieval-language override (null = space default).
  language: z.enum(SPACE_LANGUAGES).nullable(),
  // Sync-contract provenance (all null for non-connector sources).
  stream_id: z.uuid().nullable(),
  source_version: z.string().nullable(),
  observed_at: z.string().nullable(),
  effective_at: z.string().nullable(),
  supersedes_source_id: z.uuid().nullable(),
})

// ---------------------------------------------------------------------------
// Source streams (connector sync contract, §1.2a)
// ---------------------------------------------------------------------------

export const zSourceStreamParams = zSpaceParams.extend({
  external_source_id: z.string().min(1).max(500),
})

export const zSourceStreamListQuery = z.object({
  external_source_id: z.string().min(1).max(500).optional(),
  include_deleted: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  // Keyset cursor for reconciliation walks: the raw external_source_id to
  // resume after. Deliberately allows the EMPTY string — `?after=` starts the
  // ASC walk at the lexicographic bottom (see listStreams).
  after: z.string().max(500).optional(),
})

export const zSourceStreamResponse = z.object({
  id: z.uuid(),
  external_source_id: z.string(),
  latest_source_id: z.uuid().nullable(),
  latest_version: z.string().nullable(),
  latest_observed_at: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  deleted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const zSourceStreamListResponse = z.object({
  items: z.array(zSourceStreamResponse),
  // Only ever non-null in cursor mode (?after=): the last external_source_id
  // of the page, to be fed back as the next `after`. null = walk complete
  // (or the request was not a cursor walk at all).
  next_after: z.string().nullable(),
})

export const zSourceStreamTombstoneResponse = z.object({
  status: z.literal('tombstoned'),
  stream_id: z.uuid(),
  already_tombstoned: z.boolean(),
})

// ---------------------------------------------------------------------------
// Decisions (read-only; staged through proposals, activated by wk_apply_proposal)
// ---------------------------------------------------------------------------

export const zDecisionParams = zSpaceParams.extend({ slug: z.string().regex(CONCEPT_SLUG) })

const zDecisionSummary = z.object({
  slug: z.string(),
  title: z.string(),
  // Readers only ever see active/superseded — proposed decisions are invisible.
  status: z.enum(['active', 'superseded']),
  created_at: z.string(),
})

export const zDecisionListResponse = z.object({ items: z.array(zDecisionSummary) })

export const zDecisionResponse = zDecisionSummary.extend({
  context: z.string(),
  decision: z.string(),
  rationale: z.string(),
  alternatives: z.array(z.unknown()),
  agent_meta: z.record(z.string(), z.unknown()),
})

// ---------------------------------------------------------------------------
// Concepts
// ---------------------------------------------------------------------------

/**
 * The page index. `evidence` is ADDITIVE — every field this list has ever
 * served stays, unchanged and in place: agents pin this response, and a rename
 * here is a broken reader somewhere that nobody sees fail.
 *
 * The counts are over VISIBLE claims only (`zVisibleClaimStatus` — the same
 * set `zConceptResponse.claims[].status` admits). `proposed` and `draft` claims
 * belong to a pending proposal, not to the page: counting them would let an
 * unreviewed proposal make a page look evidenced, which inverts the review
 * gate this product exists to hold.
 *
 * Where it is served it is three integers and never null: `claims: 0` is a
 * measured fact ("this page cites nothing" — a hand-written page), not missing
 * data, and a nullable number would license clients to render a measured zero
 * as unknown. It is OPTIONAL for one reason only, stated at the field.
 */
/**
 * The evidence summary, declared once and served by every surface that reports
 * it — the page index below and the concept hits of `/search`.
 *
 * One schema rather than two identical literals for the same reason the SQL
 * behind it is one lateral (`EVIDENCE_LATERAL`, src/domain/concepts.ts): these
 * numbers describe one page, and a client that reads them off a search result
 * and off the index must not have to check whether the two shapes still agree.
 * A field added to one and forgotten in the other is a contract that lies on
 * exactly one surface, which is the hardest kind to notice.
 */
const zEvidence = z.object({
  /** Visible claims the page makes. */
  claims: z.number().int().nonnegative(),
  /** Subset of `claims` carrying no citation at all — read against `claims`, never alone. */
  uncited_claims: z.number().int().nonnegative(),
  /** Distinct sources backing those claims — breadth, NOT `claims - uncited_claims`. */
  sources: z.number().int().nonnegative(),
})

/**
 * Why `evidence` is not there — declared once and served, like `zEvidence`
 * itself, by BOTH surfaces that report the measurement: the page index below and
 * the concept hits of `/search`.
 *
 * It exists because absence alone is not an answer. A reference target's
 * measurement is withheld on purpose (the marker is the deployment's statement
 * that the row is not a knowledge page), but until 0.31.0 the row simply had a
 * hole in it — the field was gone and nothing stood in its place, so a client
 * could only INFER the reason from the rest of the response, and WikiKit's own
 * console did exactly that. A guess about why a number is missing is not
 * something a server should make its clients make when the server is the one
 * that knows.
 *
 * THIS IS NOT THE MEASUREMENT UNDER ANOTHER NAME. It carries no
 * `uncited_claims` and no `sources`, and it never will: "how well is this page
 * backed" is not a question a reference target has an answer to, and answering
 * it here would undo the release that stopped answering it at all.
 *
 * AND IT IS NOT A FINDING. No severity, no advice, no verdict. The index
 * answers "how well is this page backed" and must not grow into a second
 * linter — `scaffolded-claims` (zLintResponse below) owns the judgement that a
 * marked page holding claims is a contradiction somebody should resolve, and
 * reports the same count from the same aggregate. What this object adds is that
 * the absence says what it is.
 */
const zNotMeasured = z.object({
  /**
   * A CATEGORY, never the marker literal — which `agent_meta.kind` made this row
   * furniture is one installation's private tag, and handing it to every client
   * is one step from "write the page with that kind and the complaints stop"
   * (see `scaffolded-claims`). An operator who needs the set has
   * `GET /v1/installation/knowledge-config`.
   *
   * One value today, declared as an enum rather than a free string so a client
   * that renders a sentence per reason fails loudly when a second one appears
   * instead of silently deciding what an unknown reason means.
   */
  reason: z.enum(['reference_target']),
  /**
   * How many visible claims the withheld measurement would have counted — the
   * SAME aggregate `evidence.claims` comes from, so the index can never report a
   * number the page read or the lint report disagrees with.
   *
   * OPTIONAL, and absent is the common case: on an ordinary reference target
   * nothing is being withheld, so there is no number, and a `0` here would
   * re-create exactly the meaningless zero that removing `evidence` from these
   * rows got rid of. Present only where the page does hold visible claims, and
   * there it says that a real count exists and is not being shown — a fact about
   * the INDEX, not a measurement of the knowledge.
   */
  withheld_claims: z.number().int().positive().optional(),
})

export const zConceptListResponse = z.object({
  items: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      summary: z.string(),
      rev: z.number().int(),
      updated_at: z.string(),
      // OPTIONAL, on exactly the argument that makes it optional on a search
      // hit: ABSENT and ZERO are different statements, and only one of them is
      // a measurement. A hit omits it where the page could not be measured; a
      // row omits it where the page must not be — a reference target
      // (notScaffolding, src/domain/concepts.ts) is a landing place for
      // reviewed relations whose own body says the knowledge lives on the pages
      // it points at. Three zeros there are indistinguishable from a knowledge
      // page that genuinely rests on nothing, which is the row an operator is
      // supposed to act on; a wiki where half the index carries a stark zero
      // that means nothing teaches its reader to ignore the ones that do.
      //
      // What this does NOT license is rendering a served zero as unknown. Where
      // the object is present all three numbers are measured and `claims: 0`
      // means the page cites nothing — the finding, not the absence of one.
      evidence: zEvidence.optional(),
      // Optional in exactly the way `evidence` is, and the two are a PAIR: a row
      // carries one or the other, never both and never neither. That is what
      // makes the absence self-describing — a client never has to work out from
      // its neighbours which kind of nothing it is holding, which is precisely
      // what a client had to do while this field did not exist.
      not_measured: zNotMeasured.optional(),
    }),
  ),
  next_after: z.string().nullable(),
  epoch: z.number().int(),
})

/** The full read served by REST AND wikikit_read (§5.3) — one shape, two transports. */
export const zConceptResponse = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  markdown: z.string(),
  rev: z.number().int(),
  updated_at: z.string(),
  claims: z.array(
    z.object({
      id: z.uuid(),
      subject: z.string(),
      predicate: z.string(),
      object: z.string(),
      status: zVisibleClaimStatus,
      confidence: z.number(),
      citations: z.array(z.object({ source_id: z.uuid(), quote: z.string(), locator: z.string() })),
    }),
  ),
  relations: z.array(z.object({ to_slug: z.string(), kind: zRelationKind, space: z.string().nullable() })),
  agent_meta: z.record(z.string(), z.unknown()),
})

/**
 * The pages around one page — served by GET .../concepts/{slug}/neighbors and
 * deliberately NOT folded into zConceptResponse: agents pin that shape, and
 * the neighborhood is a second, independently-loading read in the console.
 *
 * `relations` rows are folded to the FAR endpoint (the page a reader would go
 * to), both directions — `direction:'in'` is the backlink surface the concept
 * read never had. `space` is non-null only on an outgoing cross-wiki link;
 * inbound is same-space by construction (a foreign wiki's relations are its
 * own knowledge). `same_source` names concepts quoting the same archived
 * sources, ranked by `shared_sources` — the count is the whole argument, so it
 * travels. LLM-free on principle: relations and shared citations before any
 * embedding neighbor.
 */
export const zConceptNeighborsResponse = z.strictObject({
  schema_version: z.literal('wikikit.concept-neighbors.v1'),
  relations: z.array(
    z.strictObject({
      slug: z.string(),
      title: z.string(),
      kind: zRelationKind,
      direction: z.enum(['out', 'in']),
      space: z.string().nullable(),
    }),
  ),
  same_source: z.array(
    z.strictObject({
      slug: z.string(),
      title: z.string(),
      /** Distinct shared sources — always ≥1, or the row would not exist. */
      shared_sources: z.number().int().positive(),
    }),
  ),
})

export const zConceptHistoryResponse = z.object({
  slug: z.string(),
  revisions: z.array(
    z.object({
      id: z.uuid(),
      rev: z.number().int(),
      status: z.enum(['proposed', 'current', 'superseded', 'rejected']),
      title: z.string(),
      summary: z.string(),
      base_revision_id: z.uuid().nullable(),
      proposal_id: z.uuid().nullable(),
      agent_meta: z.record(z.string(), z.unknown()),
      created_at: z.string(),
    }),
  ),
})

export const zDeletedConceptListResponse = z.object({
  items: z.array(
    z.object({ slug: z.string(), title: z.string(), deleted_at: z.string(), deleted_revision_id: z.uuid() }),
  ),
})

export const zConceptLifecycleResponse = z.object({
  proposal_id: z.uuid(),
  status: z.literal('pending'),
  action: z.enum(['delete', 'restore']),
  slug: z.string(),
})

// ---------------------------------------------------------------------------
// Search & query
// ---------------------------------------------------------------------------

export const zSearchResponse = z.object({
  hits: z.array(
    z.object({
      kind: z.enum(['concept', 'claim', 'source_chunk']),
      // 'approved' = reviewed knowledge; 'source_evidence' = found only in an
      // archived source chunk (not yet curated). Approved hits always come
      // first — tiers are ranked independently, never interleaved.
      tier: z.enum(['approved', 'source_evidence']),
      // Which arm(s) of the hybrid ranker found the hit. Absent on every
      // lexical-only search — a deployment without pgvector or without an
      // embedding provider has one arm, and naming it would imply a choice was
      // made. Present, it explains a rank that lexical scoring alone cannot.
      matched_via: z.enum(['lexical', 'vector', 'both']).optional(),
      slug: z.string().nullable(),
      claim_id: z.uuid().nullable(),
      title: z.string(),
      headline: z.string(),
      rank: z.number(),
      source_id: z.uuid().nullable(),
      chunk_id: z.uuid().nullable(),
      url: z.string().nullable(),
      heading: z.string().nullable(),
      // The same three numbers the concept list serves, over the same visible
      // claims, for the page a CONCEPT hit points at — a search result is the
      // other place a reader decides which page to open, and it was as silent
      // about provenance as the index used to be.
      //
      // Optional here for one more reason than on the list, which shares the
      // rest of them: a hit may be a claim or an archived source chunk, and
      // those two carry no `evidence` by design — kind='claim' because the
      // page's totals answer a different question than the one a claim hit
      // raises, and kind='source_chunk' because that tier is explicitly NOT
      // approved knowledge and an evidence summary would say the opposite (see
      // SearchHit in src/query/search.ts). A concept hit omits it exactly where
      // the list's row does: an unreadable page, and a reference target. Where
      // the field IS served it is still three measured integers, never null:
      // `claims: 0` means the page cites nothing, and absence never means zero.
      evidence: zEvidence.optional(),
      // The same pair the index row carries, from the same read — a concept hit
      // on a reference target says so here, and says how much is being withheld,
      // in the identical object. Two surfaces answering one question about one
      // page must not answer it in two shapes; that is why `zEvidence` is one
      // declaration and why this is too.
      //
      // A concept hit whose page stopped being readable between the ranking and
      // the count carries NEITHER field. That silence has no reason attached on
      // purpose: there is no readable row left to describe, so the wiki has
      // nothing to say about it, and a hit is not the place to explain that a
      // page went away.
      not_measured: zNotMeasured.optional(),
      // Provenance (0023): which space produced the hit. Always present —
      // equals the request space for local hits.
      space: z.string(),
    }),
  ),
  /** Spaces actually searched (request space first, then visible imports). */
  searched_spaces: z.array(z.string()),
})

export const zQueryRequest = z.object({
  question: z.string().min(1).max(2000),
  top_k: z.number().int().min(1).max(50).default(8),
  mode: z.enum(['approved_only', 'approved_then_sources']).optional(),
  // The same three evidence filters /search takes, and they are here so the
  // Ask panel cannot answer over a wider archive than the list beside it: the
  // retrieval half of an answer must see the evidence the reader can see.
  evidence_from: z.iso.datetime({ offset: true }).optional(),
  evidence_to: z.iso.datetime({ offset: true }).optional(),
  evidence_source_kind: z.enum(['meeting', 'article', 'note']).optional(),
})

export const zQueryResponse = z.object({
  answer_markdown: z.string(),
  citations: z.array(z.object({ slug: z.string(), title: z.string() })),
  not_in_knowledge_base: z.boolean(),
  agent_run_id: z.uuid(),
  // Source-evidence citations (approved_then_sources mode): material the
  // answer used that exists ONLY in archived sources, not in approved
  // knowledge. Always present; empty in approved_only mode.
  source_citations: z.array(
    z.object({
      source_id: z.uuid(),
      chunk_id: z.uuid(),
      title: z.string().nullable(),
    }),
  ),
  /**
   * The persisted Output this answer became — the handle for
   * POST /v1/outputs/{id}/promote, which is the one door back into the wiki.
   * ADDITIVE: every field above is unchanged and in place.
   *
   * NULLABLE, and the null is honest rather than convenient: the answer is
   * already synthesized and paid for by the time the row is written, so a failed
   * insert must not throw away the response. Null means exactly "this answer
   * exists but was not persisted, so there is nothing to promote" — never "the
   * answer is bad".
   */
  output_id: z.uuid().nullable(),
})

// ---------------------------------------------------------------------------
// Outputs — what the knowledge base produced (§1 wk_outputs)
// ---------------------------------------------------------------------------

/**
 * One produced artifact. FULL rows in the list as well as the detail read, which
 * is unusual here and deliberate: an answer's markdown is kilobytes, and a list
 * of questions nobody can read without a second request per row is a list nobody
 * reads. The page size is smaller than the source list's for the same reason.
 */
export const zOutputResponse = z.object({
  id: z.uuid(),
  /**
   * Present on BOTH the list and the by-id read, though only the by-id route
   * strictly needs it: GET /v1/outputs/{id} is global-by-id (⚠ §4), so the space
   * has to travel for the key/space match, and serving one shape from one
   * producer is worth more than trimming a field off the list.
   */
  space_id: z.uuid(),
  kind: z.enum(['answer', 'briefing', 'health']),
  title: z.string(),
  /** The question asked (kind=answer); null for a briefing or a health report. */
  question: z.string().nullable(),
  markdown: z.string(),
  /** The knowledge pages the answer leaned on, as it named them (denormalized). */
  citations: z.array(z.object({ slug: z.string(), title: z.string() })),
  /** The honest "the base does not cover this"; null outside kind=answer. */
  not_in_knowledge_base: z.boolean().nullable(),
  agent_run_id: z.uuid().nullable(),
  /** The ingest job promotion opened; null while this output is unpromoted. */
  promoted_ingest_id: z.uuid().nullable(),
  promoted_at: z.string().nullable(),
  created_at: z.string(),
})

export const zOutputListQuery = z.object({
  kind: z.enum(['answer', 'briefing', 'health']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(500).optional(),
})

export const zOutputListResponse = z.object({
  items: z.array(zOutputResponse),
  next_before: z.string().nullable(),
})

/**
 * The promote answer: the ingest job the promotion opened.
 *
 * NOT zIngestAcceptedResponse, which carries `status: 'queued'` — re-promoting an
 * already-promoted output returns the ORIGINAL job id, and that job may well be
 * done. Claiming 'queued' about it would be a lie told to keep two schemas
 * looking alike. The caller polls /v1/ingests/{id} for the state either way.
 */
export const zOutputPromotedResponse = z.object({ ingest_id: z.uuid() })

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export const zReviewChannel = z.enum(REVIEW_CHANNELS)

export const zProposalListResponse = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum(['pending', 'approved', 'rejected', 'failed', 'split']),
      title: z.string(),
      summary: z.string(),
      created_at: z.string(),
      reviewer: z.string().nullable(),
      review_channel: zReviewChannel.nullable(),
      reviewed_at: z.string().nullable(),
      changes_requested: z.boolean(),
      parent_proposal_id: z.uuid().nullable(),
    }),
  ),
})

// Alias, not copy: the manual-proposal wire shape IS the domain staging shape
// (zod-first rule) — MCP's wikikit_propose validates the same object.
export const zCreateProposalRequest = zCreateProposalArgs

export const zProposalCreatedResponse = z.object({
  proposal_id: z.uuid(),
  status: z.literal('pending'),
  /** Import only: how many bundle sources were newly archived. */
  sources_created: z.number().int().optional(),
})

/** The structured diff (§5.3) — everything a reviewer needs in one read. */
export const zProposalDetailResponse = z.object({
  id: z.uuid(),
  space: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'failed', 'split']),
  title: z.string(),
  summary: z.string(),
  created_at: z.string(),
  reviewer: z.string().nullable(),
  review_note: z.string().nullable(),
  review_channel: zReviewChannel.nullable(),
  reviewed_at: z.string().nullable(),
  source_ids: z.array(z.uuid()),
  agent_meta: z.record(z.string(), z.unknown()),
  changes_requested: z.boolean(),
  parent_proposal_id: z.uuid().nullable(),
  concept_lifecycle: z
    .array(
      z.object({ slug: z.string(), action: z.enum(['delete', 'restore']), revision_id: z.uuid(), stale: z.boolean() }),
    )
    .optional(),
  sources: z.array(
    z.object({
      id: z.uuid(),
      title: z.string().nullable(),
      url: z.string().nullable(),
      kind: z.string(),
      created_at: z.string(),
    }),
  ),
  concepts: z.array(
    z.object({
      slug: z.string(),
      is_new: z.boolean(),
      old_markdown: z.string().nullable(),
      new_markdown: z.string(),
      stale: z.boolean(),
      claims_added: z.array(zClaimTriple),
      claims_disputed: z.array(zClaimTriple),
      claims_deprecated: z.array(zClaimTriple),
      claims: z.array(
        zClaimTriple.extend({
          status: z.string(),
          confidence: z.number(),
          collides: z.boolean(),
          citations: z.array(
            z.object({
              source_id: z.uuid(),
              quote: z.string(),
              locator: z.string(),
              source_title: z.string().nullable(),
            }),
          ),
        }),
      ),
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
      supersedes_slug: z
        .string()
        .nullable()
        .describe('The active decision this one retires on approval — the reviewer is deciding both'),
    }),
  ),
  /** Edge-level removals staged by this proposal (top-level: removal-only proposals have no concepts). */
  relations_removed: z.array(z.object({ from_slug: z.string(), to_slug: z.string(), kind: z.string() })),
})

export const zReviewRequest = z
  .object({
    note: z.string().max(2000).optional(),
    // Channel provenance only, no auth effect: the review page sends this when
    // it was opened through a URL-mode MCP elicitation, so the audit trail
    // records url_elicitation instead of a bare rest.
    via: z.enum(['url_elicitation']).optional(),
  })
  .default({})

export const zProposalReviewResponse = z.discriminatedUnion('status', [
  z.object({
    proposal_id: z.uuid(),
    status: z.literal('approved'),
    concepts: z.array(z.string()),
    claims_verified: z.number().int(),
    claims_disputed: z.number().int(),
    claims_deprecated: z.number().int(),
    relations_removed: z.number().int(),
    review_channel: zReviewChannel,
  }),
  z.object({ proposal_id: z.uuid(), status: z.literal('rejected'), review_channel: zReviewChannel }),
])

// Review operations (0020) ---------------------------------------------------

export const zSplitProposalRequest = z
  .object({
    // Named slugs = defer (subset into ONE child, parent stays pending);
    // absent/empty = full per-concept split (parent → terminal 'split').
    concepts: z.array(z.string().min(1).max(127)).max(100).optional(),
  })
  .default({})

export const zProposalSplitResponse = z.object({
  parent: z.object({ id: z.uuid(), status: z.enum(['split', 'pending']) }),
  children: z.array(z.object({ proposal_id: z.uuid(), concepts: z.array(z.string()) })),
})

export const zRequestChangesRequest = z.object({
  // Mandatory: the note IS the requested change — a bounce without guidance
  // is just a reject.
  note: z.string().min(1).max(2000),
  via: z.enum(['url_elicitation']).optional(),
})

export const zRequestChangesResponse = z.object({
  proposal_id: z.uuid(),
  status: z.literal('rejected'),
  review_channel: zReviewChannel,
  changes_requested: z.literal(true),
})

export const zProposalLintResponse = z.object({
  findings: z.array(
    z.object({
      rule: z.enum(['missing-citations', 'contradictions', 'stale-base', 'broken-relations', 'stale-claims']),
      severity: z.enum(['error', 'warn', 'info']),
      message: z.string(),
      concept_slug: z.string().optional(),
      claim_id: z.uuid().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  counts: z.object({ error: z.number().int(), warn: z.number().int(), info: z.number().int() }),
})

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

/**
 * One lint finding, declared once because TWO responses now serve the whole lint
 * report: GET /v1/spaces/{space}/lint and the composed health surface below,
 * which embeds `lintSpace()` unchanged rather than re-counting anything. Two
 * copies of this enum would mean a rule that exists on one surface and not the
 * other — and the health page would then be the one quietly missing a fault.
 */
const zLintFinding = z.object({
  rule: z.enum([
    'contradictions',
    'missing-citations',
    'broken-relations',
    'stale-claims',
    'orphan-concepts',
    'unsourced-concepts',
    // Knowledge whose visible claims quote nothing but sources WikiKit itself
    // produced (promoted answers). The one risk the output loop introduces, so
    // the loop ships with the rule that reports it.
    'self-derived-only',
    'stub-concepts',
    'scaffolded-claims',
    'empty-concepts',
    'unreviewed-proposals',
    'dangling-sources',
    'tombstoned-sources',
    'broken-cross-space-links',
    // The quick-tier maturity rules (0.39.0): the absent steering document, the
    // pending changes a fortnight old beside the unreviewed-proposals census,
    // and the parked thoughts a month old — the pressure valve capture needs
    // because nothing else ever pushes back on the inbox.
    'missing-charter',
    'stale-proposals',
    'stale-captures',
  ]),
  severity: z.enum(['error', 'warn', 'info']),
  message: z.string(),
  concept_slug: z.string().optional(),
  claim_id: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})

/** The severity census — a count per level, never a verdict. */
const zLintCounts = z.object({ error: z.number().int(), warn: z.number().int(), info: z.number().int() })

/**
 * `tier` picks the lint rhythm: 'quick' runs only the queue-and-inbox pulse
 * rules (RULE_TIERS in src/domain/lint.ts), 'deep' — the default, and a strict
 * superset — runs everything. The counts are a census of the rules that RAN,
 * so a quick report saying zero is not a deep report saying zero.
 */
export const zLintQuery = z.object({ tier: z.enum(['quick', 'deep']).default('deep') })

export const zLintResponse = z.object({
  findings: z.array(zLintFinding),
  counts: zLintCounts,
})

// ---------------------------------------------------------------------------
// Webhooks (admin surface)
// ---------------------------------------------------------------------------

const zWebhookEndpoint = z.object({
  id: z.uuid(),
  url: z.string(),
  events: z.array(z.string()),
  active: z.boolean(),
  failure_count: z.number().int(),
  disabled_until: z.string().nullable(),
  created_at: z.string(),
})

export const zWebhookListResponse = z.object({ items: z.array(zWebhookEndpoint) })

export const zCreateWebhookRequest = z.object({
  url: z.url(),
  /** Empty/omitted = subscribe to all event types (§1.11). */
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).optional(),
})

/** Creation response — the whsec_ secret appears here EXACTLY ONCE (encrypted at rest). */
export const zWebhookResponse = zWebhookEndpoint.extend({ secret: z.string() })

/**
 * How many delivery attempts one read may hold.
 *
 * The same `[1, 200]` window every other list in this API offers, and it is
 * declared here for the reason the parameter did not exist for three releases:
 * `listWebhookDeliveries` has always clamped to 200 with a default of 50, but
 * the server only validates — and therefore only forwards — a query string a
 * route has DECLARED, so the domain's ceiling was unreachable over HTTP and the
 * operator asking "our webhooks stopped last Tuesday" was answered with the
 * fifty newest attempts and no way to ask for the rest.
 *
 * No cursor is offered alongside it, unlike `zListQuery`, and the reason is NOT
 * that the query could not support one — `wk_webhook_deliveries_endpoint_created_idx`
 * (migration 0007) is exactly the `(endpoint_id, created_at)` index a keyset
 * walk would ride. It is that a cursor is a RESPONSE change: `zDeliveryListResponse`
 * carries `items` and nothing else, so `before`/`next_before` would have to be
 * added to the wire, pinned, and documented in six places, and a delivery log
 * is an operational record rather than knowledge anyone pages through. So 200
 * is a bigger window and not pagination — which is why the console prints a cap
 * note over a full answer instead of a "next page" it cannot honour.
 */
export const zDeliveryListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export const zDeliveryListResponse = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      event_id: z.string(),
      event_type: z.string(),
      status: z.string(),
      attempt: z.number().int(),
      next_attempt_at: z.string().nullable(),
      response_status: z.number().int().nullable(),
      last_error: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
})

// ---------------------------------------------------------------------------
// Schedules (admin — the in-process briefing/health worker, §1 wk_schedules)
// ---------------------------------------------------------------------------

// Alias, not copy (this module's rule): the wire body IS the domain's set schema
// — replaceSchedules re-parses through it, and the timezone refinement checks the
// name against the runtime's zone database, which no restatement here could do.
export const zScheduleSetRequest = zScheduleSet

export const zScheduleResponse = z.object({
  kind: z.enum(SCHEDULE_KINDS),
  /** Wall clock in `timezone`, HH:MM — 'every morning' means the operator's morning. */
  at_time: z.string(),
  /** null = daily; 0 = Sunday … 6 = Saturday (matches Postgres extract(dow)). */
  weekday: z.number().int().min(0).max(6).nullable(),
  timezone: z.string(),
  enabled: z.boolean(),
  last_run_at: z.string().nullable(),
  /** null = not armed; the worker never fires a row that has no next run. */
  next_run_at: z.string().nullable(),
})

/** GET and PUT answer the SAME shape: the complete set, after the change. */
export const zScheduleListResponse = z.object({ schedules: z.array(zScheduleResponse) })

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const zCreateApiKeyRequest = z
  .object({
    name: z.string().min(1).max(200),
    scopes: z
      .array(z.enum(['knowledge:read', 'knowledge:propose', 'knowledge:review', 'knowledge:approve', 'admin']))
      .min(1)
      .optional(),
    // Role preset (expanded to scopes at creation; scopes stay the ground
    // truth): reader → read; contributor → read+propose; reviewer →
    // read+propose+review. Deliberately no 'approver' preset —
    // knowledge:approve must be spelled out explicitly.
    role: z.enum(['reader', 'contributor', 'reviewer']).optional(),
    /** Space slug; omitted = key valid for all spaces. */
    space: z.string().regex(SPACE_SLUG).optional(),
  })
  .refine((value) => (value.role !== undefined) !== (value.scopes !== undefined), {
    message: 'provide exactly one of role or scopes',
  })

/** The plaintext `key` is shown here once and never stored (§1.10). */
export const zApiKeyCreatedResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  key: z.string(),
  scopes: z.array(z.string()),
  space: z.string().nullable(),
})

export const zApiKeyResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  scopes: z.array(z.string()),
  space: z.string().nullable(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
})

export const zApiKeyListResponse = z.object({ items: z.array(zApiKeyResponse) })

export const zApiKeyRevokedResponse = z.object({
  id: z.uuid(),
  revoked_at: z.string(),
})

// ---------------------------------------------------------------------------
// SSO identity grants (admin REST over wk_oauth_identities — 0028)
// ---------------------------------------------------------------------------

// Provider ids mirror the wk_oauth_identities provider CHECK; subjects are
// opaque IdP strings (URL-encoded in the path segment).
export const zIdentityParams = z.object({
  provider: z.string().regex(SPACE_SLUG),
  subject: z.string().min(1).max(500),
})

// `admin` is grantable, `*` is not — see IDENTITY_SCOPES in src/config.ts for
// the reasoning. In short: `admin` is an authority somebody can enumerate and
// audit, `*` is "everything, including whatever is added later".
//
// There is deliberately NO role shortcut that includes `knowledge:approve` or
// `admin`. The human review gate and the keys-and-identities surface must each
// be granted as an explicitly spelled-out scopes array, so nobody hands one out
// by picking a word that sounded senior.
const zIdentityScope = z.enum(['knowledge:read', 'knowledge:propose', 'knowledge:review', 'knowledge:approve', 'admin'])

// role XOR scopes is enforced in the handler (422 unprocessable, not 400):
// the shape is fine, the meaning of sending both is not.
export const zUpsertIdentityRequest = z
  .object({
    /**
     * Absent = keep whatever is stored; `null` = clear it; a string = set it.
     *
     * WHY null rather than `''`: the column is nullable and the login path
     * already writes NULL into it when the provider asserts no verified email
     * (src/oauth/server.ts), so NULL is this column's one and only "no email".
     * Accepting `''` as the clear signal would put a second kind of empty in
     * beside it, and every reader would then have to know both. `.min(1)`
     * refuses that second empty outright — an email here is a string with
     * something in it, or it is null.
     *
     * WHY an explicit null is not a new habit borrowed from another API: this
     * one already distinguishes absent from null where the difference carries
     * meaning — `base_revision_id` on a staged concept (src/domain/proposals.ts)
     * reads null as "written against no revision" and absence as "fall back to
     * the current pointer". Same distinction, same reason: a nullable column
     * cannot be cleared by a body that can only omit.
     *
     * `display_name` deliberately does NOT gain this. That column is `not null
     * default ''` (migration 0028), so `''` IS its empty and 0.24.0 made the
     * console send it; giving it a null spelling as well would invent a second
     * way to say the one thing it can already say.
     */
    email: z.string().min(1).max(320).nullable().optional(),
    display_name: z.string().max(200).optional(),
    role: z.enum(['reader', 'contributor', 'reviewer']).optional(),
    scopes: z.array(zIdentityScope).min(1).optional(),
    /** Only the deploy seeder sends 'seed'; anything else is stamped 'admin'. */
    source: z.literal('seed').optional(),
    /** The ONLY way to clear revoked_at — a PUT without it 409s on a revoked row. */
    restore: z.boolean().optional(),
  })
  .default({})

export const zIdentityResponse = z.object({
  provider: z.string(),
  subject: z.string(),
  email: z.string().nullable(),
  display_name: z.string(),
  /** The scope ceiling — the single stored AuthZ truth (NOT NULL since 0030). */
  allowed_scopes: z.array(z.string()),
  grant_source: z.enum(['admin', 'seed', 'signup', 'bootstrap']),
  created_at: z.string(),
  last_seen_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
})

export const zIdentityListResponse = z.object({ items: z.array(zIdentityResponse) })

export const zIdentityRevokedResponse = z.object({
  provider: z.string(),
  subject: z.string(),
  revoked_at: z.string(),
})

// ---------------------------------------------------------------------------
// Installation knowledge configuration (admin)
// ---------------------------------------------------------------------------

/**
 * THE RULE FOR THIS RESPONSE — read it before adding a field.
 *
 * A configuration-reporting endpoint's failure mode is not that somebody
 * deliberately publishes a secret. It is that it grows: each addition is
 * individually reasonable, the boundary is never restated, and eventually one
 * of them is a secret or points at one. So the boundary is written here, in the
 * schema, where the addition is made.
 *
 * A value may appear here only if BOTH hold:
 *
 *  1. It is KNOWLEDGE-SHAPING — it changes which pages WikiKit measures, lints
 *     or synthesises, so an operator reading an unexpected count needs it to
 *     explain the count. "An operator might be curious" is not this test.
 *  2. It is not a secret, not key material, not a connection string, and not
 *     DERIVED from one. Derived is the part that gets skipped: a length, a
 *     prefix, a fingerprint, a hash, and a plain is-it-set boolean are all
 *     derived, because each of them narrows a search for the real value. A
 *     `llm_configured: true` looks like the most harmless field imaginable and
 *     is exactly the one that starts the drift, so it is named here as REFUSED
 *     rather than left to a future reader's judgement. Whether an LLM is
 *     configured is already answered where it matters — the 503
 *     `llm_not_configured` envelope names the key that provider needs.
 *
 * The schema is strict and the handler names every field it emits; neither ever
 * spreads a config object. An allowlist is the only form of this rule that
 * survives contact with a future contributor, and a test asserts the response
 * keys against one.
 */
/**
 * Two origins, not three. A `fallback` value existed while WikiKit shipped one
 * deployment's historical import marker as a default; that default is gone, so
 * the value became unreachable and was removed rather than left as a promise
 * the product can no longer keep. Everything not built in is now, necessarily,
 * something the operator wrote.
 */
const zScaffoldingKindOrigin = z.enum([
  /** WikiKit's own marker — the product writes that revision and reads it back. */
  'built_in',
  /** The operator wrote WIKIKIT_SCAFFOLDING_KINDS and this is one of their values. */
  'configured',
])

export const zKnowledgeConfigResponse = z.strictObject({
  schema_version: z.literal('wikikit.knowledge-config.v1'),
  /**
   * The build that produced this report. Already public on /ready, so it adds
   * no exposure — and a configuration report nobody can pin to a version is
   * hard to act on across an upgrade, which is when it is read.
   */
  version: z.string(),
  scaffolding_kinds: z.strictObject({
    /** The knob, so the answer names the thing an operator would change. */
    env: z.literal('WIKIKIT_SCAFFOLDING_KINDS'),
    /**
     * Whether the variable was written at all. NOT derivable from `items`: an
     * installation that configured exactly the built-in marker reports items
     * that are all `built_in`, and would otherwise be indistinguishable from
     * one that configured nothing.
     */
    configured: z.boolean(),
    /** Effective markers in the order the reads apply them; built-in first. */
    items: z.array(z.strictObject({ kind: z.string(), origin: zScaffoldingKindOrigin })),
  }),
})

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

// EXACT deploy-gate shape: the deploy pipeline's health gate polls /ready and
// matches BOTH fields ({status:'ready', version:<tag>}) — do not add or
// rename fields without updating the deploy pipeline first.
export const zReadyResponse = z.object({
  status: z.enum(['ready', 'draining']),
  version: z.string(),
})

const zStatsBucket = z.enum(['hour', 'day', 'month', 'year'])
export const zStatsQuery = z.object({
  bucket: zStatsBucket.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  tz: z.literal('UTC').optional(),
})

export const zUsageStatsQuery = zStatsQuery.extend({
  traffic_class: z.enum(['organic', 'synthetic', 'internal', 'all']).optional(),
  /** Comma-separated allow-listed dimensions; the reader enforces max two per surface. */
  group_by: z.string().max(200).optional(),
})

const zStatsEnvelope = {
  bucket: zStatsBucket,
  tz: z.literal('UTC'),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
}

const zDurationSeconds = z.strictObject({
  total: z.number().nonnegative(),
  count: z.number().int().nonnegative(),
  avg: z.number().nonnegative(),
  max: z.number().nonnegative(),
})
const zIngestValues = z.strictObject({
  jobs: z.strictObject({
    created: z.number().int().nonnegative(),
    started: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  duration_seconds: zDurationSeconds,
})
export const zIngestStatsResponse = z.strictObject({
  ...zStatsEnvelope,
  buckets: z.array(zIngestValues.extend({ ts: z.iso.datetime() })),
  totals: zIngestValues,
})

const zKnowledgeValues = z.strictObject({
  sources_created: z.number().int().nonnegative(),
  concepts_created: z.number().int().nonnegative(),
  revisions_created: z.number().int().nonnegative(),
  claims_created: z.number().int().nonnegative(),
  citations_created: z.number().int().nonnegative(),
  decisions_created: z.number().int().nonnegative(),
  proposals_created: z.number().int().nonnegative(),
  proposals_approved: z.number().int().nonnegative(),
  proposals_rejected: z.number().int().nonnegative(),
  proposals_failed: z.number().int().nonnegative(),
})
export const zKnowledgeStatsResponse = z.strictObject({
  ...zStatsEnvelope,
  buckets: z.array(zKnowledgeValues.extend({ ts: z.iso.datetime() })),
  totals: zKnowledgeValues,
})

const zTokenValues = z.strictObject({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cache_read: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
})
const zDurationMs = z.strictObject({
  total: z.number().nonnegative(),
  avg: z.number().nonnegative(),
  max: z.number().nonnegative(),
})
const zLlmValues = z.strictObject({
  calls: z.number().int().nonnegative(),
  tokens: zTokenValues,
  duration_ms: zDurationMs,
  by_kind: z.record(z.string(), z.number().int().nonnegative()),
  by_model: z.record(z.string(), z.number().int().nonnegative()),
})
export const zLlmStatsResponse = z.strictObject({
  ...zStatsEnvelope,
  buckets: z.array(zLlmValues.extend({ ts: z.iso.datetime() })),
  totals: zLlmValues,
})

const zWebhookValues = z.strictObject({
  events: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  delivering: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  dead: z.number().int().nonnegative(),
})
export const zWebhookStatsResponse = z.strictObject({
  ...zStatsEnvelope,
  buckets: z.array(zWebhookValues.extend({ ts: z.iso.datetime() })),
  totals: zWebhookValues,
})

const zMetricValue = z.strictObject({
  value: z.number().nonnegative(),
  value_kind: z.enum(['count', 'gauge', 'duration', 'ratio', 'data-size']),
  value_state: z.enum(['observed', 'zero', 'missing']),
  sample_size: z.number().int().nonnegative().optional(),
  numerator: z.number().nonnegative().optional(),
  denominator: z.number().nonnegative().optional(),
})
const zUsageMetrics = z.strictObject({
  calls: zMetricValue,
  success: zMetricValue,
  client_errors: zMetricValue,
  server_errors: zMetricValue,
  rejected: zMetricValue,
  no_answer: zMetricValue,
  no_answer_ratio: zMetricValue,
  success_ratio: zMetricValue,
  error_ratio: zMetricValue,
  unique_actors: zMetricValue,
  unique_sessions: zMetricValue,
  duration_ms_total: zMetricValue,
  duration_ms_avg: zMetricValue,
  duration_ms_p50: zMetricValue,
  duration_ms_p95: zMetricValue,
  request_bytes: zMetricValue,
  response_bytes: zMetricValue,
  result_count: zMetricValue,
  active_sessions: zMetricValue,
})
const zUsageValues = z.strictObject({
  dimensions: z.record(z.string(), z.string().nullable()),
  metrics: zUsageMetrics,
})
export const zUsageStatsResponse = z.strictObject({
  schema_version: z.literal('wikikit.usage-stats.v1'),
  surface: z.enum(['http', 'mcp', 'knowledge', 'review']),
  ...zStatsEnvelope,
  traffic_class: z.enum(['organic', 'synthetic', 'internal', 'all']),
  group_by: z.array(z.string()).max(2),
  buckets: z.array(zUsageValues.extend({ ts: z.iso.datetime() })),
  totals: z.array(zUsageValues),
  quality: z.strictObject({
    sampled: z.literal(false),
    unique_count_method: z.literal('exact_window'),
    actor_scope: z.literal('wikikit_product_local_hmac'),
    content_captured: z.literal(false),
    dropped_events: z.number().int().nonnegative(),
    retention_days: z.number().int().min(31).max(365),
  }),
})

// Coverage insights (maintainer report) --------------------------------------

export const zCoverageStatsQuery = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  top: z.coerce.number().int().min(1).max(25).default(10),
})
// The five coverage measurements and the gap-topic wrapper, each declared once.
// The health surface below serves this same block (it calls the same
// getCoverageStats), and a second literal of these shapes would be a second
// answer to "how stale is this wiki" that nothing holds to the first.
const zCoverageDisputed = z.strictObject({
  open: z.number().int().nonnegative(),
  oldest_days: z.number().nullable(),
})
const zCoverageReviewLatency = z.strictObject({
  decided: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  median_hours: z.number().nullable(),
})
const zCoverageFreshness = z.strictObject({
  concepts: z.number().int().nonnegative(),
  stale_over_90d: z.number().int().nonnegative(),
})
const zTopReadConcepts = z.array(
  z.strictObject({ slug: z.string(), title: z.string(), reads: z.number().int().nonnegative() }),
)
const zTopLinkedConcepts = z.array(
  z.strictObject({ slug: z.string(), title: z.string(), inbound_relations: z.number().int().nonnegative() }),
)
/** `enabled:false` means nothing is ever recorded here — NOT "no gaps found". */
const zGapTopics = z.strictObject({
  enabled: z.boolean(),
  items: z.array(z.strictObject({ lexeme: z.string(), count: z.number().int().nonnegative() })),
})

export const zCoverageStatsResponse = z.strictObject({
  schema_version: z.literal('wikikit.coverage-stats.v1'),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  disputed: zCoverageDisputed,
  review_latency: zCoverageReviewLatency,
  freshness: zCoverageFreshness,
  top_read_concepts: zTopReadConcepts,
  top_linked_concepts: zTopLinkedConcepts,
  gap_topics: zGapTopics,
})

// Composed health (§4 src/domain/health.ts) ----------------------------------

/**
 * `from`/`to` are OPTIONAL here, unlike the coverage route where both are
 * required — the domain defaults to the last 30 days and echoes the window it
 * used. A maintenance page and a scheduled report have no window to pass, and a
 * required range would force each of them to invent the same one.
 *
 * `top` defaults to 5 rather than coverage's 10: on this surface the hub lists
 * are context beside the queue numbers, not the subject of the page.
 */
export const zSpaceHealthQuery = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  top: z.coerce.number().int().min(1).max(25).default(5),
  /** The lint rhythm the embedded report runs at — see zLintQuery. Default deep. */
  tier: z.enum(['quick', 'deep']).optional(),
})

/**
 * One answer to "how is this wiki doing": the lint report whole, the coverage
 * block whole, and the two live queues neither of them can measure.
 *
 * There is deliberately NO top-level verdict — no status, no traffic light, no
 * score. Every threshold that would produce one is policy (how many pending
 * changes is too many, for whose team?), `lint.counts` is already a severity
 * census, and a domain that invented a verdict would be hiding a decision from
 * the operator who owns it. src/domain/health.ts argues this at length.
 *
 * Nullable numbers are honestly null and never 0: "oldest pending change: 0 days"
 * about an empty queue is a fact about nothing.
 */
export const zSpaceHealthResponse = z.strictObject({
  schema_version: z.literal('wikikit.space-health.v1'),
  /** The window the `coverage` block describes, echoed — never assumed. */
  window: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }),
  lint: z.object({ findings: z.array(zLintFinding), counts: zLintCounts }),
  coverage: z.strictObject({
    disputed: zCoverageDisputed,
    review_latency: zCoverageReviewLatency,
    freshness: zCoverageFreshness,
    top_read_concepts: zTopReadConcepts,
    top_linked_concepts: zTopLinkedConcepts,
    gap_topics: zGapTopics,
  }),
  /** Changes staged and waiting for a human; oldest_days null iff pending is 0. */
  review_queue: z.strictObject({
    pending: z.number().int().nonnegative(),
    oldest_days: z.number().int().nullable(),
  }),
  /**
   * Ingest work not yet finished, right now. `depth` is queued + running;
   * `quota_blocked` sits beside them rather than inside, because a parked job is
   * neither — and a depth that hid it would report an idle queue to an operator
   * whose ingest has stopped moving. Hours, not days: a healthy queue drains in
   * minutes, so "0 days" would read like reassurance.
   */
  ingest_queue: z.strictObject({
    depth: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    quota_blocked: z.number().int().nonnegative(),
    oldest_queued_hours: z.number().nullable(),
    /**
     * Parked thoughts, beside `depth` like `quota_blocked`: a captured row is
     * not work in flight. `oldest_captured_days` is null iff `captured` is 0 —
     * and in DAYS, because the wait that matters is the thirty-day one the
     * stale-captures rule warns about.
     */
    captured: z.number().int().nonnegative(),
    oldest_captured_days: z.number().int().nullable(),
  }),
  /**
   * The archive against the retrieval index — reported before any sweep runs,
   * not after one: `sources` is everything archived, `indexed` the part search
   * can still reach, and `index_days` the window the sweep uses
   * (`WIKIKIT_SOURCE_INDEX_DAYS`), null when sources stay indexed forever. The
   * window travels with the counts for the same reason `window` travels with
   * `coverage`. `sources` = `indexed` + `unindexed`; unindexing never touches
   * the archived bytes, and a source can be re-indexed.
   */
  archive: z.strictObject({
    sources: z.number().int().nonnegative(),
    indexed: z.number().int().nonnegative(),
    unindexed: z.number().int().nonnegative(),
    index_days: z.number().int().nullable(),
  }),
})

/**
 * The cross-wiki overview (§4 src/domain/health.ts spacesOverview): one row per
 * space the key may see, with the review backlog, its age, the derived share,
 * the 7-day pulse and the visible page count — plus server-side totals so no
 * client sums eight rows its own way. Same refusals as zSpaceHealthResponse:
 * no verdict, no percentages, and every absent age is null, never 0.
 */
export const zSpacesOverviewResponse = z.strictObject({
  schema_version: z.literal('wikikit.spaces-overview.v1'),
  generated_at: z.iso.datetime(),
  /** `oldest_days` is the max over the rows — null exactly when nothing anywhere is pending. */
  totals: z.strictObject({
    pending: z.number().int().nonnegative(),
    pending_derived: z.number().int().nonnegative(),
    created_7d: z.number().int().nonnegative(),
    oldest_days: z.number().int().nullable(),
  }),
  items: z.array(
    z.strictObject({
      space: z.string(),
      name: z.string(),
      /** `settings.purpose || settings.description || null` — what the wiki says it is for. */
      purpose: z.string().nullable(),
      /**
       * `pending_derived` = pending proposals whose EVERY cited source is
       * stamped `derived_from_output_id`. Provenance, never a quality verdict.
       */
      review_queue: z.strictObject({
        pending: z.number().int().nonnegative(),
        oldest_days: z.number().int().nullable(),
        pending_derived: z.number().int().nonnegative(),
      }),
      created_7d: z.number().int().nonnegative(),
      concepts: z.number().int().nonnegative(),
    }),
  ),
})

// ---------------------------------------------------------------------------
// Name → schema index (introspection surface for openapi.ts + drift tests)
// ---------------------------------------------------------------------------

export const SCHEMAS: Record<string, z.ZodType> = {
  zErrorEnvelope,
  zSpaceParams,
  zIdParams,
  zSpaceIdParams,
  zConceptParams,
  zInstallHookScriptParams,
  zDecisionParams,
  zListQuery,
  zSearchQuery,
  zProposalListQuery,
  zExportQuery,
  zImportQuery,
  zAgentBriefingQuery,
  zAgentContextRequest,
  zCreateSpaceRequest,
  zUpdateSpaceSettingsRequest,
  zSpaceResponse,
  zSpaceListResponse,
  zCharterQuery,
  zCharterResponse,
  zCharterWriteResponse,
  zCharterVersionsResponse,
  zAgentBriefingResponse,
  zAgentContextResponse,
  zIngestRequest,
  zIngestDocumentQuery,
  zIngestAcceptedResponse,
  zIngestCapturedResponse,
  zIngestSyncResponse,
  zIngestUnchangedResponse,
  zIngestStatusResponse,
  zIngestListQuery,
  zIngestListResponse,
  zCaptureSessionRequest,
  zCaptureSessionResponse,
  zSourceListResponse,
  zSourceResponse,
  zSourceStreamParams,
  zSourceStreamListQuery,
  zSourceStreamResponse,
  zSourceStreamListResponse,
  zSourceStreamTombstoneResponse,
  zDecisionListResponse,
  zDecisionResponse,
  zConceptListResponse,
  zConceptResponse,
  zConceptNeighborsResponse,
  zConceptHistoryResponse,
  zDeletedConceptListResponse,
  zConceptLifecycleResponse,
  zSearchResponse,
  zQueryRequest,
  zQueryResponse,
  zOutputResponse,
  zOutputListQuery,
  zOutputListResponse,
  zOutputPromotedResponse,
  zProposalListResponse,
  zCreateProposalRequest,
  zProposalCreatedResponse,
  zProposalDetailResponse,
  zReviewRequest,
  zProposalReviewResponse,
  zSplitProposalRequest,
  zProposalSplitResponse,
  zRequestChangesRequest,
  zRequestChangesResponse,
  zProposalLintResponse,
  zLintQuery,
  zLintResponse,
  zSpaceHealthQuery,
  zSpaceHealthResponse,
  zSpacesOverviewResponse,
  zScheduleSetRequest,
  zScheduleResponse,
  zScheduleListResponse,
  zWebhookListResponse,
  zCreateWebhookRequest,
  zWebhookResponse,
  zDeliveryListQuery,
  zDeliveryListResponse,
  zCreateApiKeyRequest,
  zApiKeyCreatedResponse,
  zApiKeyResponse,
  zApiKeyListResponse,
  zApiKeyRevokedResponse,
  zIdentityParams,
  zUpsertIdentityRequest,
  zIdentityResponse,
  zIdentityListResponse,
  zIdentityRevokedResponse,
  zKnowledgeConfigResponse,
  zReadyResponse,
  zStatsQuery,
  zUsageStatsQuery,
  zIngestStatsResponse,
  zKnowledgeStatsResponse,
  zLlmStatsResponse,
  zWebhookStatsResponse,
  zUsageStatsResponse,
  zCoverageStatsQuery,
  zCoverageStatsResponse,
}
