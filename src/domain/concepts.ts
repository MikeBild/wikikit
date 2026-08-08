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
  /**
   * ABSENT for a page the measurement does not apply to — a reference target
   * (the scaffolding markers below), which holds no knowledge to be evidenced.
   * Present on every other row, and there it is three measured integers where
   * `0` is a fact about the page. Absence and zero are different statements
   * and a reader must not have to guess which one they are holding.
   */
  evidence?: ConceptEvidence
}

/**
 * The evidence aggregate itself — ONE definition of how the three numbers are
 * counted, shared by every read that reports a ConceptEvidence (the concept
 * list below, the concept hits of /search via conceptEvidenceBySlug, and the
 * `unsourced-concepts` lint rule, which asks this same aggregate for the pages
 * whose `sources` is zero).
 *
 * WHY a shared fragment rather than the obvious second copy: what is encoded
 * here is the visibility rule, and a reader who scans a search result and then
 * the index is comparing two reads of one fact. A list saying "6 claims, 2
 * uncited" beside a search hit saying "4 claims" for the same page does not
 * read as two implementations — it reads as a wiki that does not know what it
 * holds. Two copies would also be two places to forget a status when the
 * visible set next changes.
 *
 * CONTRACT for a caller: the enclosing statement must expose the concept row as
 * `p` (specifically `p.id`) and bind the space id as `$1`. Every call site
 * builds a `page` CTE that does exactly that. Exported rather than module-local
 * because the linter's copy of this count was the one that would drift
 * unnoticed: a report saying "no archived source stands behind this page" for a
 * page the index lists with `sources: 1` is not two implementations to a user,
 * it is a wiki that does not know what it holds.
 *
 * count(DISTINCT) over the claim×citation fan-out rather than a nested
 * pre-aggregate per claim: the fan-out is citations-per-claim (single digits),
 * and `sources` needs the distinct across the whole page anyway, so the nested
 * form would buy nothing and cost a second grouping level.
 *
 * The statuses are interpolated, not bound: they are a frozen module-level
 * `as const` in claims.ts, never input, so there is no injection surface — and
 * literals let the planner use the status column's statistics, which
 * `= ANY($n::text[])` does not. Reused from VISIBLE_CLAIM_STATUSES so no read
 * can disagree with any other about what "visible" means.
 */
export const EVIDENCE_LATERAL = `SELECT count(DISTINCT cl.id)::int AS claims,
                count(DISTINCT cl.id) FILTER (WHERE ci.id IS NULL)::int AS uncited_claims,
                count(DISTINCT ci.source_id)::int AS sources
           FROM wk_claims cl
           LEFT JOIN wk_citations ci ON ci.claim_id = cl.id
          WHERE cl.space_id = $1
            AND cl.concept_id = p.id
            AND cl.status IN (${VISIBLE_CLAIM_STATUSES.map((status) => `'${status}'`).join(', ')})`

// Revision kinds that mark a page as SCAFFOLDING rather than knowledge: rows a
// migration or a structural-bookkeeping pass created so an edge had somewhere
// to land, never a page anybody wrote to be read. Such a page says as much on
// its own face — its body is the one sentence explaining that it holds the
// target of reviewed relations and that the knowledge is on the pages it points
// at.
//
// It lives HERE, beside the aggregate, and not in the linter that first needed
// it, because two callers now act on the same fact and a second copy of this
// list would be a second answer to "which rows are furniture":
//
//   - lint.ts SUPPRESSES fault reports about them. Every page-level rule that
//     reports a FAULT excludes them — orphan-concepts, unsourced-concepts,
//     empty-concepts — because a rule that reports a scaffolding page is
//     reporting the linter's own furniture, and once a report is mostly
//     furniture nobody reads the rest of it. One list rather than the literal
//     repeated per rule, so those three cannot silently disagree about what
//     counts as a real page. (`stub-concepts` deliberately does NOT consult it;
//     its reasoning is at the rule, and a new page-level rule reaching for
//     notScaffolding is making a claim about faults, not inheriting a default.)
//
//   - the reads in THIS file DECLINE TO MEASURE them. `evidence` answers "how
//     does the wiki know this?", and a reference target holds no knowledge to
//     know: three zeros on such a row are the same three numbers a page that
//     genuinely rests on nothing carries, so an operator reading an index where
//     half the pages are targets sees a wall of stark zeros, goes to the linter
//     to find out what to do about them, and is told — correctly — that nothing
//     is wrong. The linter is right; the index was measuring a page for which
//     the measurement does not apply. Absent, not zero: the same rule
//     `SearchHit.evidence` already holds for a page that stopped being readable
//     (src/http/schemas.ts), extended to a second reason for absence.
//
// Both rest on one fact — these rows are furniture rather than knowledge — and
// neither is a licence to HIDE the page: the index still lists it, `stub-concepts`
// still reaches it, its body and relations still read. Only the measurement is
// withheld.
//
// CONTRACT for a caller: the enclosing statement must expose the CURRENT
// revision as `r` (this reads `r.agent_meta`). The marker is on the revision,
// not on the concept, so a page stops being scaffolding the moment a revision
// that is not scaffolding becomes current — which is what makes the withheld
// measurement self-healing rather than a permanent property of a slug.
//
// WHY the list is no longer a single frozen constant here. `structural-reference`
// is WikiKit's OWN name for the shape — the product creates such a revision and
// the product reads it back, so it is knowledge about WikiKit and belongs in
// WikiKit. Every OTHER marker is a fact about one installation's history: the
// tag some import happened to stamp on the rows it created. A product whose
// stated principle is that it knows nothing about where it runs cannot carry a
// list of somebody's migration tags, so the rest of the set is configuration
// (WIKIKIT_SCAFFOLDING_KINDS, src/config.ts) and arrives through the parameter
// below.
export const BUILT_IN_SCAFFOLDING_KINDS: readonly string[] = ['structural-reference']

