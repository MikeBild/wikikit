// ROUTES registry — the single source of truth for the HTTP surface. The
// router (server.ts), the OpenAPI document (openapi.ts), the drift tests and
// llms.txt all derive from the same array, so the spec cannot drift from the
// implementation.
//
// Registry entries reference handlers and zod schemas by NAME (strings), not
// by object — that is what makes the registry introspectable: drift tests
// assert HANDLERS ↔ ROUTES set-equality and that every schema name resolves
// in SCHEMAS without executing a single handler.
//
// Handler convention: the server has already (1) matched the route,
// (2) authenticated the key and checked the ROUTE-level scope, (3) validated
// params/query/body against the declared schemas. Handlers do the
// SPACE-level scope check themselves via resolveSpace/requireScope — the
// space id only exists after the slug is resolved, and the check must use it
// (a space-scoped key touching a foreign space is 403, §5.4).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { captureSession } from '../agent/sessions.ts'
import { buildAgentBriefing } from '../agent/briefing.ts'
import { buildAgentContext } from '../agent/context.ts'
import { DEFAULT_SOURCE_INDEX_DAYS, type Config } from '../config.ts'
import type { Db } from '../db/postgres.ts'
import {
  BUILT_IN_SCAFFOLDING_KINDS,
  getConcept,
  getConceptHistory,
  listConcepts,
  toConceptResponse,
} from '../domain/concepts.ts'
import { listDeletedConcepts, stageConceptLifecycle } from '../domain/concept-lifecycle.ts'
import {
  deleteCharter,
  getCharter,
  getCharterHistory,
  renderCharter,
  toCharterResponse,
  writeCharter,
} from '../domain/charter.ts'
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, ValidationError } from '../domain/errors.ts'
import { lintProposal, lintSpace } from '../domain/lint.ts'
import {
  approveProposal,
  createProposal,
  getProposal,
  listProposals,
  rejectProposal,
  renderProposalMarkdown,
  requestChanges,
  splitProposal,
  stagesCrossSpaceRelations,
  toProposalWire,
} from '../domain/proposals.ts'
import { getDecision, listDecisions } from '../domain/decisions.ts'
import { conceptNeighbors } from '../domain/relations.ts'
import { spaceHealth, spacesOverview, type SpaceHealthArgs } from '../domain/health.ts'
import {
  getOutput,
  listOutputs,
  promoteOutput,
  recordOutput,
  renderOutputSource,
  type OutputKind,
} from '../domain/outputs.ts'
import { getSource, isoString, listSourceReferences, listSources, sha256Hex } from '../domain/sources.ts'
import { getTriageSuggestion, resolveTriage, suggestTriage } from '../domain/triage.ts'
import {
  getAttention,
  getAttentionItem,
  setAttentionState,
  type AttentionKind,
  type AttentionState,
} from '../domain/attention.ts'
import { listStreams, tombstoneStream } from '../domain/source-streams.ts'
import { createSpace, getSpaceBySlug, listSpaces, updateSpaceSettings, type Space } from '../domain/spaces.ts'
import { exportSpace, importBundle } from '../export/import.ts'
import { extractDocument } from '../ingest/extract.ts'
import type { IngestPipeline } from '../ingest/pipeline.ts'
import type { LlmProvider } from '../llm/provider.ts'
import type { Logger } from '../logger.ts'
import type { Metrics } from '../metrics.ts'
import {
  getHttpUsageStats,
  getIngestStats,
  getKnowledgeStats,
  getKnowledgeUsageStats,
  getLlmStats,
  getMcpUsageStats,
  getReviewUsageStats,
  getWebhookStats,
  resolveStatsWindow,
  resolveUsageStatsWindow,
} from '../stats.ts'
import { getCoverageStats, recordConceptRead, recordCoverageGap } from '../domain/coverage.ts'
import { answerQuestion } from '../query/answer.ts'
import { search, searchAcrossImports } from '../query/search.ts'
import { listWebhookDeliveries, listWebhookEndpoints, registerWebhookEndpoint } from '../webhooks.ts'
import { listSchedules, replaceSchedules } from '../schedule.ts'
import { ROLE_SCOPES, type RoleName } from './auth.ts'
import type { Auth, Principal } from './auth.ts'
import { getIngestJob, listIngestJobs, type IngestJobState } from './jobs.ts'
import { buildOpenApi } from './openapi.ts'
import { createHash } from 'node:crypto'
import { readDocsFile } from './docs-embedded.ts'
import { INSTALL_HOOK_SCRIPTS, renderInstaller } from './install-embedded.ts'
import { renderReviewPage, REVIEW_PAGE_CSP } from './review-page.ts'
import { markUsageContext, type UsageTelemetry } from '../usage.ts'

export type Scope = 'knowledge:read' | 'knowledge:propose' | 'knowledge:review' | 'knowledge:approve' | 'admin'

export interface RouteDef {
  method: 'get' | 'put' | 'post' | 'delete'
  /** OpenAPI template style: '/v1/spaces/{space}/concepts/{slug}'. */
  path: string
  /** null = public (health/docs endpoints). */
  scope: Scope | null
  /**
   * Additional scopes that ALSO satisfy this route (any-of with `scope`).
   * Proposal inspection carries `knowledge:review` here: review is the
   * inspect subset of approve (§5.2), so a reviewer key — including the
   * `knowledge:approve` key the human review page asks for — must be able
   * to load the diff it is deciding on without also holding knowledge:read.
   */
  altScopes?: readonly Scope[]
  summary: string
  /** Exported handler name in HANDLERS — drift-tested against the registry. */
  handler: string
  request?: {
    /** zod schema NAMES exported from src/http/schemas.ts. */
    params?: string
    query?: string
    body?: string
  }
  /** Body is raw bytes (zip upload), not JSON — the server skips JSON parsing. */
  rawBody?: true
  responses: Record<number, { schema?: string; type: string; desc: string }>
}

