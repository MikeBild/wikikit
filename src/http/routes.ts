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
import type { Config } from '../config.ts'
import type { Db } from '../db/postgres.ts'
import { getConcept, getConceptHistory, listConcepts, toConceptResponse } from '../domain/concepts.ts'
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.ts'
import { lintSpace } from '../domain/lint.ts'
import {
  approveProposal,
  createProposal,
  getProposal,
  listProposals,
  rejectProposal,
  renderProposalMarkdown,
  toProposalWire,
} from '../domain/proposals.ts'
import { getDecision, listDecisions } from '../domain/decisions.ts'
import { getSource, isoString, listSources } from '../domain/sources.ts'
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
import { answerQuestion } from '../query/answer.ts'
import { search } from '../query/search.ts'
import { listWebhookDeliveries, listWebhookEndpoints, registerWebhookEndpoint } from '../webhooks.ts'
import type { Auth, Principal } from './auth.ts'
import { getIngestJob } from './jobs.ts'
import { buildOpenApi } from './openapi.ts'
import { readDocsFile } from './docs-embedded.ts'
import { renderReviewPage, REVIEW_PAGE_CSP } from './review-page.ts'
import { markUsageContext, type UsageTelemetry } from '../usage.ts'

export type Scope = 'knowledge:read' | 'knowledge:propose' | 'knowledge:review' | 'knowledge:approve' | 'admin'

export interface RouteDef {
  method: 'get' | 'post' | 'delete'
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
    method: 'post',
    path: '/v1/spaces/{space}/ingest',
    scope: 'knowledge:propose',
    summary: 'Ingest a source (markdown|text|url) — async; returns an ingest job to poll',
    handler: 'createIngestHandler',
    request: { params: 'zSpaceParams', body: 'zIngestRequest' },
    responses: {
      202: {
        schema: 'zIngestAcceptedResponse',
        type: 'application/json',
        desc: 'Queued; poll the Location header (/v1/ingests/{id})',
      },
      409: {
        schema: 'zErrorEnvelope',
        type: 'application/json',
        desc: 'already_ingested (envelope carries source_id)',
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
    method: 'post',
    path: '/v1/spaces/{space}/ingest/document',
    scope: 'knowledge:propose',
    summary: 'Upload a document (pdf|docx|xlsx|md|txt|csv, raw body) — extracted to Markdown then ingested; async',
    handler: 'ingestDocumentHandler',
    request: { params: 'zSpaceParams', query: 'zIngestDocumentQuery' },
    rawBody: true,
    responses: {
      202: {
        schema: 'zIngestAcceptedResponse',
        type: 'application/json',
        desc: 'Extracted + queued; poll /v1/ingests/{id}',
      },
      415: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'unsupported_document (unknown extension)' },
      422: { schema: 'zErrorEnvelope', type: 'application/json', desc: 'document_extraction_failed (no text layer)' },
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
    summary: 'List concepts (keyset pagination via ?after=; ETag over the space epoch, 304 on If-None-Match)',
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
    path: '/v1/spaces/{space}/search',
    scope: 'knowledge:read',
    summary: 'LLM-free full-text search; ranked hits with <mark> headlines',
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
    summary: 'Stage a manual change proposal (agent-authored changes go through the same review gate)',
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
      'Structured proposal diff (old/new markdown, claims added/disputed/deprecated); text/markdown via Accept; knowledge:review keys may inspect too',
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
    method: 'get',
    path: '/v1/spaces/{space}/lint',
    scope: 'knowledge:read',
    summary: 'Knowledge health findings (contradictions, missing citations, ...) — LLM-free, CI-friendly',
    handler: 'lintHandler',
    request: { params: 'zSpaceParams' },
    responses: { 200: { schema: 'zLintResponse', type: 'application/json', desc: 'Findings + counts' } },
  },
  {
    method: 'get',
    path: '/v1/spaces/{space}/export',
    scope: 'knowledge:read',
    summary: 'Export the space as a zip bundle (?format=md|okf)',
    handler: 'exportHandler',
    request: { params: 'zSpaceParams', query: 'zExportQuery' },
    responses: { 200: { type: 'application/zip', desc: 'Zip stream (markdown tree or OKF bundle)' } },
  },
  {
    method: 'post',
    path: '/v1/spaces/{space}/import',
    scope: 'knowledge:propose',
    summary: 'Import a bundle (zip, ?format=md|okf): sources archived directly, knowledge staged as ONE proposal',
    handler: 'importHandler',
    request: { params: 'zSpaceParams', query: 'zExportQuery' },
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
    summary: 'Delivery attempts for one endpoint (status, attempts, backoff)',
    handler: 'listWebhookDeliveriesHandler',
    request: { params: 'zSpaceIdParams' },
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
]

// ---------------------------------------------------------------------------
// Spaces domain functions (CONTRACTS §4 src/domain/spaces.ts signatures)
// ---------------------------------------------------------------------------
// TEMPORARY HOME: src/domain/spaces.ts does not exist yet (no builder owns it
// in this round). The functions below implement the exact contract signatures
// so they can be MOVED to src/domain/spaces.ts verbatim once that module
// lands; nothing else in this file assumes their location.

export interface Space {
  id: string
  slug: string
  name: string
  settings: Record<string, unknown>
  epoch: number
  created_at: string
  updated_at: string
}

interface SpaceRow {
  id: string
  slug: string
  name: string
  settings: Record<string, unknown>
  epoch: number | string
  created_at: Date | string
  updated_at: Date | string
}

function toSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    settings: row.settings ?? {},
    epoch: Number(row.epoch),
    created_at: isoString(row.created_at),
    updated_at: isoString(row.updated_at),
  }
}