/**
 * How an installation's scaffolding markers reach the reads that act on them.
 *
 * The SQL builders below are module-level string fragments, and configuration
 * is not available at module scope in this codebase — so the kinds ride in on
 * the call, the same way `SearchDeps` carries the optional retrieval wiring and
 * `registerWebhookEndpoint` takes its `Config` explicitly. The composition
 * boundaries (src/http/routes.ts handlers and src/mcp/tools.ts executes, both
 * of which hold `deps.config`) are the only places that fill it in.
 *
 * Omitted means BUILT_IN_SCAFFOLDING_KINDS — the product's own marker and
 * nothing else. That is the honest answer for a caller with no installation in
 * scope (every unit test), and it is deliberately NOT the answer a request
 * gets: a live deployment's extra markers come from its configuration, whose
 * own default carries them (see WIKIKIT_SCAFFOLDING_KINDS in src/config.ts).
 */
export interface ScaffoldingOptions {
  readonly scaffoldingKinds?: readonly string[]
}

/**
 * `coalesce(r.agent_meta->>'kind','') NOT IN (…)` for the given markers.
 *
 * Single quotes are doubled rather than trusted. The statuses in
 * EVIDENCE_LATERAL above may be interpolated bare because they are a frozen
 * `as const` that no input can reach; these are not — they come from an
 * operator's environment now, and a fragment that is safe only because
 * src/config.ts happens to validate its input is a fragment that stops being
 * safe the first time somebody adds a second source of kinds. Boot-time
 * validation there is the error message; this is the guarantee.
 */
