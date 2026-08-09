// The evidence summary on SEARCH hits, against real Postgres.
//
// 0.25.0 gave the concept LIST three numbers per row — claims, uncited_claims,
// sources — so a reader could tell, before spending a click, which pages the
// archive stands behind. Search was the other place that choice gets made, and
// it was still silent: a ranked headline says a page matched, never how the
// wiki knows what it says. Same question, same gap, one surface later.
//
// WHAT THIS FILE HOLDS TO THE DATABASE (src/query/search.ts, SearchHit):
//
//   kind='concept'       carries `evidence`, counted by the SAME aggregate the
//                        list uses (EVIDENCE_LATERAL), in the hit's OWN space —
//                        unless the aggregate declines to answer for the page,
//                        which it does for a page that is no longer readable
//                        and for a reference target (a scaffolding revision:
//                        furniture, with no knowledge to be evidenced). Absent
//                        is not zero, on this surface exactly as on the index.
//   kind='claim'         carries none — the page's totals answer a different
//                        question than a claim hit raises.
//   kind='source_chunk'  carries none — that tier is explicitly NOT approved
//                        knowledge, and an evidence summary would say so.
//
// test/unit/query-search.test.ts pins the same rules against a stub, which is
// where the wiring belongs. What a stub cannot see is what this file is for:
// that the numbers a hit reports are the numbers the list and the page report
// for the same slug (one aggregate, three surfaces, or the product contradicts
// itself in front of a reader), that the visible-status filter survives the
// second statement, and that the extra statement stays exactly one no matter
// how many hits come back. RUN_INTEGRATION=1 gated.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import type { ClaimStatus } from '../../src/domain/claims.ts'
import { BUILT_IN_SCAFFOLDING_KINDS, conceptReadingsBySlug, listConcepts } from '../../src/domain/concepts.ts'
import { search, type SearchHit } from '../../src/query/search.ts'
import { countingPool } from '../helpers/counting-pool.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db
let spaceId = ''
let databaseUrl = ''
let sourceIds: string[] = []

/** The one token every fixture matches on — nothing else in the space uses it. */
const QUERY = 'thermostat'

interface SeedClaim {
  status: ClaimStatus
  /** Indices into `sourceIds`; empty = an uncited claim. */
  cites: number[]
}

let claimSeq = 0

/**
 * A readable page whose title, body AND claims all mention QUERY, so one search
 * produces both a concept hit and claim hits for it.
 *
 * Written straight into the tables rather than staged through
 * wk_apply_proposal for the reason test/integration/concept-evidence.test.ts
 * gives: approval only ever produces `verified` claims, so the `draft` status —
 * one of the two that must NOT count — is unreachable through that path.
 */
async function seedPage(slug: string, claims: SeedClaim[], kind?: string): Promise<void> {
  const [concept] = await db.insert<{ id: string }>('wk_concepts', { space_id: spaceId, slug, title: slug })
  const [revision] = await db.insert<{ id: string }>('wk_concept_revisions', {
    space_id: spaceId,
    concept_id: concept!.id,
    rev: 1,
    status: 'current',
    title: `Thermostat ${slug}`,
    summary: `Everything about the ${QUERY} in ${slug}.`,
    markdown: `# ${slug}\n\nThe ${QUERY} reports its firmware version on boot.`,
    // `kind` on the CURRENT revision is what marks a page as scaffolding — a
    // reference target rather than knowledge. Set here for the same reason the
    // claim statuses are set directly: the marker arrives on rows an import
    // wrote, and no proposal path in this product produces one.
    agent_meta: JSON.stringify(kind ? { kind } : {}),
  })
  await db.update('wk_concepts', { id: `eq.${concept!.id}` }, { current_revision_id: revision!.id })

  for (const claim of claims) {
    claimSeq += 1
    const [row] = await db.insert<{ id: string }>('wk_claims', {
      space_id: spaceId,
      concept_id: concept!.id,
      subject: QUERY,
      predicate: 'reports',
      // Distinct per claim so nothing here looks like a contradicting frame.
      object: `fact-${claimSeq}`,
      status: claim.status,
    })
    if (claim.cites.length === 0) continue
    await db.insert(
      'wk_citations',
      claim.cites.map((index) => ({
        space_id: spaceId,
        claim_id: row!.id,
        source_id: sourceIds[index]!,
        quote: `Verbatim about the ${QUERY} for fact-${claimSeq}`,
        locator: '',
      })),
    )
  }
}

