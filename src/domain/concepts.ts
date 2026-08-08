// wk_concepts / wk_concept_revisions — the wiki-page read model (CONTRACTS
// §1.3, §1.4, §4).
//
// The visibility rule everything here relies on: a concept is readable ONLY
// through wk_concepts.current_revision_id. Revisions are immutable; proposed
// revisions exist as rows but are invisible BY CONSTRUCTION because every
// read joins over the current pointer — there is no status filter to forget.
// The single exception is getConceptHistory, whose entire purpose is the
// audit trail (all statuses, with agent_meta).
import type { Db } from '../db/postgres.ts'
import { VISIBLE_CLAIM_STATUSES, type ClaimWithCitations, listClaimsForConcept } from './claims.ts'
import { NotFoundError } from './errors.ts'
import { clampLimit, decodeCursor, encodeCursor, isoString } from './sources.ts'

/**
 * Per-row answer to "how does the wiki know this?" — the first question a
 * reader of an evidence-backed wiki has, and until now answerable only by
 * opening the page.
 *
 * WHY these three numbers and not others. What a list row must answer is "is
 * this page evidenced, and by how much", and that needs exactly a total, a
 * shortfall and a breadth:
 *   - `claims` alone cannot distinguish ten cited claims from ten bare
 *     assertions, so it cannot answer the question at all.
 *   - `uncited_claims` is the alarm — the only one of the three where a
 *     non-zero value is bad news — and it is only readable against `claims`.
 *   - `sources` is breadth: five claims from one source is a page that rests
 *     on one document, five claims from five sources is a corroborated one.
 * Rejected: a total CITATION count (it flatters a page that quotes the same
 * document ten times, which is exactly the page a reader should be warned
 * about), and source ids/titles (a second read per row — the list is where you
 * decide WHICH page to open, not where you chase provenance; that is §5.3).
 *
 * Nested rather than three flat columns because these three only mean anything
 * read together, and one named object keeps `evidence.claims` unambiguous
 * against `zConceptResponse.claims`, which is the claim ARRAY.
 */
export interface ConceptEvidence {
  /** Visible claims the page makes (VISIBLE_CLAIM_STATUSES — staged claims are not knowledge). */
  claims: number
  /** Subset of `claims` with no wk_citations row at all. */
  uncited_claims: number
  /** DISTINCT wk_citations.source_id across those claims. */
  sources: number
}

export interface ConceptSummary {
  slug: string
  title: string
  summary: string
  rev: number
  updated_at: string
  evidence: ConceptEvidence
}

/** Compact index handed to the classify LLM call — slug/title/summary only. */
export interface ConceptIndexEntry {
  slug: string
  title: string
  summary: string
}

export type RelationKindValue = 'related' | 'part_of' | 'depends_on' | 'contradicts' | 'supersedes'

/**
 * Full concept read. A SUPERSET of the §5.3 wire contract: revision_id (the
 * stale-base anchor the ingest pipeline synthesizes against) and the per-claim
 * audit fields never leave the process — both transports serve
 * toConceptResponse(detail), never this shape verbatim.
 */
export interface ConceptDetail {
  slug: string
  title: string
  summary: string
  markdown: string
  rev: number
  /** Id of the current revision — what a synthesis based on this read must anchor to. */
  revision_id: string
  updated_at: string
  claims: ClaimWithCitations[]
  relations: { to_slug: string; kind: RelationKindValue; space: string | null }[]
  agent_meta: Record<string, unknown>
}

/**
 * The §5.3 zConceptResponse wire mapping, shared by REST getConceptHandler
 * AND MCP wikikit_read so the two transports can never disagree. Explicit
 * field-by-field: ConceptDetail carries more (revision_id; per-claim
 * valid_from/valid_until/created_at/agent_meta) than the published contract —
 * serve exactly the contract, no accidental surface.
 */
export function toConceptResponse(concept: ConceptDetail): Record<string, unknown> {
  return {
    slug: concept.slug,
    title: concept.title,
    summary: concept.summary,
    markdown: concept.markdown,
    rev: concept.rev,
    updated_at: concept.updated_at,
    claims: concept.claims.map((claim) => ({
      id: claim.id,
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      status: claim.status,
      confidence: claim.confidence,
      citations: claim.citations,
    })),
    relations: concept.relations,
    agent_meta: concept.agent_meta,
  }
}

export interface RevisionSummary {
  id: string
  rev: number
  status: 'proposed' | 'current' | 'superseded' | 'rejected'
  title: string
  summary: string
  base_revision_id: string | null
  proposal_id: string | null
  agent_meta: Record<string, unknown>
  created_at: string
}

interface ConceptRevisionRow {
  concept_id: string
  revision_id: string
  slug: string
  title: string
  summary: string
  markdown: string
  rev: number
  updated_at: Date | string
  agent_meta: Record<string, unknown>
}