export function notScaffolding(kinds: readonly string[] = BUILT_IN_SCAFFOLDING_KINDS): string {
  // No markers at all would make `NOT IN ()` a syntax error, and the honest
  // reading of "this installation recognises nothing as scaffolding" is that
  // every page is measurable.
  if (kinds.length === 0) return 'true'
  return `coalesce(r.agent_meta->>'kind', '') NOT IN (${kinds
    .map((kind) => `'${kind.replaceAll("'", "''")}'`)
    .join(', ')})`
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
  options: ScaffoldingOptions = {},
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
    // NULL together, and only for a reference target: the join below withholds
    // the whole aggregate rather than any single column of it.
    claims: number | null
    uncited_claims: number | null
    sources: number | null
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
    // The counting itself is EVIDENCE_LATERAL (above) — the `page` CTE is
    // aliased `p` and the space id is `$1` because that fragment says so, and
    // keeping the statuses out of `values` also keeps the `$${values.length}`
    // cursor arithmetic above readable.
    //
    // LEFT JOIN LATERAL … ON p.measurable, not CROSS JOIN: the row stays in the
    // index either way — a reference target is a page, it has a title and a
    // reader can open it — but for one it is the MEASUREMENT that is withheld,
    // and the three columns arrive NULL. The predicate is a column of the `page`
    // CTE (NOT_SCAFFOLDING, which reads the current revision's marker, hence the
    // `r` alias it requires) rather than a filter on the outer query, because a
    // filter would drop the page out of somebody's index.
    `WITH page AS (
       SELECT c.id, c.slug, r.title, r.summary, r.rev, c.updated_at,
              ${notScaffolding(options.scaffoldingKinds)} AS measurable
         FROM wk_concepts c
         JOIN wk_concept_revisions r ON r.id = c.current_revision_id
        WHERE c.space_id = $1${keyset}
        ORDER BY c.slug ASC
        LIMIT $${values.length}
     )
     SELECT p.slug, p.title, p.summary, p.rev, p.updated_at,
            ev.claims, ev.uncited_claims, ev.sources
       FROM page p
       LEFT JOIN LATERAL (${EVIDENCE_LATERAL}) ev ON p.measurable
      ORDER BY p.slug ASC`,
    values,
  )
  const page = rows.slice(0, limit)
  const items = page.map((row) => {
    // Zero is MEASURED, never absent — WHERE THE AGGREGATE RAN. It is an
    // un-grouped aggregate, so it returns exactly one row even for a concept
    // with no claims at all; a NULL here can therefore only come from the join
    // predicate declining to measure, never from an empty count. That matters
    // because "this page cites nothing" is the single most important fact this
    // list surfaces — a page written by hand through the console has zero claims
    // and looked exactly like a fully cited one until it said so — and the
    // console renders an absent object as an em dash, "not measured". A page
    // that makes no claims must never be dressed as one nobody asked about, and
    // a page the question does not apply to must never be dressed as one that
    // answered it with zeros.
    //
    // All three are tested rather than one, though the join makes them NULL
    // together: a partially-NULL row would be a shape nothing here understands,
    // and inventing a zero for the missing column is exactly the lie above.
    const measured =
      row.claims === null || row.uncited_claims === null || row.sources === null
        ? undefined
        : { claims: row.claims, uncited_claims: row.uncited_claims, sources: row.sources }
    return {
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      rev: row.rev,
      updated_at: isoString(row.updated_at),
      // Spread rather than `evidence: measured`, so the key is genuinely absent
      // in-process and not merely undefined: `'evidence' in row` is the check a
      // caller writes, and JSON.stringify drops both — an in-process caller
      // must not be able to see a distinction the wire cannot carry.
      ...(measured ? { evidence: measured } : {}),
    }
  })
  const last = page.at(-1)
  return {
    items,
    next_after: rows.length > limit && last ? encodeCursor(last.slug) : null,
    epoch: Number(space.epoch),
  }
}

/**
 * The same evidence, for a set of pages named by slug, in ONE statement.
 *
 * This exists for /search, whose hits arrive already ranked out of the
 * whitelisted wk_search / wk_search_hybrid functions (db.call pins the exact
 * statement, and a set-returning function's output cannot be joined against
 * from a later statement without re-running the ranking). So the counts cost
 * one additional round trip there, where the list gets them inside its own
 * statement.
 *
 * REJECTED, deliberately: pinning a new whitelist entry that wraps
 * `public.wk_search(...)` in this same lateral and keeps search at one
 * statement. It would put the counting SQL — and with it the visible-status
 * list — into src/db/postgres.ts, which is the second copy EVIDENCE_LATERAL
 * exists to prevent, and it would need four variants (lexical and hybrid, each
 * of which also returns claim rows the aggregate has nothing to say about) for
 * one saved round trip on a page of at most 50 hits.
 *
 * A slug missing from the returned map means NOT MEASURED, never zero, and
 * there are now TWO reasons a slug can be missing — both of them "the question
 * does not apply to this page", never "the answer is nothing":
 *   - it is not readable (no current revision), so a page that stopped being
 *     readable between the ranking and this call is absent rather than reported
 *     as a page that cites nothing;
 *   - its current revision is scaffolding (notScaffolding above), so it is a
 *     reference target rather than knowledge, and the same silence the concept
 *     list keeps for it is kept for a search hit that points at it.
 * Zero is a measurement and must keep meaning one. The caller reads absence off
 * the map exactly as before — search leaves `SearchHit.evidence` unset, which
 * is the field's own contract for a page it could not measure.
 */
export async function conceptEvidenceBySlug(
  db: Db,
  spaceId: string,
  slugs: string[],
  options: ScaffoldingOptions = {},
): Promise<Map<string, ConceptEvidence>> {
  // Deduplicated because a search page can hold several claim-derived rows for
  // one concept, and skipped entirely when empty — a search with no concept
  // hits (a kind='claim' filter, or no matches at all) must cost nothing.
  const unique = [...new Set(slugs)]
  if (unique.length === 0) return new Map()
  const { rows } = await db.query<{
    slug: string
    claims: number
    uncited_claims: number
    sources: number
  }>(
    // Here the scaffolding test is a FILTER and not a join predicate, unlike the
    // list: this function's whole output is the measurement, so "not measured"
    // is expressed by the slug not coming back — the same way an unreadable page
    // already expresses it, through the JOIN one line above.
    `WITH page AS (
       SELECT c.id, c.slug
         FROM wk_concepts c
         JOIN wk_concept_revisions r ON r.id = c.current_revision_id
        WHERE c.space_id = $1 AND c.slug = ANY($2::text[])
          AND ${notScaffolding(options.scaffoldingKinds)}
     )
     SELECT p.slug, ev.claims, ev.uncited_claims, ev.sources
       FROM page p
       CROSS JOIN LATERAL (${EVIDENCE_LATERAL}) ev`,
    [spaceId, unique],
  )
  return new Map(
    rows.map((row) => [row.slug, { claims: row.claims, uncited_claims: row.uncited_claims, sources: row.sources }]),
  )
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
