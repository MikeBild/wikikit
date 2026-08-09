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

/**
 * Why a row carries no `evidence` — the absence, saying what it is.
 *
 * WHY this exists at all. Withholding the measurement from a reference target
 * was right and stays (see the markers below), but until now the index simply
 * had a hole in it: `evidence` was gone and nothing in its place, so a reader
 * looking at the row could only INFER the reason from the absence, and the
 * console did exactly that — it read the rest of the response and guessed. A
 * guess about why a number is missing is not something a server should make its
 * clients do when the server is the one that knows.
 *
 * WHY NOT put the numbers back under another name. That would undo 0.28.0: the
 * marker is the deployment's statement that this row is not a knowledge page,
 * and `evidence` is the answer to "how well is this page backed", which for
 * furniture is not a question with an answer. So this object never carries
 * `uncited_claims` or `sources` — it is not the measurement wearing a hat.
 *
 * `withheld_claims` is the one number here, and it is present ONLY when the
 * page holds visible claims. It is not a measurement of how well the page is
 * backed; it is the size of what the marker is keeping out of the index, which
 * is a fact about the INDEX rather than about the knowledge. On the ordinary
 * reference target — marked, claimless — nothing is being withheld, so there is
 * no number, and inventing a `0` here would re-create precisely the meaningless
 * zero 0.28.0 removed.
 *
 * WHAT THIS IS NOT: a finding. There is no severity, no advice and no verdict —
 * the index answers "how well is this page backed" and must not grow into a
 * second linter. `scaffolded-claims` (src/domain/lint.ts) owns the judgement
 * that a marked page holding claims is a contradiction somebody should resolve,
 * and it reports the same count from the same aggregate. This field only says
 * that a real number exists and is not being shown here.
 */
export interface ConceptNotMeasured {
  /**
   * A CATEGORY, never the marker literal. Which `agent_meta.kind` made this row
   * furniture is one installation's private tag, and 0.30.0 declined to hand
   * those literals to every connected agent for a reason the linter states at
   * `scaffolded-claims`: a string that exempts a page from the measurement and
   * from three fault rules is one step from "write the page with that kind and
   * the complaints stop". An operator who needs the set has
   * `GET /v1/installation/knowledge-config`.
   *
   * One value today. It is a closed set rather than an open string so a client
   * that renders a sentence per reason fails to compile when a second one
   * appears, instead of silently deciding what an unknown reason means.
   */
  reason: 'reference_target'
  /**
   * Visible claims the withheld measurement would have counted — the SAME
   * aggregate `evidence.claims` comes from, so the index can never report a
   * different number than the page or the lint report does. ABSENT when there
   * are none, because then nothing is being withheld.
   */
  withheld_claims?: number
}

/**
 * The two answers a readable page can give about its evidence, as one object,
 * so that no read can serve both and none can serve neither.
 *
 * Exactly one field is set. `evidence` is the measurement; `not_measured` is
 * the reasoned absence. A caller spreads whichever arrived onto the wire row —
 * see `evidenceReading`, which is where the choice is actually made.
 */
export interface ConceptReading {
  evidence?: ConceptEvidence
  not_measured?: ConceptNotMeasured
}

/** One row of EVIDENCE_LATERAL, beside the marker test that decides what to do with it. */
interface EvidenceRow {
  /** `notScaffolding` evaluated for this row's CURRENT revision. */
  measurable: boolean
  claims: number
  uncited_claims: number
  sources: number
}

/**
 * The one decision: measured, or absent-with-a-reason.
 *
 * It lives in a function called by BOTH reads (the concept list and
 * `conceptEvidenceBySlug`, which is search's half) because the failure this
 * whole line of work exists to prevent is two surfaces disagreeing about one
 * page. A reader who scans the index and then searches is comparing two reads
 * of one fact, and "3 claims withheld" on one screen beside a bare dash on the
 * other does not read as two code paths — it reads as a wiki that does not know
 * what it holds. One statement per read is unavoidable (search's hits arrive
 * out of a set-returning function that cannot be joined against); one RULE is
 * not, so this is it.
 *
 * THE MARKER DECIDES, NOT THE COUNTS, and that is visible in the shape of this
 * function: `measurable` alone chooses the branch. The counts are read after the
 * branch is taken, never before it, so no number can move a page from one
 * category to the other. That property is what keeps the rule readable off a
 * single row and keeps a page from silently changing category the day a claim
 * lands on it.
 */
