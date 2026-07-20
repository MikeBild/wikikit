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
import { zCreateProposalArgs } from '../domain/proposals.ts'
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
})

export const zProposalListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'failed']).optional(),
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

export const zCreateSpaceRequest = z.object({
  slug: z.string().regex(SPACE_SLUG),
  name: z.string().min(1).max(200),
  settings: z.record(z.string(), z.unknown()).optional(),
})

export const zUpdateSpaceSettingsRequest = z.object({
  settings: z.record(z.string(), z.unknown()),
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

export const zConceptListResponse = z.object({
  items: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      summary: z.string(),
      rev: z.number().int(),
      updated_at: z.string(),
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
  relations: z.array(z.object({ to_slug: z.string(), kind: zRelationKind })),
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
      kind: z.enum(['concept', 'claim']),
      slug: z.string().nullable(),
      claim_id: z.uuid().nullable(),
      title: z.string(),
      headline: z.string(),
      rank: z.number(),
    }),
  ),
})

export const zQueryRequest = z.object({
  question: z.string().min(1).max(2000),
  top_k: z.number().int().min(1).max(50).default(8),
})

export const zQueryResponse = z.object({
  answer_markdown: z.string(),
  citations: z.array(z.object({ slug: z.string(), title: z.string() })),
  not_in_knowledge_base: z.boolean(),
  agent_run_id: z.uuid(),
})

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export const zProposalListResponse = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum(['pending', 'approved', 'rejected', 'failed']),
      title: z.string(),
      summary: z.string(),
      created_at: z.string(),
      reviewer: z.string().nullable(),
      reviewed_at: z.string().nullable(),
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
  status: z.enum(['pending', 'approved', 'rejected', 'failed']),
  title: z.string(),
  summary: z.string(),
  created_at: z.string(),
  reviewer: z.string().nullable(),
  review_note: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  source_ids: z.array(z.uuid()),
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
})

export const zReviewRequest = z.object({ note: z.string().max(2000).optional() }).default({})

export const zProposalReviewResponse = z.discriminatedUnion('status', [
  z.object({
    proposal_id: z.uuid(),
    status: z.literal('approved'),
    concepts: z.array(z.string()),
    claims_verified: z.number().int(),
    claims_disputed: z.number().int(),
  }),
  z.object({ proposal_id: z.uuid(), status: z.literal('rejected') }),
])

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
        'empty-concepts',
        'unreviewed-proposals',
        'dangling-sources',
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

export const zCreateApiKeyRequest = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(z.enum(['knowledge:read', 'knowledge:propose', 'knowledge:approve', 'admin'])).min(1),
  /** Space slug; omitted = key valid for all spaces. */
  space: z.string().regex(SPACE_SLUG).optional(),
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

// ---------------------------------------------------------------------------
// Name → schema index (introspection surface for openapi.ts + drift tests)
// ---------------------------------------------------------------------------

export const SCHEMAS: Record<string, z.ZodType> = {
  zErrorEnvelope,
  zSpaceParams,
  zIdParams,
  zSpaceIdParams,
  zConceptParams,
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
  zAgentBriefingResponse,
  zAgentContextResponse,
  zIngestRequest,
  zIngestDocumentQuery,
  zIngestAcceptedResponse,
  zIngestStatusResponse,
  zCaptureSessionRequest,
  zCaptureSessionResponse,
  zSourceListResponse,
  zSourceResponse,
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
  zLintResponse,
  zWebhookListResponse,
  zCreateWebhookRequest,
  zWebhookResponse,
  zDeliveryListResponse,
  zCreateApiKeyRequest,
  zApiKeyCreatedResponse,
  zApiKeyResponse,
  zApiKeyListResponse,
  zApiKeyRevokedResponse,
  zReadyResponse,
  zStatsQuery,
  zIngestStatsResponse,
  zKnowledgeStatsResponse,
  zLlmStatsResponse,
  zWebhookStatsResponse,
}
