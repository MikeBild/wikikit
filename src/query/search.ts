// Search — the LLM-free retrieval surface (plan §5: "/search = LLM-freie
// Rohevidenz"). A thin, typed wrapper over the wk_search / wk_search_sources
// SQL functions (CONTRACTS §1.15) reached exclusively through the db.call
// whitelist.
//
// WHY all ranking lives in SQL and none here: wk_search joins revisions over
// wk_concepts.current_revision_id, so proposed/rejected content is invisible
// BY CONSTRUCTION — re-implementing any filtering in TypeScript would create
// a second place for that visibility rule to rot. This module only validates
// the boundary (zod, house rule), composes the two retrieval TIERS, maps
// column names to the wire shape (concept_slug → slug) shared by REST
// /search and the wikikit_search MCP tool, and attaches the per-page evidence
// summary to concept hits — the same aggregate the concept list reports, so a
// reader who searches and a reader who browses are told the same thing about
// the same page — or, where there is no measurement to give, the reason there
// is none (see SearchHit.evidence and SearchHit.not_measured for what the other
// two kinds carry and why it is nothing).
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
import { conceptReadingsBySlug, type ConceptEvidence, type ConceptNotMeasured } from '../domain/concepts.ts'
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
  /**
   * The installation's scaffolding markers, forwarded to the evidence
   * aggregate below. It rides in this bag rather than in SearchArgs because it
   * is not something a caller of /search asks for — it is deployment
   * configuration, and SearchArgs is the validated wire input; the transports
   * fill it from `deps.config`.
   *
   * REQUIRED while `llm` and `vector` beside it stay optional, which is the
   * whole reason the guarantee lives in this bag rather than in a second
   * positional argument: those two are genuinely absent on a lexical-only
   * installation, this one never is. See ScaffoldingOptions in
   * domain/concepts.ts for the full argument — this field is the same
   * guarantee reaching the one read that takes its markers through a deps bag.
   */
  scaffoldingKinds: readonly string[]
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
  /**
   * How well the page behind a CONCEPT hit is evidenced — the same three
   * numbers the concept list carries, from the same aggregate (see
   * ConceptEvidence). A search result is the other place a reader picks which
   * page to open, and it faced the same blind choice the list did: "how does
   * the wiki know this?" is not answerable from a ranked headline.
   *
   * Present on every kind='concept' hit the aggregate can answer for. Two
   * absences, neither of them a measured zero and neither to be dressed as one:
   * a page that stopped being readable between the ranking and the count, which
   * carries nothing at all because there is no row left to describe; and a
   * reference target — a page whose current revision is scaffolding, which holds
   * no knowledge to be evidenced — which carries `not_measured` below instead.
   * Both come out of one call on one aggregate (`conceptReadingsBySlug`), so a
   * hit and the index row for the same slug cannot disagree about which.
   *
   * DELIBERATELY ABSENT on the other two kinds:
   *
   *   kind='claim' — a claim hit raises a different question ("is THIS claim
   *     quoted?"), and none of the three answers it. Lending it the page's
   *     numbers would put `claims: 12` on a single claim and let
   *     `uncited_claims: 3` be read as a verdict on the matched claim rather
   *     than on its neighbours. The honest per-claim answer is a fourth,
   *     differently shaped number; until something asks for it, silence beats
   *     a number that invites the wrong reading.
   *
   *   kind='source_chunk' — the source-evidence tier is explicitly NOT
   *     approved knowledge; the tier label exists to say so. An evidence
   *     summary on such a hit would assert the opposite of what the hit means,
   *     and it is the worst misreading available here: an archived paragraph
   *     nobody has reviewed would show up wearing the badge of a curated page.
   *     A chunk also has no concept to count over — its slug is null.
   */
  evidence?: ConceptEvidence
  /**
   * Why a CONCEPT hit carries no `evidence` — the same object, from the same
   * function, that the concept list row for this slug carries (see
   * ConceptNotMeasured in src/domain/concepts.ts).
   *
   * It is here and not only on the index because the two surfaces disagreeing
   * about one page is the failure this whole line of work exists to prevent: a
   * reader who searches and then browses is comparing two reads of one fact, and
   * "2 claims withheld" on one screen beside a bare silence on the other reads
   * as a wiki that does not know what it holds. A field added to the index and
   * forgotten here would be a contract that tells the truth on exactly one
   * surface, which is the hardest kind of lie to notice.
   *
   * ABSENT — alongside `evidence` — on the three hits that have no page to
   * describe: kind='claim', kind='source_chunk' (both for the reasons above),
   * and a concept hit whose page stopped being readable between the ranking and
   * the count. That last one is silence with no reason attached ON PURPOSE:
   * there is no readable row, so the wiki has nothing to say about it, and
   * inventing a reason for a page that is gone would be the console's old
   * inference moved one layer down.
   */
  not_measured?: ConceptNotMeasured
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
export async function search(db: Db, spaceId: string, args: SearchArgs, deps: SearchDeps): Promise<SearchHit[]> {
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

  // Evidence for the concept hits, batched into ONE statement (see
  // conceptEvidenceBySlug for why it cannot ride along inside wk_search).
  //
  // The cost, stated: at most one extra statement per search, and it is issued
  // only when the page actually holds concept hits — a kind='claim' search, a
  // source-only match and a miss all still cost exactly what they cost before.
  // Its input is bounded by the SAME cap as the search itself (zSearchArgs
  // limit ≤ 50, hard-clamped at the boundary and mirrored in the MCP tool
  // schema), so the aggregate here runs over at most 50 concepts — a quarter of
  // the 200 the concept list already runs it over inside one statement, and
  // fewer in practice because claim hits collapse onto their concept and
  // duplicates are removed. Per concept it is one index scan on
  // wk_claims_concept_idx plus one wk_citations_claim_idx probe per visible
  // claim, on covered indexes; the added latency is one round trip, not a scan.
  // Federated searches pay it once per space that produced a concept hit,
  // because each space must be counted in its own space_id.
  const conceptSlugs = hits.flatMap((hit) => (hit.kind === 'concept' && hit.slug ? [hit.slug] : []))
  if (conceptSlugs.length > 0) {
    const readings = await conceptReadingsBySlug(db, spaceId, conceptSlugs, {
      scaffoldingKinds: deps.scaffoldingKinds,
    })
    for (const hit of hits) {
      if (hit.kind !== 'concept' || !hit.slug) continue
      // Whichever half the reading holds, assigned by name and never merged:
      // the reading carries exactly one of the two, and Object.assign-ing it
      // wholesale would put a key with an `undefined` value on the hit, which
      // `'evidence' in hit` sees and JSON.stringify does not.
      const reading = readings.get(hit.slug)
      if (reading?.evidence) hit.evidence = reading.evidence
      if (reading?.not_measured) hit.not_measured = reading.not_measured
    }
  }

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
  deps: SearchDeps,
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