// Shared error responses appended by openapi.ts to every authenticated route;
// listed here once instead of 25 times in the table.
export const ROUTES: RouteDef[] = [
  {
    method: 'get',
    path: '/v1/spaces',
    scope: 'knowledge:read',
    summary: 'List spaces visible to the current key',
    handler: 'listSpacesHandler',
    responses: { 200: { schema: 'zSpaceListResponse', type: 'application/json', desc: 'Visible spaces' } },
  },
  {
    method: 'post',
    path: '/v1/spaces',
    scope: 'admin',
    summary: 'Create a space (workspace scope for all knowledge)',
    handler: 'createSpaceHandler',
    request: { body: 'zCreateSpaceRequest' },
    responses: { 201: { schema: 'zSpaceResponse', type: 'application/json', desc: 'Space created' } },
  },
  {
    method: 'get',
    path: '/v1/agent/briefing',
    scope: 'knowledge:read',
    summary: 'Build a compact, budgeted coding-agent briefing across spaces',
    handler: 'agentBriefingHandler',
    request: { query: 'zAgentBriefingQuery' },
    responses: { 200: { schema: 'zAgentBriefingResponse', type: 'application/json', desc: 'Agent briefing' } },
  },
  {
    method: 'post',
    path: '/v1/agent/context',
    scope: 'knowledge:read',
    summary: 'Select relevant spaces from task context and build a compact briefing',
    handler: 'agentContextHandler',
    request: { body: 'zAgentContextRequest' },
    responses: { 200: { schema: 'zAgentContextResponse', type: 'application/json', desc: 'Selected context' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}',
    scope: 'knowledge:read',
    summary: 'Read a space (settings, epoch)',
    handler: 'getSpaceHandler',
    request: { params: 'zSpaceParams' },
    responses: { 200: { schema: 'zSpaceResponse', type: 'application/json', desc: 'Space' } },
  },
  {
    method: 'post',
    path: '/v1/spaces/{space}/settings',
    scope: 'admin',
    summary: 'Merge or replace stable space metadata used for context discovery',
    handler: 'updateSpaceSettingsHandler',
    request: { params: 'zSpaceParams', body: 'zUpdateSpaceSettingsRequest' },
    responses: { 200: { schema: 'zSpaceResponse', type: 'application/json', desc: 'Updated space' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/charter',
    scope: 'knowledge:read',
    summary:
      'Read the space charter — the virtual document (authored markdown + derived overview). ?rev=N for a version. Accept: text/markdown renders the document.',
    handler: 'getCharterHandler',
    request: { params: 'zSpaceParams', query: 'zCharterQuery' },
    responses: { 200: { schema: 'zCharterResponse', type: 'application/json', desc: 'Charter document' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/charter/versions',
    scope: 'knowledge:read',
    summary: 'List charter revisions (newest first) — the document version history',
    handler: 'charterVersionsHandler',
    request: { params: 'zSpaceParams' },
    responses: { 200: { schema: 'zCharterVersionsResponse', type: 'application/json', desc: 'Charter versions' } },
  },
  {
    method: 'put',
    path: '/v1/spaces/{space}/charter',
    scope: 'admin',
    summary:
      'Write the charter (JSON {markdown} or raw text/markdown body). Authored text versions directly; an edited overview block is routed through the review gate.',
    handler: 'putCharterHandler',
    request: { params: 'zSpaceParams' },
    rawBody: true,
    responses: { 200: { schema: 'zCharterWriteResponse', type: 'application/json', desc: 'Charter written' } },
  },
  {
    method: 'delete',
    path: '/v1/spaces/{space}/charter',
    scope: 'admin',
    summary: 'Delete the charter (supersede the current revision; history retained). Idempotent.',
    handler: 'deleteCharterHandler',
    request: { params: 'zSpaceParams' },
    responses: {
      200: { schema: 'zCharterResponse', type: 'application/json', desc: 'Charter deleted (empty document)' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/sources/{id}/references',
    scope: 'knowledge:read',
    summary: 'List current pages and pending proposals that use one archived source',
    handler: 'sourceReferencesHandler',
    request: { params: 'zSpaceIdParams', query: 'zSourceReferencesQuery' },
    responses: {
      200: { schema: 'zSourceReferencesResponse', type: 'application/json', desc: 'Source references' },
    },
  },
  {
    method: 'post',
    path: '/v1/spaces/{space}/ingest',
    scope: 'knowledge:propose',
    summary:
      'Ingest a source (markdown|text|url) — async; returns an ingest job to poll. capture:true parks it instead',
    handler: 'createIngestHandler',
    request: { params: 'zSpaceParams', body: 'zIngestRequest' },
    responses: {
      200: {
        schema: 'zIngestSyncResponse',
        type: 'application/json',
        desc: 'Terminal sync answer: unchanged (external_source_id fast-path — head advanced) | captured (capture:true — parked, no LLM, no queue slot; resolve through triage)',
      },
      202: {
        schema: 'zIngestAcceptedResponse',
        type: 'application/json',
        desc: 'Queued; poll the Location header (/v1/ingests/{id})',
      },
      409: {
        schema: 'zErrorEnvelope',
        type: 'application/json',
        desc: 'already_ingested (envelope carries source_id) | sync_version_conflict (same version, different content)',
      },
      422: {
        schema: 'zErrorEnvelope',
        type: 'application/json',
        desc: 'unprocessable — the content carries the top-level `wikikit:` provenance frontmatter, i.e. it IS an export mirror of this wiki; ingesting it would loop approved knowledge back through review (capture:true is refused too)',
      },
      429: {
        schema: 'zErrorEnvelope',
        type: 'application/json',
        desc: 'ingest_queue_full — this space already has WIKIKIT_INGEST_MAX_QUEUED_PER_SPACE jobs waiting (envelope carries queued + limit); nothing was queued',
      },
      503: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'llm_not_configured' },
    },
  },
  {
    method: 'post',
    path: '/v1/spaces/{space}/agent/sessions',
    scope: 'knowledge:propose',
    summary: 'Capture a coding-agent session: distil the rules a human taught; usually nothing, else one proposal',
    handler: 'captureSessionHandler',
    request: { params: 'zSpaceParams', body: 'zCaptureSessionRequest' },
    responses: {
      200: {
        schema: 'zCaptureSessionResponse',
        type: 'application/json',
        desc: 'no_learnings (nothing durable taught) | queued (poll ingest_id) | already_captured',
      },
      503: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'llm_not_configured' },
    },
  },
  {
    method: 'get',
    path: '/v1/ingests/{id}',
    scope: 'knowledge:propose',
    summary: 'Ingest job status; done may carry proposal_id or valid no-review-work result',
    handler: 'getIngestHandler',
    request: { params: 'zIdParams' },
    responses: { 200: { schema: 'zIngestStatusResponse', type: 'application/json', desc: 'Job status' } },
  },
  {
    method: 'get',
    path: '/v1/ingests/{id}/triage',
    scope: 'knowledge:propose',
    summary: 'Read the editable triage suggestion stored with a captured item',
    handler: 'getTriageHandler',
    request: { params: 'zIdParams' },
    responses: { 200: { schema: 'zTriageResponse', type: 'application/json', desc: 'Stored suggestion or null' } },
  },
  {
    method: 'post',
    path: '/v1/ingests/{id}/triage',
    scope: 'knowledge:propose',
    summary: 'Generate and store an editable placement suggestion for a captured item',
    handler: 'suggestTriageHandler',
    request: { params: 'zIdParams' },
    responses: { 200: { schema: 'zTriageResponse', type: 'application/json', desc: 'Fresh triage suggestion' } },
  },
  {
    method: 'post',
    path: '/v1/ingests/{id}/triage/resolve',
    scope: 'knowledge:propose',
    summary: 'Resolve a captured item by processing, reusing a source, leaving it open or discarding it',
    handler: 'resolveTriageHandler',
    request: { params: 'zIdParams', body: 'zTriageResolutionRequest' },
    responses: { 200: { schema: 'zIngestStatusResponse', type: 'application/json', desc: 'Resolved ingest job' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/ingests',
    scope: 'knowledge:read',
    // knowledge:propose ALSO satisfies it: a contributor key can already poll
    // any single job of its own (GET /v1/ingests/{id} is a propose route), so
    // refusing it the list of exactly those jobs would be a gap, not a guard.
    altScopes: ['knowledge:propose'],
    summary:
      'List this space’s ingest jobs newest-first — the inbox (?status= queued|running|done|failed|quota_blocked|captured|discarded, ?limit=, ?cursor=). Rows are the same shape GET /v1/ingests/{id} serves; captured rows carry title + excerpt.',
    handler: 'listIngestsHandler',
    request: { params: 'zSpaceParams', query: 'zIngestListQuery' },
    responses: { 200: { schema: 'zIngestListResponse', type: 'application/json', desc: 'Ingest jobs page' } },
  },
  {
    method: 'post',
    path: '/v1/spaces/{space}/ingest/document',
    scope: 'knowledge:propose',
    summary: 'Upload a document (pdf|docx|xlsx|md|txt|csv, raw body) — extracted to Markdown then ingested; async',
    handler: 'ingestDocumentHandler',
    request: { params: 'zSpaceParams', query: 'zIngestDocumentQuery' },
    rawBody: true,
    responses: {
      200: { schema: 'zIngestCapturedResponse', type: 'application/json', desc: 'Extracted and parked in the inbox' },
      202: {
        schema: 'zIngestAcceptedResponse',
        type: 'application/json',
        desc: 'Extracted + queued; poll /v1/ingests/{id}',
      },
      415: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'unsupported_document (unknown extension)' },
      422: {
        schema: 'zErrorEnvelope',
        type: 'application/json',
        desc: 'document_extraction_failed (no text layer) | unprocessable — the extracted markdown carries the top-level `wikikit:` provenance frontmatter (an export mirror of this wiki) and is never ingested',
      },
      429: {
        schema: 'zErrorEnvelope',
        type: 'application/json',
        desc: 'ingest_queue_full — the queue is at its per-space ceiling; the extraction ran but nothing was queued',
      },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/sources',
    scope: 'knowledge:read',
    summary: 'List archived sources (keyset pagination via ?before=)',
    handler: 'listSourcesHandler',
    request: { params: 'zSpaceParams', query: 'zListQuery' },
    responses: { 200: { schema: 'zSourceListResponse', type: 'application/json', desc: 'Sources page' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/sources/{id}',
    scope: 'knowledge:read',
    summary: 'Read one source (raw + normalized markdown)',
    handler: 'getSourceHandler',
    request: { params: 'zSpaceIdParams' },
    responses: { 200: { schema: 'zSourceResponse', type: 'application/json', desc: 'Source' } },
  },
  {
    method: 'post',
    path: '/v1/spaces/{space}/sources/{id}/resynthesize',
    scope: 'knowledge:propose',
    summary:
      'Run the current synthesis pipeline over one immutable archived source; never re-fetches its URL and never publishes without review',
    handler: 'resynthesizeSourceHandler',
    request: { params: 'zSpaceIdParams' },
    responses: {
      202: {
        schema: 'zIngestAcceptedResponse',
        type: 'application/json',
        desc: 'Queued, or the same still-active resynthesis job',
      },
      429: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'ingest_queue_full' },
      503: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'llm_not_configured' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/source-streams',
    scope: 'knowledge:read',
    summary:
      'List connector source streams (sync contract): head pointer, latest version, tombstone state. With ?after= (raw external_source_id; empty starts the walk) the order is external_source_id ASC and next_after cursors the walk; without it the order stays updated_at.desc and next_after is null',
    handler: 'listSourceStreamsHandler',
    request: { params: 'zSpaceParams', query: 'zSourceStreamListQuery' },
    responses: { 200: { schema: 'zSourceStreamListResponse', type: 'application/json', desc: 'Streams' } },
  },
  {
    method: 'delete',
    path: '/v1/spaces/{space}/source-streams/{external_source_id}',
    scope: 'knowledge:propose',
    summary: 'Tombstone a source stream (idempotent soft delete — the upstream document is gone)',
    handler: 'tombstoneSourceStreamHandler',
    request: { params: 'zSourceStreamParams' },
    responses: {
      200: { schema: 'zSourceStreamTombstoneResponse', type: 'application/json', desc: 'Tombstoned (idempotent)' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/decisions',
    scope: 'knowledge:read',
    summary: 'List decisions (active/superseded), newest first — the decision log',
    handler: 'listDecisionsHandler',
    request: { params: 'zSpaceParams', query: 'zListQuery' },
    responses: { 200: { schema: 'zDecisionListResponse', type: 'application/json', desc: 'Decisions' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/decisions/{slug}',
    scope: 'knowledge:read',
    summary: 'Read one decision: context, decision, rationale, rejected alternatives',
    handler: 'getDecisionHandler',
    request: { params: 'zDecisionParams' },
    responses: { 200: { schema: 'zDecisionResponse', type: 'application/json', desc: 'Decision' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/concepts',
    scope: 'knowledge:read',
    summary:
      'List concepts with an evidence summary per page (visible claims, uncited claims, distinct sources; absent on a reference-target page, which holds no knowledge to measure — absent is never zero) — keyset pagination via ?after=; ETag over the space epoch, 304 on If-None-Match',
    handler: 'listConceptsHandler',
    request: { params: 'zSpaceParams', query: 'zListQuery' },
    responses: {
      200: { schema: 'zConceptListResponse', type: 'application/json', desc: 'Concepts page (ETag: "<epoch>")' },
      304: { type: 'application/json', desc: 'Not modified (If-None-Match matched the space epoch)' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/concepts/{slug}',
    scope: 'knowledge:read',
    summary: 'Read a concept: markdown + claims + citations + relations',
    handler: 'getConceptHandler',
    request: { params: 'zConceptParams' },
    responses: { 200: { schema: 'zConceptResponse', type: 'application/json', desc: 'Concept' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/concepts/{slug}/history',
    scope: 'knowledge:read',
    summary: 'Revision history incl. agent_meta (model, prompt version, sources)',
    handler: 'getConceptHistoryHandler',
    request: { params: 'zConceptParams' },
    responses: { 200: { schema: 'zConceptHistoryResponse', type: 'application/json', desc: 'Revisions' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/concepts/{slug}/neighbors',
    scope: 'knowledge:read',
    summary:
      'The pages around this one: typed relations in BOTH directions (inbound is the backlink surface the concept read never had) plus same-space concepts quoting the same archived sources, ranked by shared-source count. LLM-free.',
    handler: 'conceptNeighborsHandler',
    request: { params: 'zConceptParams' },
    responses: {
      200: { schema: 'zConceptNeighborsResponse', type: 'application/json', desc: 'Concept neighborhood' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/deleted-concepts',
    scope: 'knowledge:read',
    summary: 'List deleted concept tombstones for audit and restoration',
    handler: 'listDeletedConceptsHandler',
    request: { params: 'zSpaceParams', query: 'zListQuery' },
    responses: { 200: { schema: 'zDeletedConceptListResponse', type: 'application/json', desc: 'Deleted concepts' } },
  },
  {
    method: 'delete',
    path: '/v1/spaces/{space}/concepts/{slug}',
    scope: 'knowledge:propose',
    summary: 'Stage deletion of a concept page for human review; history and evidence are retained',
    handler: 'deleteConceptHandler',
    request: { params: 'zConceptParams' },
    responses: {
      202: { schema: 'zConceptLifecycleResponse', type: 'application/json', desc: 'Deletion staged for review' },
    },
  },
  {
    method: 'post',
    path: '/v1/spaces/{space}/concepts/{slug}/restore',
    scope: 'knowledge:propose',
    summary: 'Stage restoration of a deleted concept’s last visible revision for human review',
    handler: 'restoreConceptHandler',
    request: { params: 'zConceptParams' },
    responses: {
      202: { schema: 'zConceptLifecycleResponse', type: 'application/json', desc: 'Restoration staged for review' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/search',
    scope: 'knowledge:read',
    summary:
      'LLM-free full-text search; ranked hits with <mark> headlines. Concept hits carry the same evidence summary (visible claims, uncited claims, distinct sources) the concept list serves; claim and source-chunk hits do not',
    handler: 'searchHandler',
    request: { params: 'zSpaceParams', query: 'zSearchQuery' },
    responses: { 200: { schema: 'zSearchResponse', type: 'application/json', desc: 'Ranked hits' } },
  },
  {
    method: 'post',
    path: '/v1/spaces/{space}/query',
    scope: 'knowledge:read',
    summary: 'Grounded Q&A with inline citations (LLM; 503 llm_not_configured without a key)',
    handler: 'queryHandler',
    request: { params: 'zSpaceParams', body: 'zQueryRequest' },
    responses: {
      200: { schema: 'zQueryResponse', type: 'application/json', desc: 'Cited answer' },
      503: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'llm_not_configured' },
    },
  },
  // Outputs — the fourth place: what the wiki produced, and the door back in.
  // There is deliberately NO DELETE. Retention collects unpromoted rows
  // (WIKIKIT_OUTPUT_RETENTION_DAYS) and a promoted one is provenance for a source
  // that exists forever, so nothing is left for a manual delete to accomplish —
  // and no scope fits it: `knowledge:propose` would let anything that can write a
  // proposal erase the record of an answer, while `admin` is credential-level
  // authority for what would be a routine tidy-up.
  {
    method: 'get',
    path: '/v1/spaces/{space}/outputs',
    scope: 'knowledge:read',
    summary:
      'List produced outputs newest-first — answers, scheduled briefings and health reports (?kind=answer|briefing|health, ?limit=, ?cursor=). Rows carry the full markdown.',
    handler: 'listOutputsHandler',
    request: { params: 'zSpaceParams', query: 'zOutputListQuery' },
    responses: { 200: { schema: 'zOutputListResponse', type: 'application/json', desc: 'Outputs page' } },
  },
  {
    method: 'get',
    path: '/v1/outputs/{id}',
    scope: 'knowledge:read',
    summary:
      'Read one output. Accept: text/markdown returns the document that promotion would archive — title, question, answer, cited pages.',
    handler: 'getOutputHandler',
    request: { params: 'zIdParams' },
    responses: {
      200: { schema: 'zOutputResponse', type: 'application/json', desc: 'Output (or text/markdown via Accept)' },
    },
  },
  {
    method: 'post',
    path: '/v1/outputs/{id}/promote',
    scope: 'knowledge:propose',
    summary:
      'Promote an output back into the wiki: its markdown is archived as a source marked derived_from_output_id and runs the ORDINARY ingest pipeline, so a human still reviews the proposal. Idempotent — a second promote returns the first job.',
    handler: 'promoteOutputHandler',
    request: { params: 'zIdParams' },
    responses: {
      202: {
        schema: 'zOutputPromotedResponse',
        type: 'application/json',
        desc: 'Queued (or the job an earlier promote of this row created); poll /v1/ingests/{id}',
      },
      409: {
        schema: 'zErrorEnvelope',
        type: 'application/json',
        desc: 'already_ingested — this exact text is archived under another source (envelope carries source_id); the output stays unpromoted',
      },
      429: {
        schema: 'zErrorEnvelope',
        type: 'application/json',
        desc: 'ingest_queue_full — the queue is at its per-space ceiling; nothing was queued and the output stays unpromoted',
      },
      503: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'llm_not_configured' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/health',
    scope: 'knowledge:read',
    summary:
      'Composed maintenance report — the lint findings, the coverage block and the two live queues (review + ingest, parked thoughts included) in one LLM-free read. No verdict: the counts are the answer (?from=, ?to=, ?top=, ?tier=quick|deep; window defaults to the last 30 days, tier to deep).',
    handler: 'spaceHealthHandler',
    request: { params: 'zSpaceParams', query: 'zSpaceHealthQuery' },
    responses: {
      200: { schema: 'zSpaceHealthResponse', type: 'application/json', desc: 'Space health' },
      400: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'Invalid window (to must be after from)' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/attention',
    scope: 'knowledge:read',
    summary: 'Aggregate actual human decisions across proposals, captured inbox items and unfiled outputs',
    handler: 'attentionHandler',
    request: { params: 'zSpaceParams', query: 'zAttentionQuery' },
    responses: { 200: { schema: 'zAttentionResponse', type: 'application/json', desc: 'Attention queue' } },
  },
  {
    method: 'put',
    path: '/v1/spaces/{space}/attention/{key}',
    scope: 'knowledge:propose',
    summary: 'Set an operator-only attention state without changing the underlying knowledge object',
    handler: 'setAttentionHandler',
    request: { params: 'zAttentionParams', body: 'zAttentionStateRequest' },
    responses: { 204: { type: 'application/json', desc: 'Attention state updated' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/schedules',
    scope: 'admin',
    summary: 'Read the recurring briefing/health schedules of this space (at most one per kind)',
    handler: 'getSchedulesHandler',
    request: { params: 'zSpaceParams' },
    responses: { 200: { schema: 'zScheduleListResponse', type: 'application/json', desc: 'Schedules' } },
  },
  {
    method: 'put',
    path: '/v1/spaces/{space}/schedules',
    scope: 'admin',
    summary:
      'Replace the COMPLETE schedule set (daily at HH:MM, or weekly on a weekday, in an IANA timezone). A kind left out of the body is removed — hence no DELETE route. Idempotent.',
    handler: 'putSchedulesHandler',
    request: { params: 'zSpaceParams', body: 'zScheduleSetRequest' },
    responses: {
      200: { schema: 'zScheduleListResponse', type: 'application/json', desc: 'Schedules after the write' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/proposals',
    scope: 'knowledge:read',
    altScopes: ['knowledge:review'],
    summary: 'List change proposals (?status=pending); knowledge:review keys may inspect too',
    handler: 'listProposalsHandler',
    request: { params: 'zSpaceParams', query: 'zProposalListQuery' },
    responses: { 200: { schema: 'zProposalListResponse', type: 'application/json', desc: 'Proposals' } },
  },
  {
    method: 'post',
    path: '/v1/spaces/{space}/proposals',
    scope: 'knowledge:propose',
    summary:
      'Stage a manual change proposal, including removals of active relations (agent-authored changes go through the same review gate)',
    handler: 'createProposalHandler',
    request: { params: 'zSpaceParams', body: 'zCreateProposalRequest' },
    responses: { 201: { schema: 'zProposalCreatedResponse', type: 'application/json', desc: 'Proposal staged' } },
  },
  {
    method: 'get',
    path: '/v1/proposals/{id}',
    scope: 'knowledge:read',
    altScopes: ['knowledge:review'],
    summary:
      'Structured proposal diff (old/new markdown, claims added/disputed/deprecated, relations added/removed); text/markdown via Accept; knowledge:review keys may inspect too',
    handler: 'getProposalHandler',
    request: { params: 'zIdParams' },
    responses: {
      200: { schema: 'zProposalDetailResponse', type: 'application/json', desc: 'Diff (or text/markdown via Accept)' },
    },
  },
  {
    method: 'post',
    path: '/v1/proposals/{id}/approve',
    scope: 'knowledge:approve',
    summary: 'Approve a pending proposal (atomic wk_apply_proposal)',
    handler: 'approveProposalHandler',
    request: { params: 'zIdParams', body: 'zReviewRequest' },
    responses: {
      200: { schema: 'zProposalReviewResponse', type: 'application/json', desc: 'Applied' },
      409: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'proposal_not_pending | stale_base' },
    },
  },
  {
    method: 'post',
    path: '/v1/proposals/{id}/reject',
    scope: 'knowledge:approve',
    summary: 'Reject a pending proposal (staged rows kept for audit, marked rejected)',
    handler: 'rejectProposalHandler',
    request: { params: 'zIdParams', body: 'zReviewRequest' },
    responses: {
      200: { schema: 'zProposalReviewResponse', type: 'application/json', desc: 'Rejected' },
      409: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'proposal_not_pending' },
    },
  },
  {
    method: 'post',
    path: '/v1/proposals/{id}/split',
    scope: 'knowledge:review',
    summary: 'Split a pending proposal: full per-concept split, or defer a subset into one child',
    handler: 'splitProposalHandler',
    request: { params: 'zIdParams', body: 'zSplitProposalRequest' },
    responses: {
      200: { schema: 'zProposalSplitResponse', type: 'application/json', desc: 'Parent + pending children' },
      409: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'proposal_not_pending' },
    },
  },
  {
    method: 'post',
    path: '/v1/proposals/{id}/request-changes',
    scope: 'knowledge:review',
    summary: 'Terminal reject with a mandatory revision note — agents re-propose against the feedback',
    handler: 'requestChangesHandler',
    request: { params: 'zIdParams', body: 'zRequestChangesRequest' },
    responses: {
      200: { schema: 'zRequestChangesResponse', type: 'application/json', desc: 'Rejected with changes_requested' },
      409: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'proposal_not_pending' },
    },
  },
  {
    method: 'get',
    path: '/v1/proposals/{id}/lint',
    scope: 'knowledge:read',
    altScopes: ['knowledge:review'],
    summary: 'Lint the STAGED content of one proposal (uncited claims, collisions, stale base, dangling links)',
    handler: 'lintProposalHandler',
    request: { params: 'zIdParams' },
    responses: { 200: { schema: 'zProposalLintResponse', type: 'application/json', desc: 'Findings + counts' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/lint',
    scope: 'knowledge:read',
    summary:
      'Knowledge health findings (contradictions, missing citations, ...) — LLM-free, CI-friendly. ?tier=quick runs only the queue/inbox/charter pulse rules; the default deep runs everything',
    handler: 'lintHandler',
    request: { params: 'zSpaceParams', query: 'zLintQuery' },
    responses: { 200: { schema: 'zLintResponse', type: 'application/json', desc: 'Findings + counts' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/export',
    scope: 'knowledge:read',
    summary:
      'Export the space as a zip bundle (?format=md|okf|obsidian; obsidian is a serialize-only vault mirror without sources/ or log.md) — strong ETag over the zip bytes, 304 on If-None-Match',
    handler: 'exportHandler',
    request: { params: 'zSpaceParams', query: 'zExportQuery' },
    responses: {
      200: {
        type: 'application/zip',
        desc: 'Zip stream (markdown tree, OKF bundle or vault mirror; ETag: "<sha256 of the zip bytes>")',
      },
      304: { type: 'application/zip', desc: 'Not modified (If-None-Match matched the export bytes)' },
    },
  },
  {
    method: 'post',
    path: '/v1/spaces/{space}/import',
    scope: 'knowledge:propose',
    summary: 'Import a bundle (zip, ?format=md|okf): sources archived directly, knowledge staged as ONE proposal',
    handler: 'importHandler',
    request: { params: 'zSpaceParams', query: 'zImportQuery' },
    rawBody: true,
    responses: {
      202: { schema: 'zProposalCreatedResponse', type: 'application/json', desc: 'Proposal staged for review' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/webhooks',
    scope: 'admin',
    summary: 'List webhook endpoints',
    handler: 'listWebhooksHandler',
    request: { params: 'zSpaceParams' },
    responses: { 200: { schema: 'zWebhookListResponse', type: 'application/json', desc: 'Endpoints' } },
  },
  {
    method: 'post',
    path: '/v1/spaces/{space}/webhooks',
    scope: 'admin',
    summary: 'Register a webhook endpoint (Standard Webhooks; secret shown once)',
    handler: 'createWebhookHandler',
    request: { params: 'zSpaceParams', body: 'zCreateWebhookRequest' },
    responses: { 201: { schema: 'zWebhookResponse', type: 'application/json', desc: 'Endpoint + one-time secret' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/webhooks/{id}/deliveries',
    scope: 'admin',
    summary: 'Delivery attempts for one endpoint (status, attempts, backoff; newest first, `?limit=` up to 200)',
    handler: 'listWebhookDeliveriesHandler',
    request: { params: 'zSpaceIdParams', query: 'zDeliveryListQuery' },
    responses: { 200: { schema: 'zDeliveryListResponse', type: 'application/json', desc: 'Deliveries' } },
  },
  {
    method: 'get',
    path: '/v1/api-keys',
    scope: 'admin',
    summary: 'List API keys and revocation/usage metadata (never plaintext or hashes)',
    handler: 'listApiKeysHandler',
    responses: { 200: { schema: 'zApiKeyListResponse', type: 'application/json', desc: 'Keys visible to this admin' } },
  },
  {
    method: 'post',
    path: '/v1/api-keys',
    scope: 'admin',
    summary: 'Mint a scoped API key (plaintext shown once)',
    handler: 'createApiKeyHandler',
    request: { body: 'zCreateApiKeyRequest' },
    responses: { 201: { schema: 'zApiKeyCreatedResponse', type: 'application/json', desc: 'Key (shown once)' } },
  },
  {
    method: 'delete',
    path: '/v1/api-keys/{id}',
    scope: 'admin',
    summary: 'Revoke an API key (idempotent; bootstrap env key is not a DB key)',
    handler: 'revokeApiKeyHandler',
    request: { params: 'zIdParams' },
    responses: { 200: { schema: 'zApiKeyRevokedResponse', type: 'application/json', desc: 'Revocation timestamp' } },
  },
  {
    method: 'get',
    path: '/v1/identities',
    scope: 'admin',
    summary: 'List SSO identity grants (scope ceiling, source, revocation) — never tokens or hashes',
    handler: 'listIdentitiesHandler',
    responses: { 200: { schema: 'zIdentityListResponse', type: 'application/json', desc: 'Identity grants' } },
  },
  {
    method: 'put',
    path: '/v1/identities/{provider}/{subject}',
    scope: 'admin',
    summary:
      'Create or update an SSO identity grant (role XOR scopes; the stored scope ceiling is the single AuthZ truth, effective immediately). Only restore:true clears a revocation; an omitted field is kept, and email:null clears the stored address — but only until the next SSO login, which mirrors the provider’s asserted address back into the row. Erasure that lasts means clearing the address and then revoking the grant (a revoked row denies login, so nothing rewrites it), or removing the person at the identity provider.',
    handler: 'upsertIdentityHandler',
    request: { params: 'zIdentityParams', body: 'zUpsertIdentityRequest' },
    responses: {
      200: { schema: 'zIdentityResponse', type: 'application/json', desc: 'Grant updated' },
      201: { schema: 'zIdentityResponse', type: 'application/json', desc: 'Grant created' },
      409: {
        schema: 'zErrorEnvelope',
        type: 'application/json',
        desc: 'identity_revoked (PUT on a revoked grant without restore:true)',
      },
      422: {
        schema: 'zErrorEnvelope',
        type: 'application/json',
        desc: 'unprocessable (role AND scopes | neither on a new grant | unknown oidc provider | update would strip the stored ceiling to NULL and lock the identity out)',
      },
    },
  },
  {
    method: 'delete',
    path: '/v1/identities/{provider}/{subject}',
    scope: 'admin',
    summary:
      'Revoke an SSO identity grant: denies future logins AND kills its live OAuth tokens and its SSO-minted API keys (idempotent; only an explicit restore over PUT re-admits)',
    handler: 'revokeIdentityHandler',
    request: { params: 'zIdentityParams' },
    responses: {
      200: { schema: 'zIdentityRevokedResponse', type: 'application/json', desc: 'Revocation timestamp (idempotent)' },
    },
  },
  {
    method: 'get',
    path: '/v1/installation/knowledge-config',
    scope: 'admin',
    summary:
      "Report this installation's effective knowledge-shaping configuration and the provenance of every value (built-in vs configured) — never secrets or anything derived from one",
    handler: 'knowledgeConfigHandler',
    responses: {
      200: {
        schema: 'zKnowledgeConfigResponse',
        type: 'application/json',
        desc: 'Effective knowledge-shaping configuration with per-value provenance',
      },
    },
  },
  {
    method: 'get',
    // Global on purpose, and NEVER a literal under /v1/spaces/ (first-match
    // routing would shadow the {space} segment). /v1/stats/mcp set the
    // namespace precedent; this is deliberately its first knowledge:read
    // route — an overview of the wikis a key may see is a read, not an
    // admin act, and a space-scoped key gets its one-row overview.
    path: '/v1/stats/overview',
    scope: 'knowledge:read',
    summary:
      'Cross-wiki overview: per visible space the actual human decisions, their kinds, the age of the oldest, purpose, environment and visible page count — plus server-side totals. Findings are observations and are excluded.',
    handler: 'spacesOverviewHandler',
    responses: {
      200: { schema: 'zSpacesOverviewResponse', type: 'application/json', desc: 'Overview of every visible space' },
    },
  },
  {
    method: 'get',
    path: '/v1/stats/mcp',
    scope: 'admin',
    summary: 'Global privacy-safe MCP sessions, protocol operations, tools, outcomes and latency',
    handler: 'mcpUsageStatsHandler',
    request: { query: 'zUsageStatsQuery' },
    responses: {
      200: { schema: 'zUsageStatsResponse', type: 'application/json', desc: 'Global MCP usage statistics' },
      400: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'Invalid usage statistics query' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/stats/http',
    scope: 'knowledge:read',
    summary: 'Privacy-safe HTTP requests, outcomes, exact-window adoption and latency',
    handler: 'httpUsageStatsHandler',
    request: { params: 'zSpaceParams', query: 'zUsageStatsQuery' },
    responses: {
      200: { schema: 'zUsageStatsResponse', type: 'application/json', desc: 'HTTP usage statistics' },
      400: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'Invalid usage statistics query' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/stats/usage',
    scope: 'knowledge:read',
    summary: 'Cross-transport search, read, query, lint, ingest and proposal usage',
    handler: 'knowledgeUsageStatsHandler',
    request: { params: 'zSpaceParams', query: 'zUsageStatsQuery' },
    responses: {
      200: { schema: 'zUsageStatsResponse', type: 'application/json', desc: 'Knowledge usage statistics' },
      400: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'Invalid usage statistics query' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/stats/coverage',
    scope: 'knowledge:read',
    summary: 'Coverage insights: disputed claims, review latency, freshness, read/link hubs, gap topics',
    handler: 'coverageStatsHandler',
    request: { params: 'zSpaceParams', query: 'zCoverageStatsQuery' },
    responses: {
      200: { schema: 'zCoverageStatsResponse', type: 'application/json', desc: 'Coverage statistics' },
      400: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'Invalid coverage statistics query' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/stats/reviews',
    scope: 'knowledge:read',
    summary: 'Cross-transport proposal inspection and human review behavior',
    handler: 'reviewUsageStatsHandler',
    request: { params: 'zSpaceParams', query: 'zUsageStatsQuery' },
    responses: {
      200: { schema: 'zUsageStatsResponse', type: 'application/json', desc: 'Review usage statistics' },
      400: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'Invalid usage statistics query' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/stats/ingests',
    scope: 'knowledge:read',
    summary: 'Time-bucketed ingest volume, outcomes and processing duration',
    handler: 'ingestStatsHandler',
    request: { params: 'zSpaceParams', query: 'zStatsQuery' },
    responses: {
      200: { schema: 'zIngestStatsResponse', type: 'application/json', desc: 'Ingest statistics' },
      400: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'Invalid or excessive time window' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/stats/knowledge',
    scope: 'knowledge:read',
    summary: 'Time-bucketed growth and review activity for the knowledge graph',
    handler: 'knowledgeStatsHandler',
    request: { params: 'zSpaceParams', query: 'zStatsQuery' },
    responses: {
      200: { schema: 'zKnowledgeStatsResponse', type: 'application/json', desc: 'Knowledge statistics' },
      400: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'Invalid or excessive time window' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/stats/llm',
    scope: 'knowledge:read',
    summary: 'Time-bucketed LLM calls, token usage and duration from the audit ledger',
    handler: 'llmStatsHandler',
    request: { params: 'zSpaceParams', query: 'zStatsQuery' },
    responses: {
      200: { schema: 'zLlmStatsResponse', type: 'application/json', desc: 'LLM statistics' },
      400: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'Invalid or excessive time window' },
    },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/stats/webhooks',
    scope: 'knowledge:read',
    summary: 'Time-bucketed webhook events and delivery outcomes',
    handler: 'webhookStatsHandler',
    request: { params: 'zSpaceParams', query: 'zStatsQuery' },
    responses: {
      200: { schema: 'zWebhookStatsResponse', type: 'application/json', desc: 'Webhook statistics' },
      400: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'Invalid or excessive time window' },
    },
  },
  {
    method: 'get',
    path: '/health',
    scope: null,
    summary: 'Liveness probe (process is up)',
    handler: 'healthHandler',
    responses: { 200: { type: 'text/plain', desc: 'Always "ok" while the process lives' } },
  },
  {
    method: 'get',
    path: '/ready',
    scope: null,
    summary: 'Readiness probe — {status, version}; the deploy health gate matches BOTH fields',
    handler: 'readyHandler',
    responses: {
      200: { schema: 'zReadyResponse', type: 'application/json', desc: 'Ready' },
      503: { schema: 'zReadyResponse', type: 'application/json', desc: 'Draining (graceful shutdown in progress)' },
    },
  },
  {
    method: 'get',
    path: '/metrics',
    scope: null,
    summary: 'Prometheus metrics',
    handler: 'metricsHandler',
    responses: { 200: { type: 'text/plain', desc: 'Prometheus text exposition' } },
  },
  {
    method: 'get',
    path: '/.well-known/service-descriptor.json',
    scope: null,
    summary:
      'One cheap GET that fingerprints every self-description artifact — version plus a sha256 per document, so a watcher can tell "unchanged" from "changed" without downloading any of them.',
    handler: 'serviceDescriptorHandler',
    responses: { 200: { type: 'application/json', desc: 'Service descriptor' } },
  },
  {
    method: 'get',
    path: '/openapi.json',
    scope: null,
    summary: 'This OpenAPI 3.1 document (generated live from the ROUTES registry)',
    handler: 'openapiHandler',
    responses: { 200: { type: 'application/json', desc: 'OpenAPI 3.1 spec' } },
  },
  {
    method: 'get',
    path: '/review/{id}',
    scope: null,
    summary:
      'Human review page for one ChangeProposal — the out-of-band surface for MCP clients without form elicitation. Public content-free shell; the proposal itself loads with the reviewer’s own credential.',
    handler: 'reviewPageHandler',
    request: { params: 'zIdParams' },
    responses: { 200: { type: 'text/html', desc: 'Self-contained review page' } },
  },
  {
    method: 'get',
    path: '/agent-guide.md',
    scope: null,
    summary: 'Built-in system knowledge and no-CLI MCP client setup for AI agents',
    handler: 'agentGuideHandler',
    responses: { 200: { type: 'text/markdown', desc: 'WikiKit agent operating and installation guide' } },
  },
  {
    method: 'get',
    path: '/llms.txt',
    scope: null,
    summary: 'LLM docs index (llmstxt.org format)',
    handler: 'llmsTxtHandler',
    responses: { 200: { type: 'text/plain', desc: 'Markdown index of the documentation' } },
  },
  {
    method: 'get',
    path: '/llms-full.txt',
    scope: null,
    summary: 'Full LLM documentation in one file',
    handler: 'llmsFullTxtHandler',
    responses: { 200: { type: 'text/plain', desc: 'Complete documentation' } },
  },
  {
    method: 'get',
    path: '/.well-known/llms.txt',
    scope: null,
    summary: 'Well-known alias of the LLM docs index',
    handler: 'llmsTxtHandler',
    responses: { 200: { type: 'text/plain', desc: 'Markdown index of the documentation' } },
  },
  {
    method: 'get',
    path: '/.well-known/llms-full.txt',
    scope: null,
    summary: 'Well-known alias of the full LLM documentation',
    handler: 'llmsFullTxtHandler',
    responses: { 200: { type: 'text/plain', desc: 'Complete documentation' } },
  },
  {
    method: 'get',
    path: '/install.sh',
    scope: null,
    summary:
      'Coding-agent hooks installer (macOS/Linux) — `curl -fsSL <host>/install.sh | sh` wires the lifecycle hooks into Claude Code, Codex and Cursor. Unrelated to the repository’s git pre-push hooks.',
    handler: 'installShHandler',
    responses: { 200: { type: 'text/plain', desc: 'POSIX sh installer, base URL pre-resolved to this server' } },
  },
  {
    method: 'get',
    path: '/install.ps1',
    scope: null,
    summary:
      'Coding-agent hooks installer (Windows) — `powershell -ExecutionPolicy Bypass -c "irm <host>/install.ps1 | iex"`.',
    handler: 'installPs1Handler',
    responses: { 200: { type: 'text/plain', desc: 'PowerShell 5.1 installer, base URL pre-resolved to this server' } },
  },
  {
    method: 'get',
    path: '/install/hooks/{script}',
    scope: null,
    summary:
      'One agent lifecycle hook script (closed set: wikikit-briefing/context/capture as .sh and .ps1) — downloaded by the installers, individually inspectable.',
    handler: 'installHookScriptHandler',
    request: { params: 'zInstallHookScriptParams' },
    responses: { 200: { type: 'text/plain', desc: 'Hook script source' } },
  },
]

// ---------------------------------------------------------------------------
// Handler plumbing
// ---------------------------------------------------------------------------

export interface HttpDeps {
  config: Config
  logger: Logger
  db: Db
  auth: Auth
  llm: LlmProvider
  ingest: IngestPipeline
  metrics: Metrics
  usage: UsageTelemetry
  state: { draining: boolean }
  /** pgvector capability (start()-time probe); gates the hybrid search arms. */
  vector?: { available: boolean }
  /** MCP URL-elicitation bridge (app.ts wiring): terminal reviews fire the
   *  pending notifications/elicitation/complete for the proposal. Best-effort;
   *  wikikit_proposals polling stays the durable path. */
  reviewElicitations?: { complete(proposalId: string): Promise<void> }
  /**
   * Browser operator-session resolver (app.ts wiring, from the OAuth mount).
   * Consulted ONLY when a scoped route arrives with no Authorization and no
   * X-API-Key header — that is, from the cockpit on this same origin. A header
   * credential always wins, so no existing client's 401/403 changes shape.
   * Absent in tests that build HttpDeps by hand: then there is no cookie plane
   * and every scoped route needs a header, exactly as before.
   */
  sessionAuth?: {
    authenticateSession(req: IncomingMessage, enforceOrigin: boolean): Promise<Principal | null>
  }
}

export interface HandlerInput {
  requestId: string
  /** null only on public routes (scope: null). */
  principal: Principal | null
  params: Record<string, string>
  query: Record<string, unknown>
  body: unknown
  req: IncomingMessage
  res: ServerResponse
}

export interface HandlerResult {
  status: number
  /** JSON-serialized unless `text` is set. */
  body?: unknown
  text?: string
  headers?: Record<string, string>
}

/** Return a result for the server to send, or undefined after writing to res directly (streams, 304). */
export type Handler = (deps: HttpDeps, input: HandlerInput) => Promise<HandlerResult | undefined>

/**
 * Resolve the {space} slug and enforce the space-level scope check in one
 * step — every space-scoped handler starts here, so a query that forgets the
 * space filter cannot even be written.
 */
async function resolveSpace(deps: HttpDeps, input: HandlerInput, scope: Scope | readonly Scope[]): Promise<Space> {
  const space = await getSpaceBySlug(deps.db, input.params.space!)
  deps.auth.requireScope(input.principal!, scope, space.id)
  markUsageContext(input.req, { spaceId: space.id })
  return space
}

/**
 * Global-by-id lookups (§4 ⚠): the proposal/job row carries its space_id;
 * the transport enforces the key/space match against it here.
 */
function requireSpaceAccess(
  deps: HttpDeps,
  input: HandlerInput,
  scope: Scope | readonly Scope[],
  spaceId: string,
): void {
  deps.auth.requireScope(input.principal!, scope, spaceId)
  markUsageContext(input.req, { spaceId })
}

/** The §1.14 stamp for human/agent-authored proposals. */
const MANUAL_AGENT_META = { model: 'manual', prompt_version: 'manual' }

/**
 * A title for the Output an answer becomes — derived from the question, because a
 * question IS what that row is about and inventing a summary would need the LLM
 * call the plan explicitly does not make.
 *
 * The transport does this and the domain does not, deliberately: `question`
 * accepts 2000 characters while `title` accepts 500, so SOMEBODY has to shorten,
 * and a domain function that silently truncated would be guessing on behalf of
 * every caller (the scheduler's briefings pass a real title and must keep it
 * verbatim). Whitespace is collapsed so a pasted multi-line question does not
 * become a multi-line title, and an over-long one is cut on a word boundary with
 * an ellipsis — the full text stays in `question`, one field away.
 */
function deriveOutputTitle(question: string): string {
  const collapsed = question.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= 500) return collapsed
  const cut = collapsed.slice(0, 499)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 400 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// SSO identity grants (wk_oauth_identities is the single AuthZ truth — 0028)
// ---------------------------------------------------------------------------

interface IdentityRow {
  provider: string
  subject: string
  email: string | null
  display_name: string
  /** NOT NULL since 0030 — the stored array IS the ceiling. */
  allowed_scopes: string[]
  grant_source: string
  created_at: Date | string
  last_seen_at: Date | string | null
  revoked_at: Date | string | null
}

const IDENTITY_FIELDS = `provider, provider_subject AS subject, email, display_name, allowed_scopes,
              grant_source, created_at, last_seen_at, revoked_at`

function toIdentityWire(row: IdentityRow): Record<string, unknown> {
  const wireDate = (value: Date | string | null): string | null => (value === null ? null : isoString(value))
  return {
    provider: row.provider,
    subject: row.subject,
    email: row.email,
    display_name: row.display_name,
    allowed_scopes: row.allowed_scopes,
    grant_source: row.grant_source,
    created_at: isoString(row.created_at),
    last_seen_at: wireDate(row.last_seen_at),
    revoked_at: wireDate(row.revoked_at),
  }
}

/** Identity grants are deployment-global operations — a space-scoped admin
 *  key must not manage who can log in anywhere (same self-escalation logic
 *  as space creation). */
function requireGlobalIdentityAdmin(principal: Principal): void {
  if (principal.spaceId) throw new ForbiddenError('a space-scoped key cannot manage identity grants')
}

// ---------------------------------------------------------------------------
// Handlers (name → implementation; drift-tested against ROUTES)
// ---------------------------------------------------------------------------

export const HANDLERS: Record<string, Handler> = {
  async listSpacesHandler(deps, input) {
    const spaces = await listSpaces(deps.db)
    const visible = input.principal!.spaceId ? spaces.filter((space) => space.id === input.principal!.spaceId) : spaces
    return { status: 200, body: { items: visible } }
  },

  async createSpaceHandler(deps, input) {
    // §5.2: a space-scoped key may only touch ITS space — creating new global
    // spaces is exactly the privilege a delegated key must not have. Mirrors
    // the self-escalation guard in createApiKeyHandler.
    if (input.principal!.spaceId) {
      throw new ForbiddenError('a space-scoped key cannot create spaces')
    }
    const body = input.body as { slug: string; name: string; settings?: Record<string, unknown> }
    const space = await createSpace(deps.db, body, deps.config.defaultBriefing, deps.logger)
    return { status: 201, body: space }
  },

  async getSpaceHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    return { status: 200, body: space }
  },

  async updateSpaceSettingsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'admin')
    const updated = await updateSpaceSettings(
      deps.db,
      space,
      input.body as { settings: Record<string, unknown>; replace: boolean },
    )
    // A changed language means every stored search_vector was stemmed under
    // the old configuration — recompute them now. Idempotent, so a crash
    // between the settings write and the reindex heals on the next settings
    // write (or a manual wk_reindex_space call).
    const effectiveLanguage = (settings: Record<string, unknown>) =>
      typeof settings.language === 'string' ? settings.language : 'en'
    if (effectiveLanguage(updated.settings) !== effectiveLanguage(space.settings)) {
      await deps.db.call('wk_reindex_space', [space.id])
    }
    return { status: 200, body: updated }
  },

  async getCharterHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const query = input.query as { rev?: number }
    const detail = await getCharter(deps.db, space.id, query.rev !== undefined ? { rev: query.rev } : {})
    // Accept negotiation: the SAME document as chat-readable markdown (the
    // virtual document), so charter-over-curl carries authored text + overview.
    const accept = String(input.req.headers.accept ?? '')
    if (/\btext\/markdown\b/.test(accept)) {
      return { status: 200, text: renderCharter(detail), headers: { 'content-type': 'text/markdown; charset=utf-8' } }
    }
    return { status: 200, body: toCharterResponse(detail) }
  },

  async charterVersionsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const items = await getCharterHistory(deps.db, space.id)
    return {
      status: 200,
      body: {
        items: items.map(({ rev, status, created_by, created_at }) => ({ rev, status, created_by, created_at })),
      },
    }
  },

  async putCharterHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'admin')
    const bytes = input.body as Uint8Array | undefined
    const raw = bytes && bytes.byteLength ? Buffer.from(bytes).toString('utf8') : ''
    // Symmetric with the GET: application/json carries { markdown }, anything
    // else is taken as the raw document body (round-trip a text/markdown GET).
    const contentType = String(input.req.headers['content-type'] ?? '')
    let markdown: string
    if (/application\/json/.test(contentType)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw || 'null')
      } catch {
        throw new ValidationError('request body is not valid JSON')
      }
      const md = (parsed as { markdown?: unknown } | null)?.markdown
      if (typeof md !== 'string') throw new ValidationError('JSON body must be { "markdown": string }')
      markdown = md
    } else {
      markdown = raw
    }
    const result = await writeCharter(
      deps.db,
      space.id,
      markdown,
      { createdBy: input.principal!.name, agentMeta: MANUAL_AGENT_META },
      {
        enqueueOverviewEdit: async (overviewMarkdown) => {
          if (overviewMarkdown.trim().length === 0) return null
          const enqueued = await deps.ingest.enqueue(deps.db, space.id, {
            markdown: overviewMarkdown,
            title: `Charter overview edit — ${space.slug}`,
            source_kind: 'note',
          })
          return 'status' in enqueued ? null : enqueued.ingest_id
        },
      },
    )
    const detail = await getCharter(deps.db, space.id)
    return { status: 200, body: { ...toCharterResponse(detail), ingest_ids: result.ingest_ids } }
  },

  async deleteCharterHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'admin')
    await deleteCharter(deps.db, space.id)
    const detail = await getCharter(deps.db, space.id)
    return { status: 200, body: toCharterResponse(detail) }
  },

  async agentBriefingHandler(deps, input) {
    const query = input.query as { spaces: string; budget_tokens?: number }
    const slugs = [
      ...new Set(
        query.spaces
          .split(',')
          .map((slug) => slug.trim())
          .filter(Boolean),
      ),
    ]
    if (slugs.length === 0 || slugs.length > 10) throw new ValidationError('spaces must name between 1 and 10 spaces')
    const spaces = []
    for (const slug of slugs) {
      const space = await getSpaceBySlug(deps.db, slug)
      deps.auth.requireScope(input.principal!, 'knowledge:read', space.id)
      spaces.push(space)
    }
    return { status: 200, body: await buildAgentBriefing(deps.db, spaces, query.budget_tokens) }
  },

  async agentContextHandler(deps, input) {
    const body = input.body as {
      prompt: string
      project_hint?: string
      primary_space?: string
      manual_spaces?: string[]
      exclude_spaces?: string[]
      max_spaces?: number
      budget_tokens?: number
    }
    const spaces = await listSpaces(deps.db)
    const visible = input.principal!.spaceId ? spaces.filter((space) => space.id === input.principal!.spaceId) : spaces
    const visibleSlugs = new Set(visible.map((space) => space.slug))
    for (const slug of [body.primary_space, ...(body.manual_spaces ?? [])].filter(Boolean) as string[]) {
      if (!visibleSlugs.has(slug)) throw new ValidationError(`space '${slug}' is not visible to this key`)
    }
    return { status: 200, body: await buildAgentContext(deps.db, visible, body) }
  },

  async createIngestHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:propose')
    const result = await deps.ingest.enqueue(deps.db, space.id, input.body as never)
    // Sync fast-path: known content under an external_source_id is a 200
    // head-advance, not a queued job — there is nothing to poll.
    if ('status' in result) return { status: 200, body: result }
    return {
      status: 202,
      body: { ingest_id: result.ingest_id, status: 'queued' as const },
      headers: { location: `/v1/ingests/${result.ingest_id}` },
    }
  },

  async ingestDocumentHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:propose')
    const query = input.query as { filename: string; source_kind?: 'meeting' | 'article' | 'note'; capture?: boolean }
    const bytes = input.body as Uint8Array
    if (!bytes || bytes.byteLength === 0) throw new ValidationError('request body must be the document bytes')
    // Extract to Markdown here (deterministic CPU work), then hand the result to
    // the SAME ingest path a pasted markdown source takes — dedup, classify,
    // synthesize, grounding all apply unchanged. The filename becomes the title.
    const doc = await extractDocument(bytes, query.filename)
    // Document uploads carry no external_source_id, so enqueue always queues
    // a job here — the narrowing is a type-level formality.
    const enqueued = await deps.ingest.enqueue(deps.db, space.id, {
      markdown: doc.markdown,
      title: doc.title,
      raw_title: query.filename,
      source_kind: query.source_kind,
      capture: query.capture,
    })
    if ('status' in enqueued) return { status: 200, body: enqueued }
    const ingest_id = enqueued.ingest_id
    return {
      status: 202,
      body: { ingest_id, status: 'queued' as const },
      headers: { location: `/v1/ingests/${ingest_id}` },
    }
  },

  async captureSessionHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:propose')
    const result = await captureSession(deps.db, space.id, { llm: deps.llm, ingest: deps.ingest }, input.body as never)
    // 200, not 202, even for `queued`: unlike ingest, the caller does not know
    // whether there is anything to poll until we answer — the status field is
    // the payload, and a SessionEnd hook must not have to branch on the code.
    return { status: 200, body: result }
  },

  async getIngestHandler(deps, input) {
    const job = await getIngestJob(deps.db, { id: input.params.id! })
    requireSpaceAccess(deps, input, 'knowledge:propose', job.space_id)
    const { space_id: _spaceId, ...wire } = job
    return { status: 200, body: wire }
  },

  async getTriageHandler(deps, input) {
    const job = await getIngestJob(deps.db, { id: input.params.id! })
    requireSpaceAccess(deps, input, 'knowledge:propose', job.space_id)
    return { status: 200, body: { suggestion: await getTriageSuggestion(deps.db, job.ingest_id) } }
  },

  async suggestTriageHandler(deps, input) {
    const job = await getIngestJob(deps.db, { id: input.params.id! })
    requireSpaceAccess(deps, input, 'knowledge:propose', job.space_id)
    const all = await listSpaces(deps.db)
    const visible = input.principal!.spaceId ? all.filter((space) => space.id === input.principal!.spaceId) : all
    const suggestion = await suggestTriage(deps.db, deps.llm, job.ingest_id, visible)
    return { status: 200, body: { suggestion } }
  },

  async resolveTriageHandler(deps, input) {
    const job = await getIngestJob(deps.db, { id: input.params.id! })
    requireSpaceAccess(deps, input, 'knowledge:propose', job.space_id)
    const all = await listSpaces(deps.db)
    const visible = input.principal!.spaceId ? all.filter((space) => space.id === input.principal!.spaceId) : all
    await resolveTriage(deps.db, deps.ingest, job.ingest_id, input.body as never, visible)
    const { space_id: _spaceId, ...wire } = await getIngestJob(deps.db, { id: job.ingest_id })
    return { status: 200, body: wire }
  },

  async listIngestsHandler(deps, input) {
    const space = await resolveSpace(deps, input, ['knowledge:read', 'knowledge:propose'])
    const query = input.query as { status?: IngestJobState; limit?: number; cursor?: string }
    // `cursor` on the wire, `before` in the domain — the same mapping the source
    // and output lists use; the cursor is opaque, so the two names never meet.
    const page = await listIngestJobs(deps.db, space.id, {
      status: query.status,
      limit: query.limit,
      before: query.cursor,
    })
    return { status: 200, body: page }
  },

  async listSourcesHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const query = input.query as { limit?: number; before?: string }
    const page = await listSources(deps.db, space.id, { limit: query.limit, before: query.before })
    return { status: 200, body: page }
  },

  async getSourceHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const source = await getSource(deps.db, space.id, { id: input.params.id! })
    return { status: 200, body: source }
  },

  async resynthesizeSourceHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:propose')
    const source = await getSource(deps.db, space.id, { id: input.params.id! })
    const sourceKind = source.metadata.source_kind
    const queued = await deps.ingest.enqueue(deps.db, space.id, {
      text: source.raw_content,
      title: source.title,
      ...(sourceKind === 'meeting' || sourceKind === 'article' || sourceKind === 'note'
        ? { source_kind: sourceKind }
        : {}),
      ...(source.language ? { language: source.language } : {}),
      resynthesize: true,
      resynthesize_source_id: source.id,
    })
    if (!('ingest_id' in queued)) throw new Error('source resynthesis did not create an ingest job')
    return { status: 202, body: { ingest_id: queued.ingest_id, status: 'queued' as const } }
  },

  async sourceReferencesHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    return {
      status: 200,
      body: await listSourceReferences(deps.db, space.id, {
        id: input.params.id!,
        limit: input.query.limit as number | undefined,
        cursor: input.query.cursor as string | undefined,
      }),
    }
  },

  async listSourceStreamsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const query = input.query as {
      external_source_id?: string
      include_deleted?: boolean
      limit?: number
      after?: string
    }
    return { status: 200, body: await listStreams(deps.db, space.id, query) }
  },

  async tombstoneSourceStreamHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:propose')
    const result = await tombstoneStream(deps.db, space.id, {
      externalSourceId: input.params.external_source_id!,
    })
    return { status: 200, body: { status: 'tombstoned' as const, ...result } }
  },

  async listDecisionsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const query = input.query as { limit?: number }
    const items = await listDecisions(deps.db, space.id, { limit: query.limit })
    return { status: 200, body: { items } }
  },

  async getDecisionHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const decision = await getDecision(deps.db, space.id, { slug: input.params.slug! })
    return { status: 200, body: decision }
  },

  async listConceptsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const query = input.query as { limit?: number; after?: string }
    const page = await listConcepts(
      deps.db,
      space.id,
      { limit: query.limit, after: query.after },
      { scaffoldingKinds: deps.config.scaffoldingKinds },
    )
    // ETag over the space epoch: the epoch bumps on
    // every approved proposal, so it is a perfect cheap validator for ANY
    // read of approved knowledge. RFC 9110 §13.1.2: If-None-Match may carry a
    // comma-separated list of entity-tags or '*' — any member matching (weak
    // comparison, so W/ prefixes are stripped per entry) means 304.
    const etag = `"${page.epoch}"`
    const inm = input.req.headers['if-none-match']
    const candidates = String(inm ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (candidates.some((entry) => entry === '*' || entry.replace(/^W\//, '') === etag)) {
      input.res.writeHead(304, { etag })
      input.res.end()
      return undefined
    }
    return { status: 200, body: page, headers: { etag } }
  },

  async getConceptHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const concept = await getConcept(deps.db, space.id, { slug: input.params.slug! })
    // Fire-and-forget read counter (coverage insights) — never fails a read.
    void recordConceptRead(deps.db, space.id, input.params.slug!).catch(() => {})
    // Explicit wire mapping shared with MCP wikikit_read (toConceptResponse):
    // ConceptDetail carries more than the §5.3 response contract — serve
    // exactly the contract, no accidental surface, on BOTH transports.
    return { status: 200, body: toConceptResponse(concept) }
  },

  async getConceptHistoryHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const revisions = await getConceptHistory(deps.db, space.id, { slug: input.params.slug! })
    return { status: 200, body: { slug: input.params.slug!, revisions } }
  },

  async conceptNeighborsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const neighbors = await conceptNeighbors(deps.db, space.id, { slug: input.params.slug! })
    // schema_version stamped at the transport, as on spaceHealthHandler: the
    // domain serves the numbers, the wire contract belongs to the route.
    return { status: 200, body: { schema_version: 'wikikit.concept-neighbors.v1', ...neighbors } }
  },

  async listDeletedConceptsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const query = input.query as { limit?: number }
    return { status: 200, body: await listDeletedConcepts(deps.db, space.id, query) }
  },

  async deleteConceptHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:propose')
    return {
      status: 202,
      body: await stageConceptLifecycle(deps.db, space.id, {
        slug: input.params.slug!,
        action: 'delete',
        actor: input.principal!.name,
      }),
    }
  },

  async restoreConceptHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:propose')
    return {
      status: 202,
      body: await stageConceptLifecycle(deps.db, space.id, {
        slug: input.params.slug!,
        action: 'restore',
        actor: input.principal!.name,
      }),
    }
  },

  async searchHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    // Spelled out field for field, and every field of zSearchQuery must be
    // here: the cast is what the search functions receive, so a field this
    // block forgets is dropped without a type error and without a 400.
    const query = input.query as {
      q: string
      kind?: 'concept' | 'claim'
      limit?: number
      mode?: 'approved_only' | 'approved_then_sources'
      include_imports?: boolean
      evidence_from?: string
      evidence_to?: string
      evidence_source_kind?: 'meeting' | 'article' | 'note'
    }
    if (query.include_imports && input.principal!.spaceId) {
      throw new ForbiddenError('this key is scoped to a single space and cannot search imported spaces')
    }
    const searchDeps = { llm: deps.llm, vector: deps.vector, scaffoldingKinds: deps.config.scaffoldingKinds }
    if (query.include_imports) {
      const result = await searchAcrossImports(deps.db, space, query, searchDeps)
      return { status: 200, body: result }
    }
    const hits = await search(deps.db, space.id, query, searchDeps)
    return {
      status: 200,
      body: { hits: hits.map((hit) => ({ ...hit, space: space.slug })), searched_spaces: [space.slug] },
    }
  },

  async queryHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    // Field for field, like the search query above and for the same reason.
    const body = input.body as {
      question: string
      top_k?: number
      mode?: 'approved_only' | 'approved_then_sources'
      evidence_from?: string
      evidence_to?: string
      evidence_source_kind?: 'meeting' | 'article' | 'note'
    }
    const answer = await answerQuestion(deps.db, space.id, deps.llm, body, {
      vector: deps.vector,
      scaffoldingKinds: deps.config.scaffoldingKinds,
    })
    // Demand-vs-coverage telemetry: an honest "the knowledge base does not
    // cover this" is a successful transport but an unanswered question — the
    // knowledge-surface usage row records it as 'no_answer'.
    if (answer.not_in_knowledge_base) {
      markUsageContext(input.req, { outcome: 'no_answer' })
      // Opt-in gap topics: store the question's stemmed lexemes, never its text.
      if (deps.config.coverageGapTopicsEnabled) {
        void recordCoverageGap(deps.db, space.id, body.question).catch(() => {})
      }
    }
    // Persist the answer as an Output — the handler, not answerQuestion, because
    // the synthesis has no business knowing whether its caller keeps the result:
    // it already returns everything the row needs, and leaving it untouched keeps
    // the LLM path free of a write it cannot roll back.
    //
    // WRITING UNDER knowledge:read is the existing audit-ledger precedent, not a
    // new liberty: every /query already writes a wk_agent_runs row and every
    // concept read writes wk_concept_reads, both under read scope. What a read
    // may not do is change KNOWLEDGE, and an output is not knowledge — it is a
    // record of what was produced, and promoting it back is a separate act under
    // knowledge:propose.
    //
    // Awaited rather than fire-and-forget (unlike recordCoverageGap above)
    // because the id is part of the answer; a failure loses the id, never the
    // answer — see zQueryResponse.output_id on why null is the honest value.
    let outputId: string | null = null
    try {
      const output = await recordOutput(deps.db, space.id, {
        kind: 'answer',
        title: deriveOutputTitle(body.question),
        question: body.question,
        markdown: answer.answer_markdown,
        citations: answer.citations,
        not_in_knowledge_base: answer.not_in_knowledge_base,
        agent_run_id: answer.agent_run_id,
      })
      outputId = output.id
    } catch (error) {
      deps.logger.warn('answer produced but not persisted as an output', {
        space: space.slug,
        agent_run_id: answer.agent_run_id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return { status: 200, body: { ...answer, output_id: outputId } }
  },

  async listOutputsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const query = input.query as { kind?: OutputKind; limit?: number; cursor?: string }
    const page = await listOutputs(deps.db, space.id, {
      kind: query.kind,
      limit: query.limit,
      before: query.cursor,
    })
    return { status: 200, body: page }
  },

  async getOutputHandler(deps, input) {
    const output = await getOutput(deps.db, input.params.id!)
    // Global-by-id (⚠ §4), exactly like getIngestHandler: the id came from
    // /query or from the list and carries no space, so the row's space_id is
    // what the key/space match is enforced against.
    requireSpaceAccess(deps, input, 'knowledge:read', output.space_id)
    const accept = String(input.req.headers.accept ?? '')
    if (/\btext\/markdown\b/.test(accept)) {
      // The promotion rendering, not the bare answer markdown: it is the whole
      // self-describing document (title, the question that was asked, the answer,
      // the pages it cited), so what a reviewer reads here is byte-for-byte what
      // promotion would archive. It is also deterministic, which a response with
      // a generated-at line would not be.
      return {
        status: 200,
        text: renderOutputSource(output),
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      }
    }
    return { status: 200, body: output }
  },

  async promoteOutputHandler(deps, input) {
    // Two reads on purpose. Authorization must happen BEFORE any write, and only
    // the row knows its space — so the space match is checked here, and
    // promoteOutput re-reads to decide against the CURRENT promotion state (the
    // read-then-write that makes a duplicate click idempotent).
    const output = await getOutput(deps.db, input.params.id!)
    requireSpaceAccess(deps, input, 'knowledge:propose', output.space_id)
    const result = await promoteOutput(deps.db, { ingest: deps.ingest }, output.id)
    return {
      status: 202,
      body: result,
      headers: { location: `/v1/ingests/${result.ingest_id}` },
    }
  },

  async spaceHealthHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const health = await spaceHealth(deps.db, space.id, input.query as SpaceHealthArgs, {
      scaffoldingKinds: deps.config.scaffoldingKinds,
      gapTopicsEnabled: deps.config.coverageGapTopicsEnabled === true,
      sourceIndexDays: deps.config.sourceIndexDays ?? DEFAULT_SOURCE_INDEX_DAYS,
    })
    // schema_version is stamped HERE and not in the domain — same division as
    // coverageStatsHandler: the wire contract belongs to the transport, and the
    // MCP tool and the scheduler consume the same numbers without one.
    return { status: 200, body: { schema_version: 'wikikit.space-health.v1', ...health } }
  },

  async attentionHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const query = input.query as { state?: AttentionState; kind?: AttentionKind; limit?: number; cursor?: string }
    return {
      status: 200,
      body: await getAttention(deps.db, space.id, query),
    }
  },

  async setAttentionHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:propose')
    const body = input.body as {
      state: 'open' | 'deferred' | 'discarded'
      remind_at?: string | null
      note?: string | null
    }
    const item = body.state === 'open' ? null : await getAttentionItem(deps.db, space.id, input.params.key!)
    await setAttentionState(deps.db, space.id, item, {
      key: input.params.key!,
      state: body.state,
      remind_at: body.remind_at,
      note: body.note,
    })
    return { status: 204 }
  },

  async spacesOverviewHandler(deps, input) {
    // The same visibility rule as listSpacesHandler: a space-scoped key gets a
    // one-row overview of its own wiki, never an error — the overview of what
    // a key may see is defined by what it may see.
    const spaces = await listSpaces(deps.db)
    const visible = input.principal!.spaceId ? spaces.filter((space) => space.id === input.principal!.spaceId) : spaces
    const overview = await spacesOverview(deps.db, visible)
    // schema_version stamped at the transport, as on spaceHealthHandler; the
    // MCP tool stamps the same literal so the two shapes stay identical.
    return { status: 200, body: { schema_version: 'wikikit.spaces-overview.v2', ...overview } }
  },

  async getSchedulesHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'admin')
    return { status: 200, body: { schedules: await listSchedules(deps.db, space.id) } }
  },

  async putSchedulesHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'admin')
    // The body was already validated against zScheduleSetRequest (which IS
    // zScheduleSet); replaceSchedules parses it again because the ingest worker's
    // rule applies here too — a domain function validates its own arguments,
    // whichever transport called it.
    return { status: 200, body: { schedules: await replaceSchedules(deps.db, space.id, input.body) } }
  },

  async listProposalsHandler(deps, input) {
    const space = await resolveSpace(deps, input, ['knowledge:read', 'knowledge:review'])
    const query = input.query as { status?: 'pending' | 'approved' | 'rejected' | 'failed'; limit?: number }
    const items = await listProposals(deps.db, space.id, query)
    return { status: 200, body: { items } }
  },

  async createProposalHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:propose')
    const body = input.body as Record<string, unknown>
    // 0023 key-visibility gate: a space-scoped key sees one space and may
    // never stage across spaces. Deterministic 403, never silent skipping.
    if (input.principal!.spaceId && stagesCrossSpaceRelations(body)) {
      throw new ForbiddenError('this key is scoped to a single space and cannot stage cross-space relations')
    }
    // Manual provenance stamp (§1.14): a proposal posted without agent_meta
    // is by definition human/agent-authored — never leave the audit blank.
    const agentMeta =
      body.agent_meta && Object.keys(body.agent_meta as Record<string, unknown>).length > 0
        ? (body.agent_meta as Record<string, unknown>)
        : MANUAL_AGENT_META
    const result = await createProposal(deps.db, space.id, { ...body, agent_meta: agentMeta } as never)
    return { status: 201, body: result }
  },

  async getProposalHandler(deps, input) {
    const detail = await getProposal(deps.db, { id: input.params.id! })
    requireSpaceAccess(deps, input, ['knowledge:read', 'knowledge:review'], detail.space_id)
    // Accept negotiation (plan §15.3): the SAME diff as chat-readable
    // markdown, so review-over-curl carries the whole decision.
    const accept = String(input.req.headers.accept ?? '')
    if (/\btext\/markdown\b/.test(accept)) {
      return {
        status: 200,
        text: renderProposalMarkdown(detail),
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      }
    }
    return { status: 200, body: toProposalWire(detail) }
  },

  async splitProposalHandler(deps, input) {
    const detail = await getProposal(deps.db, { id: input.params.id! })
    // Review scope, not approve: splitting reorganizes the review unit, it
    // publishes nothing (approve implies review, so approvers keep it).
    requireSpaceAccess(deps, input, 'knowledge:review', detail.space_id)
    const body = input.body as { concepts?: string[] } | undefined
    const result = await splitProposal(deps.db, {
      id: detail.id,
      reviewer: input.principal!.name,
      concepts: body?.concepts,
      reviewChannel: 'rest',
    })
    return { status: 200, body: result }
  },

  async requestChangesHandler(deps, input) {
    const detail = await getProposal(deps.db, { id: input.params.id! })
    requireSpaceAccess(deps, input, 'knowledge:review', detail.space_id)
    const body = input.body as { note: string; via?: 'url_elicitation' }
    const result = await requestChanges(deps.db, {
      id: detail.id,
      reviewer: input.principal!.name,
      note: body.note,
      reviewChannel: body.via === 'url_elicitation' ? 'url_elicitation' : 'rest',
    })
    void deps.reviewElicitations?.complete(detail.id)
    return { status: 200, body: result }
  },

  async lintProposalHandler(deps, input) {
    const detail = await getProposal(deps.db, { id: input.params.id! })
    requireSpaceAccess(deps, input, ['knowledge:read', 'knowledge:review'], detail.space_id)
    return { status: 200, body: await lintProposal(deps.db, detail.space_id, detail.id) }
  },

  async approveProposalHandler(deps, input) {
    const detail = await getProposal(deps.db, { id: input.params.id! })
    requireSpaceAccess(deps, input, 'knowledge:approve', detail.space_id)
    const body = input.body as { note?: string; via?: 'url_elicitation' } | undefined
    // Reviewer identity = the key's name: the audit trail names WHO approved,
    // and the key name is the only identity a headless system has.
    const result = await approveProposal(deps.db, {
      id: detail.id,
      reviewer: input.principal!.name,
      note: body?.note,
      reviewChannel: body?.via === 'url_elicitation' ? 'url_elicitation' : 'rest',
    })
    void deps.reviewElicitations?.complete(detail.id)
    return { status: 200, body: result }
  },

  async rejectProposalHandler(deps, input) {
    const detail = await getProposal(deps.db, { id: input.params.id! })
    requireSpaceAccess(deps, input, 'knowledge:approve', detail.space_id)
    const body = input.body as { note?: string; via?: 'url_elicitation' } | undefined
    const result = await rejectProposal(deps.db, {
      id: detail.id,
      reviewer: input.principal!.name,
      note: body?.note,
      reviewChannel: body?.via === 'url_elicitation' ? 'url_elicitation' : 'rest',
    })
    void deps.reviewElicitations?.complete(detail.id)
    return { status: 200, body: result }
  },

  async lintHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const { tier } = input.query as { tier: 'quick' | 'deep' }
    const report = await lintSpace(deps.db, space.id, { scaffoldingKinds: deps.config.scaffoldingKinds, tier })
    return { status: 200, body: report }
  },

  async exportHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const format = (input.query as { format: 'md' | 'okf' | 'obsidian' }).format
    const stream = await exportSpace(deps.db, space.id, { format })
    // Collect the bytes before any header goes out: exports are deterministic
    // (identical knowledge → identical zip), so sha256 over the exact bytes is
    // a STRONG validator — and unlike the space epoch it also tracks sources/
    // content, which changes without an epoch bump. The stream is single-chunk
    // by construction (see exportSpace), so collecting costs nothing extra;
    // the manual pump stays because node:http ServerResponse is not a web
    // WritableStream and Readable.fromWeb churns across runtimes.
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
    let bytes = chunks[0] ?? new Uint8Array(0)
    if (chunks.length > 1) {
      bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
    }
    const etag = `"${sha256Hex(bytes)}"`
    // RFC 9110 §13.1.2 as in listConceptsHandler: If-None-Match may carry a
    // comma-separated list of entity-tags or '*' — any member matching (weak
    // comparison, so W/ prefixes are stripped per entry) means 304.
    const inm = input.req.headers['if-none-match']
    const candidates = String(inm ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (candidates.some((entry) => entry === '*' || entry.replace(/^W\//, '') === etag)) {
      input.res.writeHead(304, { etag })
      input.res.end()
      return undefined
    }
    input.res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${space.slug}-${format}.zip"`,
      etag,
    })
    input.res.write(bytes)
    input.res.end()
    return undefined
  },

  async importHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:propose')
    const format = (input.query as { format: 'md' | 'okf' }).format
    const data = input.body as Uint8Array
    if (!data || data.byteLength === 0) throw new ValidationError('request body must be a zip bundle')
    const result = await importBundle(deps.db, space.id, { data, format })
    return {
      status: 202,
      body: { proposal_id: result.proposal_id, status: 'pending' as const, sources_created: result.sources_created },
    }
  },

  async listWebhooksHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'admin')
    const items = await listWebhookEndpoints(deps.db, space.id)
    return { status: 200, body: { items } }
  },

  async createWebhookHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'admin')
    const body = input.body as { url: string; events?: string[] }
    const { endpoint, secret } = await registerWebhookEndpoint(deps.config, deps.db, space.id, body)
    return { status: 201, body: { ...endpoint, secret } }
  },

  async listWebhookDeliveriesHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'admin')
    const query = input.query as { limit?: number }
    const items = await listWebhookDeliveries(deps.db, space.id, { endpointId: input.params.id!, limit: query.limit })
    return { status: 200, body: { items } }
  },

  async createApiKeyHandler(deps, input) {
    const body = input.body as { name: string; scopes?: string[]; role?: RoleName; space?: string }
    // Role presets expand HERE and nowhere else — the stored key carries only
    // scopes (the ground truth), the response echoes the expansion.
    const scopes = body.scopes ?? [...ROLE_SCOPES[body.role!]]
    // A space-scoped ADMIN key may only mint keys for its own space —
    // otherwise scoping would be self-escalating.
    let spaceId: string | null = null
    let spaceSlug: string | null = null
    if (body.space) {
      const space = await getSpaceBySlug(deps.db, body.space)
      spaceId = space.id
      spaceSlug = space.slug
    }
    if (input.principal!.spaceId && input.principal!.spaceId !== spaceId) {
      throw new ForbiddenError('a space-scoped key can only mint keys for its own space')
    }
    const { id, key } = await deps.auth.createKey({ name: body.name, scopes, spaceId })
    return { status: 201, body: { id, name: body.name, key, scopes, space: spaceSlug } }
  },

  async listApiKeysHandler(deps, input) {
    const scopedSpaceId = input.principal!.spaceId
    const where = scopedSpaceId ? 'WHERE k.space_id = $1' : ''
    const { rows } = await deps.db.query<{
      id: string
      name: string
      scopes: string[]
      space: string | null
      created_at: Date | string
      last_used_at: Date | string | null
      revoked_at: Date | string | null
    }>(
      `SELECT k.id, k.name, k.scopes, s.slug AS space,
              k.created_at, k.last_used_at, k.revoked_at
         FROM wk_api_keys k
         LEFT JOIN wk_spaces s ON s.id = k.space_id
         ${where}
        ORDER BY k.created_at DESC, k.id`,
      scopedSpaceId ? [scopedSpaceId] : [],
    )
    const wireDate = (value: Date | string | null) =>
      value === null ? null : value instanceof Date ? value.toISOString() : String(value)
    return {
      status: 200,
      body: {
        items: rows.map((row) => ({
          ...row,
          created_at: wireDate(row.created_at),
          last_used_at: wireDate(row.last_used_at),
          revoked_at: wireDate(row.revoked_at),
        })),
      },
    }
  },

  async revokeApiKeyHandler(deps, input) {
    const id = input.params.id!
    const [key] = await deps.db.select<{ id: string; space_id: string | null; revoked_at: Date | string | null }>(
      'wk_api_keys',
      { id: `eq.${id}`, limit: 1 },
    )
    if (!key || (input.principal!.spaceId && input.principal!.spaceId !== key.space_id)) {
      throw new NotFoundError(`API key '${id}' not found`)
    }
    const revokedAt = key.revoked_at
      ? key.revoked_at instanceof Date
        ? key.revoked_at.toISOString()
        : String(key.revoked_at)
      : new Date().toISOString()
    if (!key.revoked_at) {
      await deps.db.update('wk_api_keys', { id: `eq.${id}`, revoked_at: 'is.null' }, { revoked_at: revokedAt })
    }
    return { status: 200, body: { id, revoked_at: revokedAt } }
  },

  async listIdentitiesHandler(deps, input) {
    requireGlobalIdentityAdmin(input.principal!)
    const { rows } = await deps.db.query<IdentityRow>(
      `SELECT ${IDENTITY_FIELDS}
         FROM wk_oauth_identities
        ORDER BY provider, created_at DESC, provider_subject`,
    )
    return { status: 200, body: { items: rows.map(toIdentityWire) } }
  },

  async upsertIdentityHandler(deps, input) {
    requireGlobalIdentityAdmin(input.principal!)
    const providerId = input.params.provider!
    const subject = input.params.subject!
    // Grants only for providers this deployment actually authenticates
    // against — a typo'd provider id would otherwise create a dead row that
    // silently never matches a login.
    if (!deps.config.oauthProviders?.some((entry) => entry.protocol === 'oidc' && entry.id === providerId)) {
      throw new UnprocessableError(`'${providerId}' is not a configured oidc provider`)
    }
    const body = input.body as {
      email?: string | null
      display_name?: string
      role?: RoleName
      scopes?: string[]
      source?: 'seed'
      restore?: boolean
    }
    // Three states, not two: the key is absent (keep the stored address), the
    // key is null (clear it), or it carries a string (set it). COALESCE cannot
    // express that — it reads null as "no instruction" — so the UPDATE below
    // takes a separate boolean and `body.email ?? null` alone is not enough to
    // reconstruct the caller's intent by the time it reaches the SQL.
    const emailSupplied = 'email' in body && body.email !== undefined
    // role XOR scopes — the role shortcut is expanded HERE and never stored:
    // the scope ceiling is the only truth the auth path ever reads.
    if (body.role !== undefined && body.scopes !== undefined) {
      throw new UnprocessableError('provide exactly one of role or scopes, not both')
    }
    const scopes = body.role !== undefined ? [...ROLE_SCOPES[body.role]] : (body.scopes ?? null)
    // 'seed' may only be claimed explicitly (by the deploy seeder). A manual
    // PUT without source stamps 'admin' — from then on the seeder leaves the
    // row alone (it manages only its own 'seed' rows).
    const source = body.source === 'seed' ? 'seed' : 'admin'
    const { rows: existing } = await deps.db.query<{
      revoked_at: Date | string | null
      allowed_scopes: string[]
    }>(
      `SELECT revoked_at, allowed_scopes FROM wk_oauth_identities
        WHERE provider = $1 AND provider_subject = $2
        LIMIT 1`,
      [providerId, subject],
    )
    const current = existing[0]
    if (current?.revoked_at && body.restore !== true) {
      throw new ConflictError('identity_revoked', 'this identity grant is revoked — pass restore:true to re-admit it', {
        nextBestActions: ['re-send the PUT with restore:true to deliberately clear the revocation'],
      })
    }
    // Lockout guard: a PUT without role/scopes onto a row whose stored
    // ceiling is empty would keep that empty array (COALESCE keeps the
    // existing value) while stamping grant_source='admin'/'seed' — and an
    // empty ceiling denies every login (allowed_scopes is NOT NULL since
    // 0030; there is no allowlist inheritance to fall back on). Refuse the
    // silent lockout.
    if (current && !scopes?.length && current.allowed_scopes.length === 0) {
      throw new UnprocessableError(
        `this update would leave the grant with an empty allowed_scopes ceiling under grant_source '${source}', which denies every login — provide role or scopes`,
      )
    }
    if (!current) {
      if (!scopes) throw new UnprocessableError('a new identity grant requires role or scopes')
      const { rows } = await deps.db.query<IdentityRow>(
        `INSERT INTO wk_oauth_identities (provider, provider_subject, email, display_name, allowed_scopes, grant_source)
         VALUES ($1, $2, $3, $4, $5::text[], $6)
         RETURNING ${IDENTITY_FIELDS}`,
        [providerId, subject, body.email ?? null, body.display_name ?? '', scopes, source],
      )
      return { status: 201, body: toIdentityWire(rows[0]!) }
    }
    const { rows } = await deps.db.query<IdentityRow>(
      // `email` is the one column here whose empty is NULL, so it is the one
      // that cannot ride on COALESCE: the CASE is what lets a caller clear it.
      // The others keep COALESCE deliberately — `display_name` is NOT NULL and
      // says "empty" with '', and `allowed_scopes` has no clearing spelling at
      // all (the lockout guard above exists precisely so it can never end up
      // empty by accident).
      `UPDATE wk_oauth_identities
          SET email = CASE WHEN $3::boolean THEN $4::text ELSE email END,
              display_name = COALESCE($5, display_name),
              allowed_scopes = COALESCE($6::text[], allowed_scopes),
              grant_source = $7,
              revoked_at = CASE WHEN $8::boolean THEN NULL ELSE revoked_at END
        WHERE provider = $1 AND provider_subject = $2
        RETURNING ${IDENTITY_FIELDS}`,
      [
        providerId,
        subject,
        emailSupplied,
        body.email ?? null,
        body.display_name ?? null,
        scopes,
        source,
        body.restore === true,
      ],
    )
    return { status: 200, body: toIdentityWire(rows[0]!) }
  },

  async revokeIdentityHandler(deps, input) {
    requireGlobalIdentityAdmin(input.principal!)
    const providerId = input.params.provider!
    const subject = input.params.subject!
    const { rows } = await deps.db.query<{ revoked_at: Date | string | null }>(
      `SELECT revoked_at FROM wk_oauth_identities
        WHERE provider = $1 AND provider_subject = $2
        LIMIT 1`,
      [providerId, subject],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError(`identity '${providerId}:${subject}' not found`)
    const revokedAt = row.revoked_at ? isoString(row.revoked_at) : new Date().toISOString()
    if (!row.revoked_at) {
      await deps.db.query(
        `UPDATE wk_oauth_identities SET revoked_at = $3
          WHERE provider = $1 AND provider_subject = $2 AND revoked_at IS NULL`,
        [providerId, subject, revokedAt],
      )
    }
    // Defense in depth: identityGrantIsCurrent already denies these tokens on
    // their next request; killing them here makes the revocation absolute
    // even if that per-request check ever regresses. Runs on repeat DELETEs
    // too (idempotent) — principal_key_id format mirrors the token issuer.
    const principalKeyId = `identity:${providerId}:${subject}`
    await deps.db.query(
      `UPDATE wk_oauth_access_tokens SET revoked_at = now()
        WHERE principal_kind = 'identity' AND principal_key_id = $1 AND revoked_at IS NULL`,
      [principalKeyId],
    )
    await deps.db.query(
      `UPDATE wk_oauth_refresh_tokens SET revoked_at = now()
        WHERE principal_kind = 'identity' AND principal_key_id = $1 AND revoked_at IS NULL`,
      [principalKeyId],
    )
    await deps.db.query(
      `UPDATE wk_oauth_authorization_codes SET consumed_at = now()
        WHERE principal_kind = 'identity' AND principal_key_id = $1 AND consumed_at IS NULL`,
      [principalKeyId],
    )
    // SSO-minted API keys (POST /v1/identity/sessions) are bound to this
    // grant (0029) and die with it. authenticate also rechecks the grant per
    // request — this direct revoke makes the kill absolute even if that
    // per-request check ever regresses, mirroring the token revokes above.
    await deps.db.query(
      `UPDATE wk_api_keys SET revoked_at = now()
        WHERE identity_provider = $1 AND identity_subject = $2 AND revoked_at IS NULL`,
      [providerId, subject],
    )
    return { status: 200, body: { provider: providerId, subject, revoked_at: revokedAt } }
  },

  /**
   * What this installation is actually running, in its own words.
   *
   * WHY it exists. WIKIKIT_SCAFFOLDING_KINDS decides whether a page's evidence
   * is reported as ABSENT or as three zeros, and whether the linter's fault
   * rules skip it — on one real deployment that is 49 pages across 5 wikis. The
   * value is a fact about ONE database, so docs/CONFIGURATION.md cannot print
   * it (nor should it: a per-installation value does not belong in a shared
   * document). Until this route, an operator could only learn which markers
   * their own installation honoured by opening the source of the build they
   * hoped they were running. Configuration that invisibly decides what gets
   * measured is an operability defect regardless of how well it is documented.
   *
   * WHY provenance and not a flat list. The first question on reading an
   * unexpected value is "did I set that, or did it come with the product", and
   * the two answers call for different actions: `structural-reference` is
   * WikiKit's own marker and cannot be configured away, while everything beside
   * it is a value this installation wrote and can change. A flat array of
   * strings answers neither. There used to be a third origin, `fallback`, for
   * the deployment-specific marker WikiKit shipped as a default; that default
   * is gone, so anything not built in is now necessarily configured.
   *
   * WHY no marker is ever named in this file. It reports whatever the running
   * config holds. A report that hardcoded a marker would be describing the
   * build somebody read rather than the process somebody is running — the very
   * confusion the route removes.
   *
   * WHY there is no fallback here any more. This used to read
   * `scaffoldingKinds ?? BUILT_IN_SCAFFOLDING_KINDS`, mirroring a default the
   * reads carried, so the report could not disagree with the behaviour it
   * described. Both are gone: `Config.scaffoldingKinds` is required and so is
   * every read that acts on it, so there is no absent case left to mirror — and
   * a report that still defaulted would be inventing the one answer an operator
   * comes here to check. BUILT_IN_SCAFFOLDING_KINDS survives below for
   * ATTRIBUTION only, which is a different question from what to report.
   *
   * WHY there is no matching MCP tool, and should not be one. The reader here
   * is an operator explaining a count on their own installation, which the
   * console and a curl already serve. An agent does not need it: the contract
   * fixes what an ABSENT evidence object MEANS (§5.3), and that meaning is the
   * same on every installation — the marker set explains why one row is silent,
   * it does not change how any response is read. Against that near-zero gain
   * sits a real cost: a tool hands every connected model the literal strings
   * that make a page exempt from evidence and from the linter's fault rules,
   * which is one short step from "write the page with that kind and the lint
   * stops complaining". And a second transport is a second constituency arguing
   * for another field the day the rule below says no.
   *
   * What may ever be added here is fixed by the rule on zKnowledgeConfigResponse
   * in src/http/schemas.ts. Read it before adding a field.
   */
  async knowledgeConfigHandler(deps) {
    const kinds = deps.config.scaffoldingKinds
    const configured = deps.config.scaffoldingKindsDeclared
    return {
      status: 200,
      body: {
        schema_version: 'wikikit.knowledge-config.v1',
        version: deps.config.version,
        scaffolding_kinds: {
          env: 'WIKIKIT_SCAFFOLDING_KINDS',
          configured,
          items: kinds.map((kind) => ({
            kind,
            origin: BUILT_IN_SCAFFOLDING_KINDS.includes(kind) ? 'built_in' : 'configured',
          })),
        },
      },
    }
  },

  async healthHandler() {
    return { status: 200, text: 'ok', headers: { 'content-type': 'text/plain; charset=utf-8' } }
  },

  async readyHandler(deps) {
    // EXACT deploy-gate shape ({status, version}) — see zReadyResponse.
    if (deps.state.draining) return { status: 503, body: { status: 'draining', version: deps.config.version } }
    return { status: 200, body: { status: 'ready', version: deps.config.version } }
  },

  async metricsHandler(deps) {
    return {
      status: 200,
      text: deps.metrics.render(),
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
    }
  },

  async ingestStatsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const window = resolveStatsWindow(input.query)
    return { status: 200, body: await getIngestStats(deps.db, space.id, window) }
  },

  async mcpUsageStatsHandler(deps, input) {
    const window = resolveUsageStatsWindow(input.query, 'mcp')
    return { status: 200, body: await getMcpUsageStats(deps.db, window, deps.usage.quality()) }
  },

  async httpUsageStatsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const window = resolveUsageStatsWindow(input.query, 'http')
    return { status: 200, body: await getHttpUsageStats(deps.db, space.id, window, deps.usage.quality()) }
  },

  async coverageStatsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const query = input.query as { from: string; to: string; top: number }
    const stats = await getCoverageStats(deps.db, space.id, query)
    return {
      status: 200,
      body: {
        schema_version: 'wikikit.coverage-stats.v1',
        from: query.from,
        to: query.to,
        disputed: stats.disputed,
        review_latency: stats.review_latency,
        freshness: stats.freshness,
        top_read_concepts: stats.top_read_concepts,
        top_linked_concepts: stats.top_linked_concepts,
        gap_topics: { enabled: deps.config.coverageGapTopicsEnabled === true, items: stats.gap_topics },
      },
    }
  },

  async knowledgeUsageStatsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const window = resolveUsageStatsWindow(input.query, 'knowledge')
    return { status: 200, body: await getKnowledgeUsageStats(deps.db, space.id, window, deps.usage.quality()) }
  },

  async reviewUsageStatsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const window = resolveUsageStatsWindow(input.query, 'review')
    return { status: 200, body: await getReviewUsageStats(deps.db, space.id, window, deps.usage.quality()) }
  },

  async knowledgeStatsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const window = resolveStatsWindow(input.query)
    return { status: 200, body: await getKnowledgeStats(deps.db, space.id, window) }
  },

  async llmStatsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const window = resolveStatsWindow(input.query)
    return { status: 200, body: await getLlmStats(deps.db, space.id, window) }
  },

  async webhookStatsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const window = resolveStatsWindow(input.query)
    return { status: 200, body: await getWebhookStats(deps.db, space.id, window) }
  },

  /**
   * The descriptor, and why it is worth a route of its own.
   *
   * A monitor that wants to know whether this service's self-description has
   * changed otherwise downloads every artifact on every poll — for WikiKit that
   * is llms-full.txt alone at ~50 KB, every round, forever, almost always to
   * discover nothing changed. This answers the same question in a few hundred
   * bytes, which is what makes a thirty-second drift check affordable instead
   * of an hourly one.
   *
   * WHAT DOES NOT BELONG HERE: this installation's configuration. The
   * knowledge-shaping report (GET /v1/installation/knowledge-config) looks like
   * a natural third member of "version plus self-description", and it is not:
   * this route is UNAUTHENTICATED, and while a scaffolding marker is not a
   * secret, an installation's configuration is not something to hand to
   * anonymous callers. The descriptor describes the PRODUCT — the same bytes on
   * every deployment running this build. The moment it also describes the
   * deployment, every future addition to the config report becomes a public
   * addition, decided by whoever adds it. Keep configuration behind `admin`.
   *
   * The hashes are of the bytes actually served, computed here rather than
   * cached: the documents are embedded at build time and cannot change while
   * the process lives, so the cost is a hash of a few kilobytes on a route
   * nothing calls in a hot loop, and the alternative — a cache that can go
   * stale — would make this endpoint lie in exactly the situation it exists to
   * report.
   */
  async serviceDescriptorHandler(deps) {
    const base = deps.config.publicUrl
    const artifact = (name: string, file: string) => {
      const content = readDocsFile(deps.config, file)
      return content === null
        ? null
        : { url: `${base}/${file}`, sha256: createHash('sha256').update(content).digest('hex'), updated_at: null }
    }
    const artifacts: Record<string, unknown> = {}
    // Only what this build actually serves. An entry for a document that
    // answers 404 would send a watcher to fetch it and then report the miss as
    // drift, which is worse than not mentioning it.
    for (const [key, file] of [
      ['llms_txt', 'llms.txt'],
      ['llms_full_txt', 'llms-full.txt'],
      ['agent_guide', 'agent-guide.md'],
    ] as const) {
      const entry = artifact(key, file)
      if (entry) artifacts[key] = entry
    }
    // Generated live from ROUTES rather than read from disk, because that is
    // how it is served — hashing a file that is not the response would be a
    // fingerprint of the wrong thing.
    const openapi = JSON.stringify(buildOpenApi(ROUTES, { version: deps.config.version }))
    artifacts.openapi = {
      url: `${base}/openapi.json`,
      sha256: createHash('sha256').update(openapi).digest('hex'),
      updated_at: null,
    }
    return {
      status: 200,
      body: {
        service: 'wikikit',
        version: deps.config.version,
        artifacts,
        capabilities: ['health', 'ready', 'metrics', 'openapi', 'llms-txt', 'agent-guide', 'mcp', 'descriptor'],
      },
    }
  },

  async openapiHandler(deps) {
    return { status: 200, body: buildOpenApi(ROUTES, { version: deps.config.version }) }
  },

  async reviewPageHandler(_deps, input) {
    return {
      status: 200,
      text: renderReviewPage(input.params.id!),
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': REVIEW_PAGE_CSP,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    }
  },

  async agentGuideHandler(deps) {
    const content = readDocsFile(deps.config, 'agent-guide.md')
    return {
      status: 200,
      text:
        content ??
        '# WikiKit agent guide\n\n> docs/agent-guide.md is not bundled in this build.\n\nSee /llms.txt for the documentation index.\n',
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    }
  },

  async llmsTxtHandler(deps) {
    const content = readDocsFile(deps.config, 'llms.txt')
    return {
      status: 200,
      text:
        content ??
        '# WikiKit\n\n> docs/llms.txt is not bundled in this build.\n\nSee /openapi.json for the API surface.\n',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }
  },

  async llmsFullTxtHandler(deps) {
    const content = readDocsFile(deps.config, 'llms-full.txt')
    return {
      status: 200,
      text:
        content ??
        '# WikiKit\n\n> docs/llms-full.txt is not bundled in this build.\n\nSee /openapi.json for the API surface.\n',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }
  },

  async installShHandler(deps) {
    return {
      status: 200,
      text: renderInstaller(deps.config, 'sh'),
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }
  },

  async installPs1Handler(deps) {
    return {
      status: 200,
      text: renderInstaller(deps.config, 'ps1'),
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }
  },

  async installHookScriptHandler(_deps, input) {
    // The params schema (closed enum) already rejected unknown names with 400.
    return {
      status: 200,
      text: INSTALL_HOOK_SCRIPTS[input.params.script!]!,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }
  },
}