export function evidenceReading(row: EvidenceRow): ConceptReading {
  if (row.measurable)
    return { evidence: { claims: row.claims, uncited_claims: row.uncited_claims, sources: row.sources } }
  return {
    not_measured: {
      reason: 'reference_target',
      // `> 0` and not `>= 0`: the claimless reference target — the overwhelming
      // majority of them — must come back with a reason and no number at all.
      ...(row.claims > 0 ? { withheld_claims: row.claims } : {}),
    },
  }
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
  /**
   * Present exactly where `evidence` is absent, and it says why — see
   * ConceptNotMeasured. The pair is what makes the absence self-describing: a
   * row carries one or the other, so a client never has to work out from its
   * neighbours which kind of nothing it is holding.
   */
  not_measured?: ConceptNotMeasured
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
 * the call, the same way `SearchDeps` carries the retrieval wiring and
 * `registerWebhookEndpoint` takes its `Config` explicitly. The composition
 * boundaries (src/http/routes.ts handlers and src/mcp/tools.ts executes, both
 * of which hold `deps.config`) are the only places that fill it in.
 *
 * THE FIELD IS REQUIRED, AND SO IS EVERY PARAMETER TYPED BY IT. There is no
 * omitted case and no default anywhere beneath this line — not on the bag, not
 * on the parameter, not in `notScaffolding` below. A caller that forgets does
 * not compile.
 *
 * WHY it had to become a type and not stay a rule. Until 0.31.0 the field was
 * optional and omission silently resolved to BUILT_IN_SCAFFOLDING_KINDS, which
 * is right for a caller with no installation in scope and wrong for every
 * request: on an installation that declared markers it turns pages whose
 * evidence is deliberately ABSENT back into a measured `{claims: 0, …}` — "this
 * page rests on nothing" printed about pages that hold nothing by design. A
 * configuration correct in src/config.ts and forgotten at the call site is
 * worse than no configuration, because it is wrong while looking configured.
 * The guarantee used to be a source scan over a hand-listed set of boundary
 * modules, and a hand-maintained list of places to remember is precisely what
 * gets forgotten — the fifth boundary would have had to be added to it by the
 * same person who forgot the argument.
 *
 * WHY a required FIELD on the existing bag rather than a new positional
 * argument. The old argument against requiring it was that `{}` satisfies a
 * required options bag exactly as well as omitting an optional one — true of
 * the PARAMETER, false of the FIELD. Requiring the field makes `{}` a type
 * error too, so the compiler enforces that the value was forwarded, not that
 * somebody typed two characters. It also reaches `search` and `answerQuestion`,
 * whose deps bags legitimately keep `llm` and `vector` optional: one bag can
 * hold a required member beside optional ones, which a second positional
 * argument on already-bagged signatures could not do without giving this one
 * value two conventions.
 *
 * What the compiler still cannot say is that the value came from the
 * installation rather than from a literal — `{ scaffoldingKinds: [] }` type
 * checks. Neither could the scan it replaced (it matched the identifier, not
 * its value); that half is behaviour, and the integration tests in
 * test/integration/lint-rules.test.ts assert it by driving both surfaces with a
 * configured set and with none.
 */
export interface ScaffoldingOptions {
  readonly scaffoldingKinds: readonly string[]
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
 *
 * `kinds` carries no default on purpose. This is the innermost point the markers
 * reach, so a default here would be a hole under every required parameter above
 * it — the one place where forgetting could still resolve to something plausible.
 */
export function notScaffolding(kinds: readonly string[]): string {
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
 * Every row answers "how does the wiki know this?" — either with its `evidence`
 * (see ConceptEvidence) or, for a reference target, with the `not_measured`
 * that says why there is none. In a product whose premise is that each claim
 * quotes an archived source that is the first question a reader has, and
 * answering it per row is what lets a caller decide which page to open. Both
 * halves come out of THIS statement — never a second read per row, which on a
 * 200-row page would be 200 round trips for three integers.
 */
export async function listConcepts(
  db: Db,
  spaceId: string,
  args: { limit?: number; after?: string },
  options: ScaffoldingOptions,
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
    /** `notScaffolding` for this row's current revision — the ONLY thing that picks the branch. */
    measurable: boolean
    // Always three numbers, on every row. See the CROSS JOIN below for why the
    // aggregate now runs for a reference target too, and `evidenceReading` for
    // what survives the branch when it does.
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
    // The counting itself is EVIDENCE_LATERAL (above) — the `page` CTE is
    // aliased `p` and the space id is `$1` because that fragment says so, and
    // keeping the statuses out of `values` also keeps the `$${values.length}`
    // cursor arithmetic above readable.
    //
    // CROSS JOIN LATERAL, and `measurable` travels beside the counts as its own
    // column rather than gating the join. Until 0.31.0 this was
    // `LEFT JOIN LATERAL … ON p.measurable`, so a reference target's three
    // columns arrived NULL and absence was the whole of what the row could say.
    // That is exactly what the row now has to say MORE than: `not_measured`
    // carries the size of what the marker keeps out of the index
    // (ConceptNotMeasured.withheld_claims), and a number that was never counted
    // cannot be reported.
    //
    // THAT IS NOT THE MARKER BECOMING CONDITIONAL ON THE COUNTS. The branch is
    // taken on `measurable` alone, in `evidenceReading`, and on the withheld
    // branch only `claims` survives it — `uncited_claims` and `sources` are read
    // and dropped, because "how well is this page backed" is not a question a
    // reference target has an answer to. Counting is not reporting.
    //
    // The cost of counting rows the answer is then withheld for: the lateral
    // runs once per row on the page instead of once per MEASURABLE row. It is
    // the same index scan on wk_claims_concept_idx as every other row, and the
    // reference target it now runs for is the cheapest possible case of it —
    // such a page holds no claims at all in the overwhelming majority, so the
    // scan finds nothing and returns three zeros. It is still ONE statement, and
    // the lint rule already computes precisely this count from precisely this
    // aggregate (`scaffolded-claims`, src/domain/lint.ts): the alternative was
    // for the index and the lint report to reach the same number by two routes.
    //
    // The row stays in the index either way — a reference target is a page, it
    // has a title and a reader can open it — and the marker test is a column of
    // the `page` CTE (notScaffolding, which reads the current revision's marker,
    // hence the `r` alias it requires) rather than a filter on the outer query,
    // because a filter would drop the page out of somebody's index.
    `WITH page AS (
       SELECT c.id, c.slug, r.title, r.summary, r.rev, c.updated_at,
              ${notScaffolding(options.scaffoldingKinds)} AS measurable
         FROM wk_concepts c
         JOIN wk_concept_revisions r ON r.id = c.current_revision_id
        WHERE c.space_id = $1${keyset}
        ORDER BY c.slug ASC
        LIMIT $${values.length}
     )
     SELECT p.slug, p.title, p.summary, p.rev, p.updated_at, p.measurable,
            ev.claims, ev.uncited_claims, ev.sources
       FROM page p
       CROSS JOIN LATERAL (${EVIDENCE_LATERAL}) ev
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
    // Zero is MEASURED, never absent. The aggregate is un-grouped, so it returns
    // exactly one row even for a concept with no claims at all — "this page
    // cites nothing" is the single most important fact this list surfaces, and a
    // page written by hand through the console looked exactly like a fully cited
    // one until it said so. Which of the two answers the row carries is
    // `evidenceReading`'s decision and only its decision, taken off `measurable`
    // — so the index and search cannot disagree about one page, and no count can
    // move a page from one category to the other.
    //
    // Spread rather than two assignments, so the key that does not apply is
    // genuinely ABSENT in-process and not merely undefined: `'evidence' in row`
    // is the check a caller writes, and JSON.stringify drops both — an
    // in-process caller must not be able to see a distinction the wire cannot
    // carry.
    ...evidenceReading(row),
  }))
  const last = page.at(-1)
  return {
    items,
    next_after: rows.length > limit && last ? encodeCursor(last.slug) : null,
    epoch: Number(space.epoch),
  }
}

/**
 * The same reading, for a set of pages named by slug, in ONE statement.
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
 * WHAT A MISSING SLUG MEANS, and it is now one thing rather than two. A slug
 * comes back missing only when the page is NOT READABLE — no current revision —
 * which is the honest silence for a page that stopped being readable between the
 * ranking and this call: there is no row to describe, so there is nothing to
 * say, not even why. The reference target used to be missing for the same
 * reason, and that was the defect: a hit and an index row for the same slug both
 * fell silent, and the silence carried no reason on either surface. It is now a
 * present slug carrying `not_measured`, exactly as the index row carries it, and
 * the two are the same object because they come out of the same function.
 *
 * Zero is a measurement and must keep meaning one; absence still never means
 * zero. What changed is that ONE of the two absences learned to speak.
 */
export async function conceptReadingsBySlug(
  db: Db,
  spaceId: string,
  slugs: string[],
  options: ScaffoldingOptions,
): Promise<Map<string, ConceptReading>> {
  // Deduplicated because a search page can hold several claim-derived rows for
  // one concept, and skipped entirely when empty — a search with no concept
  // hits (a kind='claim' filter, or no matches at all) must cost nothing.
  const unique = [...new Set(slugs)]
  if (unique.length === 0) return new Map()
  const { rows } = await db.query<{
    slug: string
    measurable: boolean
    claims: number
    uncited_claims: number
    sources: number
  }>(
    // The scaffolding test is a COLUMN, not a filter, and that is the whole of
    // what makes this function's answer the same answer the list gives. It used
    // to be a second `AND notScaffolding(…)` in the CTE's WHERE, so a reference
    // target simply did not come back and search could not tell it from a page
    // that had stopped being readable. Two absences under one silence is the
    // shape the index had and this one still has to lose: the row exists, the
    // wiki knows exactly why it is not measured, and only the query was throwing
    // that away. Readability stays a JOIN, because there the row genuinely is
    // not there.
    `WITH page AS (
       SELECT c.id, c.slug,
              ${notScaffolding(options.scaffoldingKinds)} AS measurable
         FROM wk_concepts c
         JOIN wk_concept_revisions r ON r.id = c.current_revision_id
        WHERE c.space_id = $1 AND c.slug = ANY($2::text[])
     )
     SELECT p.slug, p.measurable, ev.claims, ev.uncited_claims, ev.sources
       FROM page p
       CROSS JOIN LATERAL (${EVIDENCE_LATERAL}) ev`,
    [spaceId, unique],
  )
  return new Map(rows.map((row) => [row.slug, evidenceReading(row)]))
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
