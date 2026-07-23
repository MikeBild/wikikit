// Search — the LLM-free retrieval surface (plan §5: "/search = LLM-freie
// Rohevidenz"). A thin, typed wrapper over the wk_search / wk_search_sources
// SQL functions (CONTRACTS §1.15) reached exclusively through the db.call
// whitelist.
//
// WHY all ranking lives in SQL and none here: wk_search joins revisions over
// wk_concepts.current_revision_id, so proposed/rejected content is invisible
// BY CONSTRUCTION — re-implementing any filtering in TypeScript would create
// a second place for that visibility rule to rot. This module only validates
// the boundary (zod, house rule), composes the two retrieval TIERS and maps
// column names to the wire shape (concept_slug → slug) shared by REST
// /search and the wikikit_search MCP tool.
//
// Tiers (mode):
//   approved_only         — current revisions + visible claims. The default;
//                           byte-identical behavior to the pre-tier wire.
//   approved_then_sources — additionally searches the archived source chunks
//                           (wk_source_chunks). Source hits are APPENDED
//                           after every approved hit and labeled
//                           tier:'source_evidence' — never interleaved:
//                           ts_rank values across different corpora are not
//                           comparable, and the separation is what lets a
//                           client honestly say "approved knowledge" vs
//                           "found only in an archived source". The limit
//                           applies PER TIER (a full approved page must not
//                           starve the evidence tier).
import { z } from 'zod'
import type { Db } from '../db/postgres.ts'
import { readImports } from '../domain/space-refs.ts'
import type { LlmProvider } from '../llm/provider.ts'

const zSearchArgs = z.object({
  q: z.string().min(1).max(1000),
  kind: z.enum(['concept', 'claim']).optional(),
  // Mirrors the wikikit_search tool schema (1-50, default 20) so REST and MCP
  // enforce identical caps.
  limit: z.number().int().min(1).max(50).default(20),
  mode: z.enum(['approved_only', 'approved_then_sources']).default('approved_only'),
})

export type SearchArgs = z.input<typeof zSearchArgs>

/**
 * Optional hybrid-retrieval wiring. When BOTH the pgvector capability probe
 * and an embedding provider are present, searches go through the RRF hybrid
 * functions; otherwise (or when the query embedding fails) retrieval stays
 * purely lexical — embeddings only ever ADD a ranker, they never gate.
 */
export interface SearchDeps {
  llm?: Pick<LlmProvider, 'embedConfigured' | 'embed'>
  vector?: { available: boolean }
}

export interface SearchHit {
  kind: 'concept' | 'claim' | 'source_chunk'
  /** Which retrieval tier produced the hit — the honesty label. */
  tier: 'approved' | 'source_evidence'
  /** Hybrid searches report which arm(s) found the hit; absent on lexical-only. */
  matched_via?: 'lexical' | 'vector' | 'both'
  /** Concept slug (both approved kinds; null for source chunks). */
  slug: string | null
  /** Set only for kind='claim'. */
  claim_id: string | null
  title: string
  /** ts_headline excerpt with <mark>…</mark> around the matched terms. */
  headline: string
  rank: number
  /** Set only for kind='source_chunk'. */
  source_id: string | null
  chunk_id: string | null
  url: string | null
  heading: string | null
}

interface SearchRow {
  kind: string
  concept_slug: string | null
  claim_id: string | null
  title: string
  headline: string
  rank: number | string
  matched_via?: string
}

interface SourceChunkRow {
  source_id: string
  chunk_id: string
  chunk_index: number
  title: string | null
  url: string | null
  heading: string | null
  headline: string
  rank: number | string
  matched_via?: string
}

/**
 * Query embedding for the hybrid arms, serialized to pgvector's text input
 * form. Returns null when hybrid is not available or the embed call fails —
 * the caller falls back to lexical, never errors (deterministic floor).
 */
async function queryEmbedding(deps: SearchDeps, q: string): Promise<string | null> {
  if (!deps.vector?.available || !deps.llm?.embedConfigured) return null
  try {
    const result = await deps.llm.embed({ texts: [q] })
    const vector = result.output.embeddings[0]
    if (!vector?.length) return null
    return `[${vector.join(',')}]`
  } catch {
    // An embedding outage must never take search down with it.
    return null
  }
}

