// MCP tool palette (CONTRACTS §7.1 — binding: names, schemas, scopes, all
// four annotations). Thin dispatch over the SAME domain modules REST consumes;
// no knowledge logic lives here.
//
// Zod-first (hard-won rule): the write tools reuse the exact zod objects the
// rest of the system validates with — `zIngestInput` (the ingest pipeline's
// boundary schema, shared with HTTP's zIngestRequest) and `zCreateProposalArgs`
// (exported from domain/proposals.ts precisely so HTTP and MCP validate the
// SAME staging shape). `safeExtend` adds the `space` argument while PRESERVING
// the cross-field refinements (exactly-one-of markdown|text|url, at-least-one
// concept/decision) — a plain `.extend` would silently drop them.
//
// Scope-gating = tool VISIBILITY: a knowledge:read key never sees the write
// tools in tools/list, and calling an invisible tool is indistinguishable
// from calling a nonexistent one. Review is deliberately a separate,
// stronger scope: an agent may stage with knowledge:propose, but only a
// principal explicitly granted knowledge:approve can inspect the complete
// diff and make the irreversible approve/reject decision.
import { z } from 'zod'
import { buildAgentBriefing } from '../agent/briefing.ts'
import { buildAgentContext } from '../agent/context.ts'
import type { Config } from '../config.ts'
import type { Db } from '../db/postgres.ts'
import { getConcept, getConceptHistory, toConceptResponse } from '../domain/concepts.ts'
import {
  ConflictError,
  ForbiddenError,
  HumanDecisionRequiredError,
  LlmNotConfiguredError,
  NotFoundError,
} from '../domain/errors.ts'
import { getDecision, listDecisions } from '../domain/decisions.ts'
import { lintSpace } from '../domain/lint.ts'
import {
  approveProposal,
  createProposal,
  getProposal,
  listProposals,
  rejectProposal,
  stagesCrossSpaceRelations,
  toProposalWire,
  zCreateProposalArgs,
} from '../domain/proposals.ts'
import { isoString } from '../domain/sources.ts'
import { zIngestInput, type IngestPipeline } from '../ingest/pipeline.ts'
import type { LlmProvider } from '../llm/provider.ts'
import { readDocsFile } from '../http/docs-embedded.ts'
import { search, searchAcrossImports } from '../query/search.ts'
import { zodToJsonSchema7 } from './json-schema.ts'
import { elicitProposalReview, type ElicitForm } from './elicitation.ts'
import type { UsageOutcome } from '../usage.ts'

/**
 * The Principal resolved by src/http/auth.ts (CONTRACTS §5.4) — re-exported
 * so every MCP module (and its tests) names one canonical identity type.
 * MCP and REST share the same credential surface by contract.
 */
export type { Principal } from '../http/auth.ts'
import type { Principal } from '../http/auth.ts'

/** The only scopes MCP tools may require. */
export type ToolScope = 'knowledge:read' | 'knowledge:propose' | 'knowledge:review' | 'knowledge:approve'

/**
 * Scope semantics per CONTRACTS §5.2: `*` and `admin` imply all knowledge
 * scopes (admin does not imply `*`, but every MCP tool scope IS a knowledge
 * scope, so both grant full tool visibility). `knowledge:approve` implies
 * `knowledge:review` — review is the inspect/start-review subset of approve,
 * so every existing approve key keeps working unchanged. The reverse does NOT
 * hold: a review-only key cannot use the REST approve/reject endpoints, which
 * is the point — agents get review, human operators get approve.
 */
export function holdsScope(scopes: string[], scope: ToolScope): boolean {
  return (
    scopes.includes(scope) ||
    scopes.includes('*') ||
    scopes.includes('admin') ||
    (scope === 'knowledge:review' && scopes.includes('knowledge:approve'))
  )
}

/** All four MCP spec annotations, EXPLICIT — strict clients treat an absent
 *  hint as unknown and gate the tool as a possibly-destructive write. */
