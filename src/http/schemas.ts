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
})

export const zProposalListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'failed', 'split']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export const zExportQuery = z.object({ format: z.enum(['md', 'okf']).default('md') })

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
 * Sync fast-path answer (200, not 202): the pushed content is already
 * archived — the stream head advanced (or already pointed here), no job, no
 * LLM, nothing to poll. Connectors treat this as success.
 */
export const zIngestUnchangedResponse = z.object({
  status: z.literal('unchanged'),
  source_id: z.uuid(),
  stream_id: z.uuid(),
})

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

export const zIngestStatusResponse = z.object({
  ingest_id: z.uuid(),
  // quota_blocked = parked on provider quota exhaustion; the worker requeues
  // it once the provider window reopens — no client action needed, keep polling.
  status: z.enum(['queued', 'running', 'done', 'failed', 'quota_blocked']),
  proposal_id: z.uuid().nullable(),
  source_id: z.uuid().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
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

export const zSourceStreamListResponse = z.object({ items: z.array(zSourceStreamResponse) })

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
      // (SCAFFOLDING_KINDS, src/domain/concepts.ts) is a landing place for
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
})

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

export const zLintResponse = z.object({
  findings: z.array(
    z.object({
      rule: z.enum([
        'contradictions',
        'missing-citations',
        'broken-relations',
        'stale-claims',
        'orphan-concepts',
        'unsourced-concepts',
        'stub-concepts',
        'empty-concepts',
        'unreviewed-proposals',
        'dangling-sources',
        'tombstoned-sources',
        'broken-cross-space-links',
      ]),
      severity: z.enum(['error', 'warn', 'info']),
      message: z.string(),
      concept_slug: z.string().optional(),
      claim_id: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  counts: z.object({ error: z.number().int(), warn: z.number().int(), info: z.number().int() }),
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
export const zCoverageStatsResponse = z.strictObject({
  schema_version: z.literal('wikikit.coverage-stats.v1'),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  disputed: z.strictObject({ open: z.number().int().nonnegative(), oldest_days: z.number().nullable() }),
  review_latency: z.strictObject({
    decided: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    median_hours: z.number().nullable(),
  }),
  freshness: z.strictObject({
    concepts: z.number().int().nonnegative(),
    stale_over_90d: z.number().int().nonnegative(),
  }),
  top_read_concepts: z.array(
    z.strictObject({ slug: z.string(), title: z.string(), reads: z.number().int().nonnegative() }),
  ),
  top_linked_concepts: z.array(
    z.strictObject({ slug: z.string(), title: z.string(), inbound_relations: z.number().int().nonnegative() }),
  ),
  gap_topics: z.strictObject({
    enabled: z.boolean(),
    items: z.array(z.strictObject({ lexeme: z.string(), count: z.number().int().nonnegative() })),
  }),
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
  zIngestUnchangedResponse,
  zIngestStatusResponse,
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
  zConceptHistoryResponse,
  zSearchResponse,
  zQueryRequest,
  zQueryResponse,
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
  zLintResponse,
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
