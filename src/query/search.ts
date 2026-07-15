// Search — the LLM-free retrieval surface (plan §5: "/search = LLM-freie
// Rohevidenz"). A thin, typed wrapper over the wk_search SQL function
// (CONTRACTS §1.15) reached exclusively through the db.call whitelist.
//
// WHY all ranking lives in SQL and none here: wk_search joins revisions over
// wk_concepts.current_revision_id, so proposed/rejected content is invisible
// BY CONSTRUCTION — re-implementing any filtering in TypeScript would create
// a second place for that visibility rule to rot. This module only validates
// the boundary (zod, house rule) and maps column names to the wire shape
// (concept_slug → slug) shared by REST /search and the wikikit_search MCP
// tool.
import { z } from 'zod'
import type { Db } from '../db/postgres.ts'

const zSearchArgs = z.object({
  q: z.string().min(1).max(1000),
  kind: z.enum(['concept', 'claim']).optional(),
  // Mirrors the wikikit_search tool schema (1-50, default 20) so REST and MCP
  // enforce identical caps.
  limit: z.number().int().min(1).max(50).default(20),
})

export type SearchArgs = z.input<typeof zSearchArgs>

export interface SearchHit {
  kind: 'concept' | 'claim'
  /** Concept slug (set for both hit kinds — claims belong to a concept). */
  slug: string | null
  /** Set only for kind='claim'. */
  claim_id: string | null
  title: string
  /** ts_headline excerpt with <mark>…</mark> around the matched terms. */
  headline: string
  rank: number
}

interface SearchRow {
  kind: string
  concept_slug: string | null
  claim_id: string | null
  title: string
  headline: string
  rank: number | string
}

/**
 * Ranked full-text hits over current revisions + visible claims. LLM-free by
 * contract: this must work without an ANTHROPIC_API_KEY (zero-config
 * principle — search/read/lint stay first-class on keyless deployments).
 */
export async function search(db: Db, spaceId: string, args: SearchArgs): Promise<SearchHit[]> {
  const input = zSearchArgs.parse(args)
  const rows = await db.call<SearchRow>('wk_search', [spaceId, input.q, input.kind ?? null, input.limit])
  return rows.map((row) => ({
    kind: row.kind === 'claim' ? ('claim' as const) : ('concept' as const),
    slug: row.concept_slug,
    claim_id: row.claim_id,
    title: row.title,
    headline: row.headline,
    // pg returns real as number, but Number() also covers stubbed pools and
    // exotic drivers returning strings — rank is sorted on by clients.
    rank: Number(row.rank),
  }))
}