export interface ToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export interface ToolDeps {
  config: Config
  db: Db
  ingest: IngestPipeline
  /** Optional hybrid-retrieval wiring: the LLM provider (for query embeddings)
   *  and the pgvector capability probe. Absent → search stays lexical. */
  llm?: LlmProvider
  vector?: { available: boolean }
}

/** Request-local MCP features supplied by server.ts. Ordinary tools ignore it. */
export interface McpToolExecutionContext {
  /** Whether the connected client advertises elicitation.form — checked BEFORE
   *  attempting a form so a non-capable client gets a hand-off, not an error. */
  formElicitationSupported: boolean
  elicitForm: ElicitForm
  setOutcome(outcome: UsageOutcome): void
  setSpaceSlug(spaceSlug: string): void
}

export interface McpToolDef {
  name: string
  description: string
  scope: ToolScope
  inputSchema: z.ZodType
  annotations: ToolAnnotations
  execute(deps: ToolDeps, principal: Principal, input: unknown, context?: McpToolExecutionContext): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Input schemas. Slug patterns mirror the DB CHECK constraints (§1.1, §1.3) so
// a malformed slug fails at the boundary instead of producing an empty query.
const zSpaceSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'space must be a lowercase slug')
  .describe('Space slug the key is working in')
const zConceptSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,126}$/, 'slug must be a lowercase concept slug')

export const zSearchToolInput = z.object({
  space: zSpaceSlug,
  q: z.string().min(1).max(1000).describe('Full-text query'),
  kind: z.enum(['concept', 'claim']).optional().describe('Restrict hits to one kind'),
  limit: z.number().int().min(1).max(50).optional().describe('Max hits per tier (default 20)'),
  mode: z
    .enum(['approved_only', 'approved_then_sources'])
    .optional()
    .describe(
      "Retrieval tiers: 'approved_only' (default) searches reviewed knowledge; 'approved_then_sources' " +
        "additionally returns archived source chunks, labeled tier:'source_evidence' after all approved hits",
    ),
  include_imports: z
    .boolean()
    .optional()
    .describe(
      'Also search the spaces declared in this space\u2019s settings.imports; every hit carries its origin space. ' +
        'Requires a key that can see all spaces (space-scoped keys get 403)',
    ),
})

export const zSpacesToolInput = z.object({})

export const zGuideToolInput = z.object({})

export const zBriefingToolInput = z.object({
  spaces: z
    .array(zSpaceSlug)
    .min(1)
    .max(10)
    .describe('Ordered spaces; earlier entries receive briefing priority when the token budget is tight'),
  budget_tokens: z.number().int().min(500).max(4000).optional().describe('Approximate output token budget'),
})

export const zContextToolInput = z.object({
  prompt: z.string().max(12_000).describe('Current user task or prompt used to select relevant spaces'),
  project_hint: z.string().max(500).optional().describe('Repository name or working-directory hint'),
  primary_space: zSpaceSlug.optional().describe('Optional project space that stays first'),
  manual_spaces: z.array(zSpaceSlug).max(20).optional().describe('Explicit spaces; bypasses automatic selection'),
  exclude_spaces: z.array(zSpaceSlug).max(100).optional().describe('Spaces already active in this session'),
  max_spaces: z.number().int().min(1).max(10).optional().describe('Maximum spaces returned (default 3)'),
  budget_tokens: z.number().int().min(500).max(4000).optional().describe('Approximate briefing budget'),
})

export const zReadToolInput = z.object({ space: zSpaceSlug, slug: zConceptSlug })

export const zSourcesToolInput = z
  .object({
    space: zSpaceSlug,
    slug: zConceptSlug.optional().describe('Concept slug — lists the sources its claims cite'),
    source_id: z.uuid().optional().describe('Single source id to inspect'),
  })
  .refine((value) => [value.slug, value.source_id].filter(Boolean).length === 1, {
    message: 'exactly one of slug|source_id is required',
  })