/** The list's answer for one slug — the number the hit has to match. */
async function listEvidence(slug: string): Promise<SearchHit['evidence']> {
  const page = await listConcepts(db, spaceId, { limit: 200 }, { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
  return page.items.find((item) => item.slug === slug)?.evidence
}

function conceptHit(hits: SearchHit[], slug: string): SearchHit {
  const hit = hits.find((entry) => entry.kind === 'concept' && entry.slug === slug)
  if (!hit) throw new Error(`${slug} did not rank for "${QUERY}" — the fixture never became searchable`)
  return hit
}

describe('search evidence (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    databaseUrl = await provisionIntegrationDatabase('wikikit_test_search_evidence')
    await runMigrations({ databaseUrl })
    database = createPostgres({ databaseUrl } as Config)
    db = database.db
    const [space] = await db.insert<{ id: string }>('wk_spaces', { slug: 'search-evidence', name: 'Search evidence' })
    spaceId = space!.id

    const sources = await db.insert<{ id: string }>(
      'wk_sources',
      Array.from({ length: 3 }, (_unused, index) => ({
        space_id: spaceId,
        content_hash: `hash-${index}`.padEnd(64, '0'),
        kind: 'markdown',
        title: `Source ${index}`,
        raw_content: `# Source ${index}`,
        markdown: `# Source ${index}\n\nThe ${QUERY} ships with firmware 4.2.`,
      })),
    )
    sourceIds = sources.map((source) => source.id)

    await seedPage('thermostat-firmware', [
      { status: 'verified', cites: [0] },
      { status: 'disputed', cites: [0, 1] },
      { status: 'verified', cites: [] },
    ])
    await seedPage('thermostat-notes', [])
    await seedPage('thermostat-staged', [
      { status: 'proposed', cites: [0] },
      { status: 'draft', cites: [2] },
    ])
    // A reference target: a page an import created so reviewed relations had
    // somewhere to land. It ranks like any other page — it has a title and a
    // body — and it is the second reason a concept hit can carry no evidence.
    await seedPage('thermostat-reference', [], 'structural-reference')

    // One archived chunk in the source-evidence tier, matching the same query.
    await db.insert('wk_source_chunks', {
      space_id: spaceId,
      source_id: sourceIds[0]!,
      chunk_index: 0,
      heading: 'Firmware',
      content: `The ${QUERY} refuses to pair after a firmware downgrade.`,
      tokens: 12,
    })
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('a concept hit reports what the list reports for the same page', async () => {
    // The defect worth the most here. A reader who searches, then browses the
    // index, is comparing two reads of one fact — and "5 claims, 1 uncited" on
    // one surface beside "3 claims" on the other does not read as two code
    // paths, it reads as a wiki that does not know what it holds. Both numbers
    // come from EVIDENCE_LATERAL; this asserts that they arrive equal.
    const hits = await search(
      db,
      spaceId,
      { q: QUERY, kind: 'concept' },
      { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
    )
    expect(hits.length).toBeGreaterThanOrEqual(3)
    for (const hit of hits) {
      expect(hit.evidence, hit.slug ?? '').toEqual(await listEvidence(hit.slug!))
    }
    expect(conceptHit(hits, 'thermostat-firmware').evidence).toEqual({
      claims: 3,
      uncited_claims: 1,
      sources: 2,
    })
  })

  it('each hit gets its OWN numbers, and a page that cites nothing gets a measured zero', async () => {
    // A lookup keyed by anything but the slug — position, the first row, the
    // top hit — passes every count assertion and quietly gives every page the
    // same evidence. And the hand-written page is the state this whole feature
    // exists to surface: three zeros, present, never an absent object a console
    // would render as "unknown".
    const hits = await search(
      db,
      spaceId,
      { q: QUERY, kind: 'concept' },
      { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
    )
    const notes = conceptHit(hits, 'thermostat-notes')
    expect(notes.evidence).toEqual({ claims: 0, uncited_claims: 0, sources: 0 })
    expect(notes.evidence).toBeDefined()
    for (const value of Object.values(notes.evidence!)) {
      // count() is bigint; pg hands bigint back as a STRING unless the read
      // casts. '0' survives every equality check a client makes and then
      // renders as the wrong thing.
      expect(value).toBeNumber()
    }
    expect(conceptHit(hits, 'thermostat-firmware').evidence).not.toEqual(notes.evidence!)
  })

  it('staged claims are not knowledge — a page carrying only those searches as unevidenced', async () => {
    // Every claim on this page carries a citation. The only thing between it
    // and a healthy-looking hit is the status filter, and if that leaks the
    // search advertises evidence for a page whose reader sees none: getConcept
    // serves visible statuses only, so those claims are invisible on the page
    // itself. Two surfaces, one page, opposite answers.
    const hits = await search(
      db,
      spaceId,
      { q: QUERY, kind: 'concept' },
      { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
    )
    expect(conceptHit(hits, 'thermostat-staged').evidence).toEqual({
      claims: 0,
      uncited_claims: 0,
      sources: 0,
    })
  })

  it('claim hits carry no evidence, and archived source chunks carry none either', async () => {
    // Both deliberate, for opposite reasons. A claim hit raises "is THIS claim
    // quoted?", which none of the three numbers answers — lending it the page's
    // totals would put `claims: 3` on one claim. A chunk hit is explicitly NOT
    // approved knowledge: an evidence summary there would dress an unreviewed
    // archived paragraph in the badge of a curated page, which is the worst
    // misreading this field admits.
    const hits = await search(
      db,
      spaceId,
      { q: QUERY, mode: 'approved_then_sources', limit: 50 },
      { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
    )
    const claims = hits.filter((hit) => hit.kind === 'claim')
    const chunks = hits.filter((hit) => hit.kind === 'source_chunk')
    expect(claims.length).toBeGreaterThan(0)
    expect(chunks.length).toBeGreaterThan(0)
    for (const hit of [...claims, ...chunks]) expect(hit.evidence, hit.kind).toBeUndefined()
    // …while the concept hits in the SAME response are all measured. A guard
    // that suppressed the field for everything would satisfy the loop above.
    // The reference target is the one concept hit that is legitimately absent
    // and it is excluded BY SLUG rather than by "whatever came back empty",
    // which would re-admit exactly the bug this loop is here for.
    const pages = hits.filter((entry) => entry.kind === 'concept' && entry.slug !== 'thermostat-reference')
    expect(pages.length).toBeGreaterThan(0)
    for (const hit of pages) expect(hit.evidence, hit.slug ?? '').toBeDefined()
  })

  it('a reference-target hit is ABSENT, while a hit on a page that rests on nothing still reports zeros', async () => {
    // The same distinction the index makes, on the other surface where a reader
    // picks which page to open — and both halves in ONE response, because
    // either half alone is satisfiable by a wrong implementation. A search that
    // reported three zeros for the target would put it beside the hand-written
    // page as though the two were the same finding; one that suppressed the
    // object for every concept hit would lose the finding entirely.
    const hits = await search(
      db,
      spaceId,
      { q: QUERY, kind: 'concept' },
      { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
    )
    const reference = conceptHit(hits, 'thermostat-reference')
    expect(reference.evidence).toBeUndefined()
    expect('evidence' in reference).toBe(false)
    expect(conceptHit(hits, 'thermostat-notes').evidence).toEqual({ claims: 0, uncited_claims: 0, sources: 0 })

    // …and the two surfaces agree about WHICH page they decline to measure.
    // One filter on one aggregate is what makes that structural rather than
    // hopeful: a hit that carried numbers the index withholds (or the reverse)
    // is a wiki contradicting itself between two reads of one page.
    expect(await listEvidence('thermostat-reference')).toBeUndefined()
  })

  it('the aggregate answers for a reference target — with a reason, not with a hole', async () => {
    // This assertion INVERTED, and the inversion is the change. Absence used to
    // be the only way this function could say "not measured", so a reference
    // target and a page that had stopped being readable came back identically:
    // two different facts under one silence, and a caller could not tell them
    // apart to describe either. The row now comes back present, carrying the
    // reason the wiki already knew.
    //
    // What did NOT change is the other absence, pinned immediately below: an
    // unreadable page is still missing from the map, because there the row
    // genuinely is not there. One of the two absences learned to speak; the
    // other had nothing to say.
    const measured = await conceptReadingsBySlug(db, spaceId, ['thermostat-reference', 'thermostat-notes'], {
      scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS,
    })
    const reference = measured.get('thermostat-reference')
    expect(reference).toBeDefined()
    expect(reference?.not_measured?.reason).toBe('reference_target')
    // And never the measurement under another name: the reason object carries no
    // `sources` and no `uncited_claims`, because "how well is this page backed"
    // is not a question a reference target has an answer to.
    expect(reference?.evidence).toBeUndefined()
    expect(Object.keys(reference?.not_measured ?? {})).not.toContain('sources')
    expect(Object.keys(reference?.not_measured ?? {})).not.toContain('uncited_claims')

    // A measured page is untouched by any of it, zeros included.
    expect(measured.get('thermostat-notes')).toEqual({ evidence: { claims: 0, uncited_claims: 0, sources: 0 } })
  })

  it('an unreadable page is ABSENT from the aggregate, not a measured zero', async () => {
    // The distinction the wire field's `optional()` exists for, held to the
    // database rather than to the doc comment that asserts it. A concept with
    // no current revision is not readable, so the aggregate must decline to
    // answer for it — the search agent's rule is that a page which stopped
    // being readable between the ranking and the count comes back absent, so
    // that `0` keeps meaning "measured, and it cites nothing".
    //
    // This is asked of conceptReadingsBySlug directly because it cannot be
    // asked through search(): an unreadable page has no search vector and can
    // never rank, so the only way to reach the gate is to name the slug. Both
    // halves are asserted in one call — without the readable-page JOIN the
    // unreadable slug comes back as three zeros and becomes indistinguishable
    // from the page below it, which genuinely is zero.
    const [orphan] = await db.insert<{ id: string }>('wk_concepts', {
      space_id: spaceId,
      slug: 'thermostat-unreadable',
      title: 'thermostat-unreadable',
    })
    expect(orphan!.id).toBeString()
    const measured = await conceptReadingsBySlug(db, spaceId, ['thermostat-unreadable', 'thermostat-notes'], {
      scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS,
    })
    expect(measured.has('thermostat-unreadable')).toBe(false)
    expect(measured.get('thermostat-notes')).toEqual({ evidence: { claims: 0, uncited_claims: 0, sources: 0 } })
  })

  it('the cost is one extra statement per search, and it does not grow with the hits', async () => {
    // The failure this guards is N+1: an evidence lookup per hit reads fine,
    // tests fine on a fixture of one, and turns a 50-hit search into 51 round
    // trips. Statements are counted, not timed — see countingPool.
    const { pool, statements } = countingPool(databaseUrl)
    // createPostgres will not end an injected pool, so the finally below owns
    // it; a leaked pool keeps the suite alive after bun test prints its summary.
    const counted = createPostgres({ databaseUrl } as Config, { pool })
    try {
      statements.length = 0
      const many = await search(
        counted.db,
        spaceId,
        { q: QUERY, kind: 'concept', limit: 50 },
        { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
      )
      const atMany = statements.length

      statements.length = 0
      const one = await search(
        counted.db,
        spaceId,
        { q: QUERY, kind: 'concept', limit: 1 },
        { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
      )
      const atOne = statements.length

      expect(many.length).toBeGreaterThan(one.length)
      // Three pages cost what one page costs: the ranking, then the aggregate.
      expect(atMany).toBe(atOne)
      expect(atMany).toBe(2)

      // A search that produces no concept hit does not pay for the aggregate at
      // all — the claim-filtered and the missed search stay exactly as cheap as
      // they were before this feature existed.
      statements.length = 0
      await search(counted.db, spaceId, { q: QUERY, kind: 'claim' }, { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
      expect(statements.length).toBe(1)

      statements.length = 0
      await search(
        counted.db,
        spaceId,
        { q: 'nothing-in-this-space-matches-this' },
        { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
      )
      expect(statements.length).toBe(1)
    } finally {
      await pool.end()
    }
  })

  it('the aggregate is asked about at most the hits it got — bounded by the search cap, not the wiki', async () => {
    // The list runs this aggregate over 200 rows; search is capped at 50 per
    // tier, so the bound here is strictly tighter — and the slug list is
    // deduplicated, so the several claim hits a page contributes never turn
    // into several counts of that page.
    const { pool, statements } = countingPool(databaseUrl)
    const counted = createPostgres({ databaseUrl } as Config, { pool })
    try {
      statements.length = 0
      const hits = await search(
        counted.db,
        spaceId,
        { q: QUERY, limit: 50 },
        { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
      )
      const distinctConcepts = new Set(hits.flatMap((hit) => (hit.kind === 'concept' ? [hit.slug] : []))).size
      const aggregates = statements.filter((sql) => sql.includes('CROSS JOIN LATERAL'))
      expect(aggregates.length).toBe(1)
      expect(distinctConcepts).toBeLessThanOrEqual(50)
      // The response holds more hits than pages — the claim hits ride on
      // concepts that are already in the list — so a per-hit lookup would show
      // up here as more than one aggregate.
      expect(hits.length).toBeGreaterThan(distinctConcepts)
      expect(hits.filter((hit) => hit.kind === 'claim').length).toBeGreaterThan(0)
    } finally {
      await pool.end()
    }
  })
})