/**
 * List readable concepts (those with a current revision) with keyset
 * pagination and the space epoch (the ETag driver for list endpoints).
 *
 * WHY slug-ordered instead of updated_at: a wiki listing is an index, and a
 * slug keyset is immune to rows moving while a client pages (an approval
 * bumping updated_at would make a time-ordered keyset skip or repeat).
 *
 * Every row carries its `evidence` (see ConceptEvidence): in a product whose
 * premise is that each claim quotes an archived source, "how does the wiki
 * know this?" is the first question a reader has, and answering it per row is
 * what lets a caller decide which page to open. It is counted in THIS
 * statement — never a second read per row, which on a 200-row page would be
 * 200 round trips for three integers.
 */
export async function listConcepts(
  db: Db,
  spaceId: string,
  args: { limit?: number; after?: string } = {},
): Promise<{ items: ConceptSummary[]; next_after: string | null; epoch: number }> {
  const limit = clampLimit(args.limit, 50, 200)
  const [space] = await db.select<{ epoch: string | number }>('wk_spaces', { id: `eq.${spaceId}`, limit: 1 })
  if (!space) throw new NotFoundError('space not found')

  const values: unknown[] = [spaceId]
  let keyset = ''
  if (args.after) {
    const [slug] = decodeCursor(args.after, 1)
    values.push(slug)
    keyset = ' AND c.slug > $2'
  }
  values.push(limit + 1)
  const { rows } = await db.query<{
    slug: string
    title: string
    summary: string
    rev: number
    updated_at: Date
    claims: number
    uncited_claims: number
    sources: number
  }>(
    // The keyset page is computed FIRST, in its own CTE, and the evidence
    // lateral hangs off that. Written the obvious way — lateral on the main
    // FROM, LIMIT at the top — the planner is free to sort-then-limit, and
    // then the lateral runs once per concept IN THE SPACE instead of once per
    // row returned. On the 5000-page wiki that most needs this feature that is
    // the difference between 51 index probes and 5000. With the LIMIT inside
    // the CTE the bound is structural, not a plan the optimizer happens to
    // pick today.
    //
    // Cost at the 200-row clamp (`clampLimit` above): one extra statement is
    // NOT issued — this is still the same single round trip. Per page row the
    // lateral does one index scan on wk_claims_concept_idx (concept_id,
    // status) plus one wk_citations_claim_idx probe per visible claim. So the
    // work is linear in the CLAIMS on the page (≈ 201 + Σ claims probes),
    // never quadratic in rows: a 200-row page of 30-claim pages is ~6000 index
    // probes on covered indexes, not 200 × 200 anything. One lateral
    // evaluation is wasted on the +1 lookahead row that `slice` drops; paying
    // for one extra row beats a second statement to avoid it.
    //
    // count(DISTINCT) over the claim×citation fan-out rather than a nested
    // pre-aggregate per claim: the fan-out is citations-per-claim (single
    // digits), and `sources` needs the distinct across the whole page anyway,
    // so the nested form would buy nothing and cost a second grouping level.
    //
    // The statuses are interpolated, not bound: they are a frozen module-level
    // `as const` in claims.ts, never input, so there is no injection surface —
    // and literals let the planner use the status column's statistics, which
    // `= ANY($n::text[])` does not. Reused from VISIBLE_CLAIM_STATUSES so the
    // list and the detail read can never disagree about what "visible" means.
    // Keeping them out of `values` also keeps the `$${values.length}` cursor
    // arithmetic above readable.
    `WITH page AS (
       SELECT c.id, c.slug, r.title, r.summary, r.rev, c.updated_at
         FROM wk_concepts c
         JOIN wk_concept_revisions r ON r.id = c.current_revision_id
        WHERE c.space_id = $1${keyset}
        ORDER BY c.slug ASC
        LIMIT $${values.length}
     )
     SELECT p.slug, p.title, p.summary, p.rev, p.updated_at,
            ev.claims, ev.uncited_claims, ev.sources
       FROM page p
       CROSS JOIN LATERAL (
         SELECT count(DISTINCT cl.id)::int AS claims,
                count(DISTINCT cl.id) FILTER (WHERE ci.id IS NULL)::int AS uncited_claims,
                count(DISTINCT ci.source_id)::int AS sources
           FROM wk_claims cl
           LEFT JOIN wk_citations ci ON ci.claim_id = cl.id
          WHERE cl.space_id = $1
            AND cl.concept_id = p.id
            AND cl.status IN (${VISIBLE_CLAIM_STATUSES.map((status) => `'${status}'`).join(', ')})
       ) ev
      ORDER BY p.slug ASC`,
    values,
  )
  const page = rows.slice(0, limit)
  const items = page.map((row) => ({
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    rev: row.rev,
    updated_at: isoString(row.updated_at),
    // Zero is MEASURED, never absent. An un-grouped aggregate returns exactly
    // one row even when the concept has no claims at all, which is why this is
    // a CROSS JOIN and not a LEFT JOIN with a COALESCE: there is no NULL to
    // defend against, by construction. That matters because "this page cites
    // nothing" is the single most important fact this change surfaces — a page
    // written by hand through the console has zero claims and looked exactly
    // like a fully cited one until now. Nullable numbers would be rendered as
    // "unknown" (the console reserves an em dash for what nobody sent), and
    // "makes no claims" must never look like "we did not ask".
    evidence: { claims: row.claims, uncited_claims: row.uncited_claims, sources: row.sources },
  }))
  const last = page.at(-1)
  return {
    items,
    next_after: rows.length > limit && last ? encodeCursor(last.slug) : null,
    epoch: Number(space.epoch),
  }
}