/** No slug → list the decision log; slug → one decision with alternatives. */
export const zDecisionsToolInput = z.object({
  space: zSpaceSlug,
  slug: zConceptSlug.optional().describe('Decision slug — omit to list all active/superseded decisions'),
})

export const zHistoryToolInput = z.object({ space: zSpaceSlug, slug: zConceptSlug })

export const zLintToolInput = z.object({ space: zSpaceSlug })

/** zIngestInput (shared with the pipeline + HTTP) + space; refinement kept. */
export const zIngestToolInput = zIngestInput.safeExtend({ space: zSpaceSlug })

export const zIngestStatusToolInput = z.object({ ingest_id: z.uuid() })

/** zCreateProposalArgs (shared with HTTP + import) + space; refinement kept. */
export const zProposeToolInput = zCreateProposalArgs.safeExtend({ space: zSpaceSlug })

/** List proposal summaries or load one complete review diff. */
export const zProposalsToolInput = z.object({
  space: zSpaceSlug,
  proposal_id: z.uuid().optional().describe('Proposal id — when set, return the complete review diff'),
  status: z.enum(['pending', 'approved', 'rejected', 'failed']).optional().describe('Filter proposal summaries'),
  limit: z.number().int().min(1).max(200).optional().describe('Max summaries when proposal_id is omitted'),
})

/** The agent selects the proposal; only native elicitation or an out-of-band
 *  human review may supply the decision. */
export const zReviewProposalToolInput = z
  .object({
    proposal_id: z.uuid().describe('Pending proposal id returned by wikikit_proposals'),
  })
  .strict()

// ---------------------------------------------------------------------------

/**
 * Resolve a space slug and enforce the key/space binding in one place.
 * Mirrors domain getSpaceBySlug (CONTRACTS §4) plus the transport duty from
 * §5.2: a space-scoped key may only touch its own space → 403, not 404 —
 * the space exists, the key just cannot use it.
 */
interface ResolvedSpace {
  id: string
  slug: string
  name: string
  description: string | null
  settings: Record<string, unknown>
}

async function resolveSpace(db: Db, principal: Principal, slug: string): Promise<ResolvedSpace> {
  const [space] = await db.select<ResolvedSpace>('wk_spaces', { slug: `eq.${slug}`, limit: 1 })
  if (!space) throw new NotFoundError(`space ${slug} not found`)
  if (principal.spaceId && principal.spaceId !== space.id) {
    throw new ForbiddenError(`key is scoped to a different space than ${slug}`)
  }
  return space
}

/** §1.14: manual (agent-authored via propose) rows carry model:'manual'. */
export function withManualAgentMeta(meta: Record<string, unknown>): Record<string, unknown> {
  if (typeof meta.model === 'string' && meta.model.length > 0) return meta
  return { model: 'manual', prompt_version: 'manual', ...meta }
}

interface SourceProvenanceRow {
  id: string
  kind: string
  url: string | null
  title: string | null
  content_hash: string
  created_at: Date | string
  cited_by_claims: number | string
}

function toProvenance(row: SourceProvenanceRow) {
  return {
    id: row.id,
    kind: row.kind,
    url: row.url,
    title: row.title,
    content_hash: row.content_hash,
    created_at: isoString(row.created_at),
    cited_by_claims: Number(row.cited_by_claims),
  }
}

// ---------------------------------------------------------------------------
// The palette. Annotation rationale is FIXED by CONTRACTS §7.1 — do not change
// silently: writes are destructiveHint:true even though they only stage
// content (hard-won rule: never destructiveHint:false on real writes — an
// honest write is a write, and a trusting client would file it under "always
// allow"). idempotentHint:true on the writes because content-hash dedup
// (ingest) and the pending input_hash unique index (propose) make identical
// retries converge on the same row. openWorldHint:true only on wikikit_ingest
// — a `url` input fetches an external host.