function asMatchedVia(value: string | undefined): 'lexical' | 'vector' | 'both' | undefined {
  return value === 'lexical' || value === 'vector' || value === 'both' ? value : undefined
}

/**
 * Ranked full-text hits over current revisions + visible claims — plus, in
 * approved_then_sources mode, archived source chunks as a second, clearly
 * labeled tier. LLM-free by contract: this must work without an API key
 * (zero-config principle — search/read/lint stay first-class on keyless
 * deployments).
 */
export async function search(db: Db, spaceId: string, args: SearchArgs, deps: SearchDeps = {}): Promise<SearchHit[]> {
  const input = zSearchArgs.parse(args)
  const embedding = await queryEmbedding(deps, input.q)

  const rows = embedding
    ? await db.call<SearchRow>('wk_search_hybrid', [spaceId, input.q, embedding, input.kind ?? null, input.limit])
    : await db.call<SearchRow>('wk_search', [spaceId, input.q, input.kind ?? null, input.limit])
  const hits: SearchHit[] = rows.map((row) => ({
    kind: row.kind === 'claim' ? ('claim' as const) : ('concept' as const),
    tier: 'approved' as const,
    ...(asMatchedVia(row.matched_via) ? { matched_via: asMatchedVia(row.matched_via) } : {}),
    slug: row.concept_slug,
    claim_id: row.claim_id,
    title: row.title,
    headline: row.headline,
    // pg returns real as number, but Number() also covers stubbed pools and
    // exotic drivers returning strings — rank is sorted on by clients. NOTE:
    // hybrid rank is an RRF score (~0.03 max), lexical rank is ts_rank —
    // comparable within one response, never across responses.
    rank: Number(row.rank),
    source_id: null,
    chunk_id: null,
    url: null,
    heading: null,
  }))

  // Source-evidence tier: only when the caller opts in, and only for
  // unfiltered searches — a kind filter names the approved shapes explicitly.
  if (input.mode === 'approved_then_sources' && !input.kind) {
    const chunkRows = embedding
      ? await db.call<SourceChunkRow>('wk_search_sources_hybrid', [spaceId, input.q, embedding, input.limit])
      : await db.call<SourceChunkRow>('wk_search_sources', [spaceId, input.q, input.limit])
    for (const row of chunkRows) {
      hits.push({
        kind: 'source_chunk',
        tier: 'source_evidence',
        ...(asMatchedVia(row.matched_via) ? { matched_via: asMatchedVia(row.matched_via) } : {}),
        slug: null,
        claim_id: null,
        title: row.title ?? row.heading ?? 'Untitled source',
        headline: row.headline,
        rank: Number(row.rank),
        source_id: row.source_id,
        chunk_id: row.chunk_id,
        url: row.url,
        heading: row.heading,
      })
    }
  }

  return hits
}

/** A hit tagged with the space that produced it (0023 provenance). */
export type FederatedHit = SearchHit & { space: string }

/**
 * Search the request space and — when it declares settings.imports — every
 * imported space that still exists, tagging each hit with its origin space.
 * Hits merge by rank WITHIN each tier (approved first, source_evidence
 * after), never across tiers. The transports own the authorization half:
 * space-scoped keys must be rejected BEFORE calling this.
 */
export async function searchAcrossImports(
  db: Db,
  space: { id: string; slug: string; settings: Record<string, unknown> },
  args: SearchArgs,
  deps: SearchDeps = {},
): Promise<{ hits: FederatedHit[]; searched_spaces: string[] }> {
  const searched: string[] = [space.slug]
  const hits: FederatedHit[] = (await search(db, space.id, args, deps)).map((hit) => ({ ...hit, space: space.slug }))
  for (const importSlug of readImports(space.settings)) {
    if (importSlug === space.slug) continue
    const [imported] = await db.select<{ id: string }>('wk_spaces', { slug: `eq.${importSlug}`, limit: 1 })
    // A declared import naming a deleted space degrades to "skipped" — the
    // declaration is intent, not a foreign-key.
    if (!imported) continue
    searched.push(importSlug)
    for (const hit of await search(db, imported.id, args, deps)) hits.push({ ...hit, space: importSlug })
  }
  // Rank-merge within tiers across spaces (same scoring scale per arm).
  const tierOrder = { approved: 0, source_evidence: 1 } as const
  hits.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || b.rank - a.rank)
  return { hits, searched_spaces: searched }
}
