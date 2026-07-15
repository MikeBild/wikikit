// MCP tool palette (CONTRACTS §7.1 — binding: names, schemas, scopes, all
// four annotations). Thin dispatch over the SAME domain modules REST consumes;
// no knowledge logic lives here.
//
// Zod-first (SubKit learning): the write tools reuse the exact zod objects the
// rest of the system validates with — `zIngestInput` (the ingest pipeline's
// boundary schema, shared with HTTP's zIngestRequest) and `zCreateProposalArgs`
// (exported from domain/proposals.ts precisely so HTTP and MCP validate the
// SAME staging shape). `safeExtend` adds the `space` argument while PRESERVING
// the cross-field refinements (exactly-one-of markdown|text|url, at-least-one
// concept/decision) — a plain `.extend` would silently drop them.
//
// Scope-gating = tool VISIBILITY (SubKit pattern): a knowledge:read key never
// sees the write tools in tools/list, and calling an invisible tool is
// indistinguishable from calling a nonexistent one. There is deliberately NO
// approve tool — agents write into the staging area; promotion is a human act
// over REST (or later SubKit governance) with a knowledge:approve key that
// this palette never requests.
import { z } from 'zod'
import type { Config } from '../config.ts'
import type { Db } from '../db/postgres.ts'
import { getConcept, getConceptHistory, toConceptResponse } from '../domain/concepts.ts'
import { ForbiddenError, LlmNotConfiguredError, NotFoundError } from '../domain/errors.ts'
import { getDecision, listDecisions } from '../domain/decisions.ts'
import { lintSpace } from '../domain/lint.ts'
import { createProposal, zCreateProposalArgs } from '../domain/proposals.ts'
import { isoString } from '../domain/sources.ts'
import { zIngestInput, type IngestPipeline } from '../ingest/pipeline.ts'
import { search } from '../query/search.ts'
import { zodToJsonSchema7 } from './json-schema.ts'

/**
 * The Principal resolved by src/http/auth.ts (CONTRACTS §5.4) — re-exported
 * so every MCP module (and its tests) names one canonical identity type.
 * MCP and REST share the same credential surface by contract.
 */
export type { Principal } from '../http/auth.ts'
import type { Principal } from '../http/auth.ts'

/** The only scopes MCP tools may require — approve is REST-only by design. */
export type ToolScope = 'knowledge:read' | 'knowledge:propose'

/**
 * Scope semantics per CONTRACTS §5.2: `*` and `admin` imply all knowledge
 * scopes (admin does not imply `*`, but every MCP tool scope IS a knowledge
 * scope, so both grant full tool visibility).
 */
export function holdsScope(scopes: string[], scope: ToolScope): boolean {
  return scopes.includes(scope) || scopes.includes('*') || scopes.includes('admin')
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
}

export interface McpToolDef {
  name: string
  description: string
  scope: ToolScope
  inputSchema: z.ZodType
  annotations: ToolAnnotations
  execute(deps: ToolDeps, principal: Principal, input: unknown): Promise<unknown>
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
  limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 20)'),
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

// ---------------------------------------------------------------------------

/**
 * Resolve a space slug and enforce the key/space binding in one place.
 * Mirrors domain getSpaceBySlug (CONTRACTS §4) plus the transport duty from
 * §5.2: a space-scoped key may only touch its own space → 403, not 404 —
 * the space exists, the key just cannot use it.
 */
async function resolveSpace(db: Db, principal: Principal, slug: string): Promise<{ id: string; slug: string }> {
  const [space] = await db.select<{ id: string; slug: string }>('wk_spaces', { slug: `eq.${slug}`, limit: 1 })
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
// content (SubKit learning: never destructiveHint:false on real writes — an
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

export const TOOLS: McpToolDef[] = [
  {
    name: 'wikikit_search',
    description:
      'Ranked full-text search over the knowledge base (current concept revisions and visible claims). ' +
      'Returns raw evidence with <mark> headlines — no synthesis. Use wikikit_read to fetch a full concept.',
    scope: 'knowledge:read',
    inputSchema: zSearchToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zSearchToolInput.parse(input)
      const space = await resolveSpace(deps.db, principal, args.space)
      const hits = await search(deps.db, space.id, { q: args.q, kind: args.kind, limit: args.limit })
      return { hits }
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
      return toConceptResponse(await getConcept(deps.db, space.id, { slug: args.slug }))
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
      // read tools keep working without ANTHROPIC_API_KEY).
      if (!deps.config.llmConfigured) throw new LlmNotConfiguredError()
      const space = await resolveSpace(deps.db, principal, args.space)
      const { space: _space, ...request } = args
      const { ingest_id } = await deps.ingest.enqueue(deps.db, space.id, request)
      // Async-ack contract (§7.1): never block an MCP call on LLM latency.
      return { status: 'running' as const, ingest_id, poll_with: 'wikikit_ingest_status' as const }
    },
  },
  {
    name: 'wikikit_ingest_status',
    description:
      'Poll an ingest job started by wikikit_ingest. Terminal states: done (carries proposal_id) or ' +
      'failed (carries error.code/message).',
    scope: 'knowledge:propose',
    inputSchema: zIngestStatusToolInput,
    annotations: READ_ANNOTATIONS,
    async execute(deps, principal, input) {
      const args = zIngestStatusToolInput.parse(input)
      const [job] = await deps.db.select<{
        id: string
        space_id: string
        status: 'queued' | 'running' | 'done' | 'failed'
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
      'Stage a structured ChangeProposal (concepts with claims/citations/relations, decisions) into ' +
      'the review gate. Nothing becomes visible until a human approves over REST — there is no approve tool.',
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
      const { space: _space, ...proposal } = args
      return createProposal(deps.db, space.id, {
        ...proposal,
        agent_meta: withManualAgentMeta(proposal.agent_meta),
      })
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