const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const REVIEW_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  // The decision permanently promotes or rejects staged knowledge. MCP hosts
  // must surface a confirmation; callers must never auto-run this tool.
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}

export const TOOLS: McpToolDef[] = [
  {
    name: 'wikikit_guide',
    description:
      "Read WikiKit's built-in, code-versioned system knowledge: how the product works, how task-dynamic spaces are selected, " +
      'and how to connect MCP clients by capability without a WikiKit CLI or client-specific plugin. ' +
      'Use this instead of guessing setup or workflow rules; it is not a mutable user space.',
    scope: 'knowledge:read',
    inputSchema: zGuideToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, _principal, input) {
      zGuideToolInput.parse(input)
      const markdown = readDocsFile(deps.config, 'agent-guide.md')
      if (!markdown) throw new NotFoundError('built-in WikiKit agent guide is unavailable')
      return {
        scope: 'wikikit://system',
        resource_uri: 'wikikit://system/agent-guide',
        public_path: '/agent-guide.md',
        version: deps.config.version,
        markdown,
      }
    },
  },
  {
    name: 'wikikit_spaces',
    description:
      'List the WikiKit spaces visible to this key. Use this for discovery; do not guess or hard-code a project space.',
    scope: 'knowledge:read',
    inputSchema: zSpacesToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      zSpacesToolInput.parse(input)
      const spaces = await deps.db.select<ResolvedSpace>('wk_spaces', { order: 'slug.asc', limit: 500 })
      return {
        spaces: spaces
          .filter((space) => !principal.spaceId || principal.spaceId === space.id)
          .map(({ id, slug, name, description }) => ({ id, slug, name, description })),
      }
    },
  },
  {
    name: 'wikikit_briefing',
    description:
      'Build a compact, budgeted session briefing for any ordered set of WikiKit spaces. ' +
      'The result contains only pinned orientation; search and read full knowledge on demand.',
    scope: 'knowledge:read',
    inputSchema: zBriefingToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zBriefingToolInput.parse(input)
      const spaces = []
      for (const slug of [...new Set(args.spaces)]) spaces.push(await resolveSpace(deps.db, principal, slug))
      return buildAgentBriefing(deps.db, spaces, args.budget_tokens)
    },
  },
  {
    name: 'wikikit_context',
    description:
      'Select relevant knowledge spaces from the current task and return a compact briefing. ' +
      'Use this at the start of a task when no lifecycle hook supplied WikiKit context; pass manual_spaces for an explicit selection.',
    scope: 'knowledge:read',
    inputSchema: zContextToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zContextToolInput.parse(input)
      const spaces = await deps.db.select<ResolvedSpace>('wk_spaces', { order: 'slug.asc', limit: 500 })
      const visible = spaces.filter((space) => !principal.spaceId || principal.spaceId === space.id)
      const visibleSlugs = new Set(visible.map((space) => space.slug))
      for (const slug of [args.primary_space, ...(args.manual_spaces ?? [])].filter(Boolean) as string[]) {
        if (!visibleSlugs.has(slug)) throw new NotFoundError(`space ${slug} is not visible to this key`)
      }
      return buildAgentContext(deps.db, visible, args)
    },
  },
  {
    name: 'wikikit_search',
    description:
      'Ranked full-text search over the knowledge base (current concept revisions and visible claims). ' +
      "mode:'approved_then_sources' additionally searches archived source chunks — those hits carry " +
      "tier:'source_evidence' and are NOT approved knowledge (cite a chunk_id in wikikit_propose to curate one). " +
      'Returns raw evidence with <mark> headlines — no synthesis. Use wikikit_read to fetch a full concept.',
    scope: 'knowledge:read',
    inputSchema: zSearchToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zSearchToolInput.parse(input)
      const space = await resolveSpace(deps.db, principal, args.space)
      const searchArgs = { q: args.q, kind: args.kind, limit: args.limit, mode: args.mode }
      const searchDeps = { llm: deps.llm, vector: deps.vector }
      if (args.include_imports) {
        if (principal.spaceId) {
          throw new ForbiddenError('this key is scoped to a single space and cannot search imported spaces')
        }
        return searchAcrossImports(deps.db, space, searchArgs, searchDeps)
      }
      const hits = await search(deps.db, space.id, searchArgs, searchDeps)
      return { hits: hits.map((hit) => ({ ...hit, space: space.slug })), searched_spaces: [space.slug] }
    },
  },
  {
    name: 'wikikit_read',
    description:
      'Read one concept completely: markdown, verified/disputed claims with citations, relations, ' +
      'current revision number and agent_meta provenance.',
    scope: 'knowledge:read',
    inputSchema: zReadToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zReadToolInput.parse(input)
      const space = await resolveSpace(deps.db, principal, args.space)
      // §7.1 binds this tool's output to the §5.3 zConceptResponse shape —
      // the SAME wire mapping REST uses, so the transports cannot drift and
      // the internal-only ConceptDetail fields never reach an MCP client.
      const concept = await getConcept(deps.db, space.id, { slug: args.slug })
      // 0023 eliding (mirrors REST): space-scoped keys never see foreign
      // relation targets.
      if (principal.spaceId) {
        concept.relations = concept.relations.filter((relation) => relation.space === null)
      }
      return toConceptResponse(concept)
    },
  },
  {
    name: 'wikikit_sources',
    description:
      'Provenance chain down to the original sources. Pass a concept slug to list every source its ' +
      'visible claims cite, or a source_id to inspect one archived source.',
    scope: 'knowledge:read',
    inputSchema: zSourcesToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zSourcesToolInput.parse(input)
      const space = await resolveSpace(deps.db, principal, args.space)
      if (args.source_id) {
        const { rows } = await deps.db.query<SourceProvenanceRow>(
          `SELECT s.id, s.kind, s.url, s.title, s.content_hash, s.created_at,
                  (SELECT count(*) FROM wk_citations c WHERE c.source_id = s.id) AS cited_by_claims
             FROM wk_sources s
            WHERE s.space_id = $1 AND s.id = $2`,
          [space.id, args.source_id],
        )
        if (!rows[0]) throw new NotFoundError(`source ${args.source_id} not found`)
        return { sources: [toProvenance(rows[0])] }
      }
      // Concept path: sources cited by the concept's READER-VISIBLE claims —
      // the same visibility rule as wikikit_read (proposed claims never leak
      // their sources here either).
      const concept = await deps.db.select<{ id: string }>('wk_concepts', {
        space_id: `eq.${space.id}`,
        slug: `eq.${args.slug}`,
        limit: 1,
      })
      if (!concept[0]) throw new NotFoundError(`concept ${args.slug} not found`)
      const { rows } = await deps.db.query<SourceProvenanceRow>(
        `SELECT s.id, s.kind, s.url, s.title, s.content_hash, s.created_at,
                count(DISTINCT cit.claim_id) AS cited_by_claims
           FROM wk_sources s
           JOIN wk_citations cit ON cit.source_id = s.id
           JOIN wk_claims cl ON cl.id = cit.claim_id
          WHERE s.space_id = $1
            AND cl.concept_id = $2
            AND cl.status IN ('verified', 'disputed', 'deprecated')
          GROUP BY s.id, s.kind, s.url, s.title, s.content_hash, s.created_at
          ORDER BY s.created_at DESC`,
        [space.id, concept[0].id],
      )
      return { sources: rows.map(toProvenance) }
    },
  },
  {
    name: 'wikikit_decisions',
    description:
      'The decision log: pass a slug to read one decision (context, decision, rationale, rejected ' +
      'alternatives), or omit it to list all active/superseded decisions newest-first. Proposed ' +
      'decisions (awaiting review) are never returned.',
    scope: 'knowledge:read',
    inputSchema: zDecisionsToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zDecisionsToolInput.parse(input)
      const space = await resolveSpace(deps.db, principal, args.space)
      if (args.slug) return getDecision(deps.db, space.id, { slug: args.slug })
      return { decisions: await listDecisions(deps.db, space.id) }
    },
  },
  {
    name: 'wikikit_history',
    description:
      'Revision history of a concept including proposed/rejected revisions and their agent_meta ' +
      '(model, prompt_version, sources) — the audit trail of who/what wrote each version.',
    scope: 'knowledge:read',
    inputSchema: zHistoryToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zHistoryToolInput.parse(input)
      const space = await resolveSpace(deps.db, principal, args.space)
      const revisions = await getConceptHistory(deps.db, space.id, { slug: args.slug })
      return { revisions }
    },
  },
  {
    name: 'wikikit_lint',
    description:
      'Knowledge-base health findings: contradictions, missing citations, broken relations, stale ' +
      'claims, orphans. LLM-free and CI-consumable.',
    scope: 'knowledge:read',
    inputSchema: zLintToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zLintToolInput.parse(input)
      const space = await resolveSpace(deps.db, principal, args.space)
      return lintSpace(deps.db, space.id)
    },
  },
  {
    name: 'wikikit_ingest',
    description:
      'Submit a source (markdown, text, or a URL to fetch) into the ingest pipeline. Returns an async ' +
      'handle immediately — ALWAYS poll wikikit_ingest_status with the returned ingest_id; never wait ' +
      'in-band. The result is a pending ChangeProposal that a human approves over REST.',
    scope: 'knowledge:propose',
    inputSchema: zIngestToolInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true, // content-hash dedup: identical input converges on the same source/proposal
      openWorldHint: true, // a url input fetches an external host
    },
    async execute(deps, principal, input) {
      const args = zIngestToolInput.parse(input)
      // Fail fast BEFORE queueing: a keyless deployment would otherwise accept
      // the job and fail it asynchronously — a worse loop for the agent than
      // one terminal llm_not_configured envelope (zero-config principle: the
      // read tools keep working without an LLM key).
      if (!deps.config.llmConfigured) throw new LlmNotConfiguredError(deps.config.llmApiKeyEnv)
      const space = await resolveSpace(deps.db, principal, args.space)
      const { space: _space, ...request } = args
      const enqueued = await deps.ingest.enqueue(deps.db, space.id, request)
      // Sync fast-path (external_source_id + known content): terminal answer,
      // nothing to poll — the stream head advanced.
      if ('status' in enqueued) return enqueued
      // Async-ack contract (§7.1): never block an MCP call on LLM latency.
      return { status: 'running' as const, ingest_id: enqueued.ingest_id, poll_with: 'wikikit_ingest_status' as const }
    },
  },
  {
    name: 'wikikit_ingest_status',
    description:
      'Poll an ingest job started by wikikit_ingest. Terminal states: done (source_id plus optional ' +
      'proposal_id; null means no review work) or failed (carries error.code/message). quota_blocked ' +
      'means the provider quota is exhausted; the job resumes on its own — keep polling.',
    scope: 'knowledge:propose',
    inputSchema: zIngestStatusToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zIngestStatusToolInput.parse(input)
      const [job] = await deps.db.select<{
        id: string
        space_id: string
        status: 'queued' | 'running' | 'done' | 'failed' | 'quota_blocked'
        proposal_id: string | null
        source_id: string | null
        error: { code: string; message: string } | null
      }>('wk_ingest_jobs', { id: `eq.${args.ingest_id}`, limit: 1 })
      if (!job) throw new NotFoundError(`ingest ${args.ingest_id} not found`)
      // Global-id lookup (⚠ per CONTRACTS §4): the transport enforces the
      // key/space match — a space-scoped key polling a foreign job gets 403.
      if (principal.spaceId && principal.spaceId !== job.space_id) {
        throw new ForbiddenError('key is scoped to a different space than this ingest job')
      }
      return {
        ingest_id: job.id,
        status: job.status,
        proposal_id: job.proposal_id,
        source_id: job.source_id,
        error: job.error,
      }
    },
  },
  {
    name: 'wikikit_propose',
    description:
      'Stage a structured ChangeProposal (concepts with claims/citations/relations, decisions, and removals of ' +
      'existing active relations via relations_removed) into the review gate. Nothing changes until a human ' +
      'reviewer explicitly approves it — approval also deactivates the staged relation removals atomically.',
    scope: 'knowledge:propose',
    inputSchema: zProposeToolInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true, // pending (space_id, input_hash) unique index: identical retries converge
      openWorldHint: false,
    },
    async execute(deps, principal, input) {
      const args = zProposeToolInput.parse(input)
      const space = await resolveSpace(deps.db, principal, args.space)
      // 0023 key-visibility gate (mirrors REST): a space-scoped key may never
      // stage across spaces.
      if (principal.spaceId && stagesCrossSpaceRelations(args)) {
        throw new ForbiddenError('this key is scoped to a single space and cannot stage cross-space relations')
      }
      const { space: _space, ...proposal } = args
      return createProposal(deps.db, space.id, {
        ...proposal,
        agent_meta: withManualAgentMeta(proposal.agent_meta),
      })
    },
  },
  {
    name: 'wikikit_proposals',
    description:
      'Review queue for a space. Without proposal_id, lists proposal summaries; with proposal_id, returns the full staged diff, ' +
      'including old/new revisions, claims, relations added and removed, decisions, sources and prior review metadata. ' +
      'Requires knowledge:review (implied by knowledge:approve).',
    scope: 'knowledge:review',
    inputSchema: zProposalsToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zProposalsToolInput.parse(input)
      const space = await resolveSpace(deps.db, principal, args.space)
      if (!args.proposal_id) {
        return { proposals: await listProposals(deps.db, space.id, { status: args.status, limit: args.limit }) }
      }
      const proposal = await getProposal(deps.db, { id: args.proposal_id })
      if (proposal.space_id !== space.id) throw new ForbiddenError('proposal belongs to a different space')
      return toProposalWire(proposal)
    },
  },
  {
    name: 'wikikit_review_proposal',
    description:
      'Start a human review for one pending ChangeProposal after inspecting it with wikikit_proposals. Input is { proposal_id } only. ' +
      'The approve/reject decision and the optional audit note belong to the reviewing human and are collected through ' +
      'WikiKit’s native elicitation form — never through tool arguments. ' +
      'On a client without elicitation.form the proposal stays pending and the tool returns outcome "human_review_required" ' +
      'with a review_url and instructions matched to this key’s scope: a knowledge:review key hands the link to the user, ' +
      'while knowledge:approve (the operator’s opt-in) additionally allows executing the user’s explicit chat decision over REST. ' +
      'Requires knowledge:review (implied by knowledge:approve). Decline, cancel, timeout, or a missing form capability never mutates knowledge.',
    scope: 'knowledge:review',
    inputSchema: zReviewProposalToolInput,
    annotations: REVIEW_ANNOTATIONS,
    async execute(deps, principal, input, context) {
      // Structural refusal BEFORE schema parsing: `decision`/`note` are the
      // form fields every doc names, so an agent on a degraded client will try
      // them here — that gets a human-decision refusal, not a generic zod nit.
      if (input && typeof input === 'object' && ('decision' in input || 'note' in input)) {
        throw new HumanDecisionRequiredError()
      }
      const args = zReviewProposalToolInput.parse(input)
      const proposal = await getProposal(deps.db, { id: args.proposal_id })
      if (principal.spaceId && principal.spaceId !== proposal.space_id) {
        throw new ForbiddenError('proposal belongs to a different space')
      }
      if (proposal.status !== 'pending') {
        throw new ConflictError('proposal_not_pending', 'proposal has already been reviewed', {
          nextBestActions: ['call wikikit_proposals with proposal_id to inspect its terminal status'],
        })
      }
      if (!context || !context.formElicitationSupported) {
        // Hand-off, not an error: the pending proposal is the durable workflow
        // object, and an error frame invites the agent to "fix" the call. The
        // review page is the human's one-click path on exactly these clients.
        // The KEY is the policy: knowledge:approve on an agent-held key is the
        // operator's explicit opt-in to executing the human's chat decision
        // over REST; a review-only key stays strictly hands-off.
        context?.setSpaceSlug(proposal.space)
        context?.setOutcome('handoff')
        const reviewUrl = `${deps.config.publicUrl}/review/${proposal.id}`
        const chatDecisionSanctioned = holdsScope(principal.scopes, 'knowledge:approve')
        return {
          proposal_id: proposal.id,
          status: 'pending',
          outcome: 'human_review_required',
          mutation_applied: false,
          review_url: reviewUrl,
          poll_with: 'wikikit_proposals',
          agent_instructions: chatDecisionSanctioned
            ? 'This MCP client cannot present WikiKit’s native review form. This key holds knowledge:approve — the operator’s ' +
              'explicit opt-in for executing the human’s decision from this conversation. If the user has clearly and explicitly ' +
              'instructed approve or reject for exactly this proposal, execute that instruction via REST ' +
              `(POST ${deps.config.publicUrl}/v1/proposals/${proposal.id}/approve or …/reject), quoting the user’s words in the note. ` +
              'Never decide, suggest, or default yourself. Without an explicit instruction, give the user this link so they decide ' +
              `directly: ${reviewUrl} Confirm the recorded outcome via wikikit_proposals afterwards.`
            : 'This MCP client cannot present WikiKit’s native review form, so the approve/reject decision cannot be collected here. ' +
              `The proposal stays pending. Give the user this link so they can review and decide themselves: ${reviewUrl} ` +
              'The page also supports deferring single concepts into child proposals and requesting changes with a revision note. ' +
              'Do not ask for the decision in chat, do not pass a decision to any tool, ' +
              'and do not call the REST approve/reject endpoints on the human’s behalf. ' +
              'Check wikikit_proposals later to see whether the human has decided — a rejected proposal with ' +
              'changes_requested:true carries a review_note that is your revision brief for a FRESH proposal.',
        }
      }
      context.setSpaceSlug(proposal.space)

      const review = await elicitProposalReview(context.elicitForm, toProposalWire(proposal))
      if (review.action !== 'accept') {
        context.setOutcome(review.action === 'decline' ? 'rejected' : 'cancelled')
        return { proposal_id: proposal.id, outcome: review.action, mutation_applied: false }
      }

      const common = {
        id: proposal.id,
        reviewer: principal.name,
        note: review.content.note,
        reviewChannel: 'mcp_elicitation' as const,
      }
      if (review.content.decision === 'approve') {
        return approveProposal(deps.db, common)
      }
      return rejectProposal(deps.db, common)
    },
  },
]

// ---------------------------------------------------------------------------

/** Tools the key may SEE (and therefore call) — scope-gating is visibility. */
export function visibleTools(scopes: string[]): McpToolDef[] {
  return TOOLS.filter((tool) => holdsScope(scopes, tool.scope))
}

/** Wire shape of one tools/list entry — what the contract test snapshots. */
export interface ToolManifestEntry {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: ToolAnnotations
}

export function buildToolManifest(scopes: string[]): ToolManifestEntry[] {
  return visibleTools(scopes).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema7(tool.inputSchema),
    annotations: tool.annotations,
  }))
}