export async function createSpace(
  db: Db,
  args: { slug: string; name: string; settings?: Record<string, unknown> },
): Promise<Space> {
  try {
    const [row] = await db.insert<SpaceRow>('wk_spaces', {
      slug: args.slug,
      name: args.name,
      settings: JSON.stringify(args.settings ?? {}),
    })
    return toSpace(row!)
  } catch (error) {
    // Unique violation → caller mistake, not a server fault. 400 keeps the
    // canonical code table intact (no space-specific 409 code exists in §8.2).
    if ((error as { code?: string }).code === '23505') {
      throw new ValidationError(`space slug '${args.slug}' already exists`)
    }
    throw error
  }
}

export async function getSpaceBySlug(db: Db, slug: string): Promise<Space> {
  const [row] = await db.select<SpaceRow>('wk_spaces', { slug: `eq.${slug}`, limit: 1 })
  if (!row) throw new NotFoundError(`space '${slug}' not found`)
  return toSpace(row)
}

export async function listSpaces(db: Db): Promise<Space[]> {
  const rows = await db.select<SpaceRow>('wk_spaces', { order: 'slug.asc', limit: 500 })
  return rows.map(toSpace)
}

export async function updateSpaceSettings(
  db: Db,
  space: Space,
  args: { settings: Record<string, unknown>; replace: boolean },
): Promise<Space> {
  const settings = args.replace ? args.settings : { ...space.settings, ...args.settings }
  const [row] = await db.update<SpaceRow>(
    'wk_spaces',
    { id: `eq.${space.id}` },
    {
      settings: JSON.stringify(settings),
      updated_at: new Date(),
    },
  )
  if (!row) throw new NotFoundError(`space '${space.slug}' not found`)
  return toSpace(row)
}

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
    const space = await createSpace(deps.db, body)
    return { status: 201, body: space }
  },

  async getSpaceHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    return { status: 200, body: space }
  },

  async updateSpaceSettingsHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'admin')
    return {
      status: 200,
      body: await updateSpaceSettings(
        deps.db,
        space,
        input.body as { settings: Record<string, unknown>; replace: boolean },
      ),
    }
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
    const { ingest_id } = await deps.ingest.enqueue(deps.db, space.id, input.body as never)
    return {
      status: 202,
      body: { ingest_id, status: 'queued' as const },
      headers: { location: `/v1/ingests/${ingest_id}` },
    }
  },

  async ingestDocumentHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:propose')
    const query = input.query as { filename: string; source_kind?: 'meeting' | 'article' | 'note' }
    const bytes = input.body as Uint8Array
    if (!bytes || bytes.byteLength === 0) throw new ValidationError('request body must be the document bytes')
    // Extract to Markdown here (deterministic CPU work), then hand the result to
    // the SAME ingest path a pasted markdown source takes — dedup, classify,
    // synthesize, grounding all apply unchanged. The filename becomes the title.
    const doc = await extractDocument(bytes, query.filename)
    const { ingest_id } = await deps.ingest.enqueue(deps.db, space.id, {
      markdown: doc.markdown,
      title: doc.title,
      source_kind: query.source_kind,
    })
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
    const page = await listConcepts(deps.db, space.id, { limit: query.limit, after: query.after })
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

  async searchHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const query = input.query as { q: string; kind?: 'concept' | 'claim'; limit?: number }
    const hits = await search(deps.db, space.id, query)
    return { status: 200, body: { hits } }
  },

  async queryHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const body = input.body as { question: string; top_k?: number }
    const answer = await answerQuestion(deps.db, space.id, deps.llm, body)
    return { status: 200, body: answer }
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

  async approveProposalHandler(deps, input) {
    const detail = await getProposal(deps.db, { id: input.params.id! })
    requireSpaceAccess(deps, input, 'knowledge:approve', detail.space_id)
    const note = (input.body as { note?: string } | undefined)?.note
    // Reviewer identity = the key's name: the audit trail names WHO approved,
    // and the key name is the only identity a headless system has.
    const result = await approveProposal(deps.db, {
      id: detail.id,
      reviewer: input.principal!.name,
      note,
      reviewChannel: 'rest',
    })
    return { status: 200, body: result }
  },

  async rejectProposalHandler(deps, input) {
    const detail = await getProposal(deps.db, { id: input.params.id! })
    requireSpaceAccess(deps, input, 'knowledge:approve', detail.space_id)
    const note = (input.body as { note?: string } | undefined)?.note
    const result = await rejectProposal(deps.db, {
      id: detail.id,
      reviewer: input.principal!.name,
      note,
      reviewChannel: 'rest',
    })
    return { status: 200, body: result }
  },

  async lintHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const report = await lintSpace(deps.db, space.id)
    return { status: 200, body: report }
  },

  async exportHandler(deps, input) {
    const space = await resolveSpace(deps, input, 'knowledge:read')
    const format = (input.query as { format: 'md' | 'okf' }).format
    const stream = await exportSpace(deps.db, space.id, { format })
    input.res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${space.slug}-${format}.zip"`,
    })
    // Manual pump instead of pipeTo: node:http ServerResponse is not a web
    // WritableStream, and Readable.fromWeb churns across runtimes — a loop is
    // portable and exactly as fast for the single-chunk stream export emits.
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      input.res.write(value)
    }
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
    const items = await listWebhookDeliveries(deps.db, space.id, { endpointId: input.params.id! })
    return { status: 200, body: { items } }
  },

  async createApiKeyHandler(deps, input) {
    const body = input.body as { name: string; scopes: string[]; space?: string }
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
    const { id, key } = await deps.auth.createKey({ name: body.name, scopes: body.scopes, spaceId })
    return { status: 201, body: { id, name: body.name, key, scopes: body.scopes, space: spaceSlug } }
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
}