/**
 * Full concept read: current revision + visible claims with citations +
 * active outgoing relations. A concept whose only revisions are proposed (or
 * rejected) has no current pointer and is a 404 — indistinguishable from a
 * concept that never existed, which is exactly the staging-area contract.
 */
export async function getConcept(db: Db, spaceId: string, args: { slug: string }): Promise<ConceptDetail> {
  const { rows } = await db.query<ConceptRevisionRow>(
    `SELECT c.id AS concept_id, r.id AS revision_id, c.slug, r.title, r.summary, r.markdown, r.rev, c.updated_at, r.agent_meta
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1 AND c.slug = $2`,
    [spaceId, args.slug],
  )
  const concept = rows[0]
  if (!concept) throw new NotFoundError(`concept ${args.slug} not found`)

  const claims = await listClaimsForConcept(db, spaceId, {
    conceptId: concept.concept_id,
    statuses: [...VISIBLE_CLAIM_STATUSES],
  })

  // Outgoing relations only, per zConceptResponse ({to_slug, kind}) — the
  // bidirectional view lives in relations.listRelations.
  // Cross-space targets (0023) carry the target space slug for provenance;
  // a dangling foreign target (space deleted, cascade removed the row) simply
  // no longer joins. Targets that lost their readable page are filtered like
  // local ones never were — lint surfaces those.
  const relations = await db.query<{ to_slug: string; kind: RelationKindValue; space: string | null }>(
    `SELECT t.slug AS to_slug, rel.kind,
            CASE WHEN rel.to_space_id IS NULL THEN NULL ELSE ts.slug END AS space
       FROM wk_relations rel
       JOIN wk_concepts t ON t.id = rel.to_concept_id
       LEFT JOIN wk_spaces ts ON ts.id = rel.to_space_id
      WHERE rel.space_id = $1 AND rel.from_concept_id = $2 AND rel.status = 'active'
      ORDER BY t.slug ASC, rel.kind ASC`,
    [spaceId, concept.concept_id],
  )

  return {
    slug: concept.slug,
    title: concept.title,
    summary: concept.summary,
    markdown: concept.markdown,
    rev: concept.rev,
    revision_id: concept.revision_id,
    updated_at: isoString(concept.updated_at),
    claims,
    relations: relations.rows,
    agent_meta: concept.agent_meta ?? {},
  }
}

/**
 * Revision history INCLUDING proposed/rejected revisions and their agent_meta
 * (model, prompt_version, input_hash, source_ids) — the audit surface that
 * makes "which model wrote this, from what, reviewed by whom" answerable.
 * Newest first. The concept itself must exist (identity row), but does not
 * need a current revision: history of a still-staged concept is legitimate
 * audit data for knowledge:read holders.
 */
export async function getConceptHistory(db: Db, spaceId: string, args: { slug: string }): Promise<RevisionSummary[]> {
  const [concept] = await db.select<{ id: string }>('wk_concepts', {
    space_id: `eq.${spaceId}`,
    slug: `eq.${args.slug}`,
    limit: 1,
  })
  if (!concept) throw new NotFoundError(`concept ${args.slug} not found`)
  const rows = await db.select<{
    id: string
    rev: number
    status: RevisionSummary['status']
    title: string
    summary: string
    base_revision_id: string | null
    proposal_id: string | null
    agent_meta: Record<string, unknown>
    created_at: Date | string
  }>('wk_concept_revisions', { concept_id: `eq.${concept.id}`, order: 'rev.desc' })
  return rows.map((row) => ({
    id: row.id,
    rev: row.rev,
    status: row.status,
    title: row.title,
    summary: row.summary,
    base_revision_id: row.base_revision_id,
    proposal_id: row.proposal_id,
    agent_meta: row.agent_meta ?? {},
    created_at: isoString(row.created_at),
  }))
}

/**
 * The compact concept index fed to the classify call: every READABLE concept
 * as {slug, title, summary}. Deliberately summary-only — the classifier
 * decides which concepts a source touches, it never needs full bodies (and
 * the index must stay small enough to ship in one prompt).
 */
export async function getConceptIndex(db: Db, spaceId: string): Promise<ConceptIndexEntry[]> {
  const { rows } = await db.query<ConceptIndexEntry>(
    `SELECT c.slug, r.title, r.summary
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1
      ORDER BY c.slug ASC`,
    [spaceId],
  )
  return rows
}
