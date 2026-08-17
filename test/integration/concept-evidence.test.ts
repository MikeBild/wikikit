// The evidence summary on the concept LIST read, against real Postgres.
//
// WikiKit's whole premise is that a claim carries a verbatim quote from an
// archived source. Until this change the list answered slug/title/summary/rev
// /updated_at and nothing about provenance, so "how does the wiki know this?"
// — the first question a reader has — could only be answered by opening every
// page one at a time. The list now carries three numbers per row, and this
// file is where those numbers are held to the database rather than to a mock.
//
// THE CONTRACT UNDER TEST (src/domain/concepts.ts, ConceptSummary.evidence):
//
//   claims           visible claims on the page — verified | disputed |
//                    deprecated. NEVER proposed or draft.
//   uncited_claims   how many of those `claims` have no row in wk_citations at
//                    all. A COUNT over CLAIMS, not over citations.
//   sources          how many DISTINCT wk_sources back those claims.
//
// All three are numbers, always, wherever the object is served — 0 is a
// measurement, null is not, and the read must never hand the console a null to
// render. The object itself is ABSENT on exactly one kind of row: a reference
// target, a page an import created so that reviewed relations had somewhere to
// land. It holds no knowledge to be evidenced, so it has no measurement, and
// three zeros there are indistinguishable from the knowledge page that
// genuinely rests on nothing — which is the row this whole summary exists to
// show. Absence and zero are different statements; both are asserted below.
//
// These live in an integration test rather than beside the fake-db unit tests
// because every one of them is a claim about SQL: a join that multiplies rows,
// an aggregate that yields NULL, and a COUNT that forgets DISTINCT are all
// invisible to a stub and all fatal in production. RUN_INTEGRATION=1 gated.
//
// test/integration/domain.test.ts asserts the three shapes that fall out of the
// stage→approve→read loop it already builds (one cited claim, one uncited
// claim, a page with none). This file covers what that loop cannot reach: the
// citation fan-out, the `draft` status, source distinctness, agreement with the
// detail read, and the cost at the 200-row clamp.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import type { ClaimStatus } from '../../src/domain/claims.ts'
import { BUILT_IN_SCAFFOLDING_KINDS, getConcept, listConcepts, type ConceptSummary } from '../../src/domain/concepts.ts'
import { countingPool } from '../helpers/counting-pool.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

/**
 * Restated from the summary rather than imported loose, so a rename of the
 * field on the row is a compiler error here and not three files of
 * `undefined`. NonNullable because the field is optional on the row — absent
 * for a page the measurement does not apply to — and every use below is of a
 * measurement that must be there.
 */
type Evidence = NonNullable<ConceptSummary['evidence']>

let database: Database
let db: Db
let spaceId = ''
/** Kept for the cost test, which needs a SECOND pool it can instrument. */
let databaseUrl = ''

/** How many distinct sources the seed pool holds. Indices below are into it. */
const SOURCE_COUNT = 4
let sourceIds: string[] = []

/** A claim to seed: its status, and which pooled sources it quotes. */
interface SeedClaim {
  status: ClaimStatus
  /** Indices into `sourceIds`. An EMPTY array is an uncited claim. */
  cites: number[]
}

const cited = (...cites: number[]): SeedClaim => ({ status: 'verified', cites })
const uncited = (): SeedClaim => ({ status: 'verified', cites: [] })

/** Everything about a seeded page that is not its claims. */
interface PageOptions {
  /** The current revision's `agent_meta.kind` — what marks a page as scaffolding. */
  kind?: string
  markdown?: string
  /** Slugs (already seeded) this page points at with an ACTIVE relation. */
  relatesTo?: string[]
}

/**
 * The body a reference target actually carries on the installation this rule
 * was measured against: a couple of sentences saying that the page exists to
 * hold the target of reviewed relations and that the knowledge is elsewhere.
 * Reproduced in shape rather than quoted, because what the tests below turn on
 * is that such a page is NOT blank — it has prose, it has relations, and it
 * still must not be measured.
 */
const REFERENCE_BODY =
  '# Cadences\n\nThis reference page preserves the target of reviewed relations created during an ' +
  'allowlisted import. Detailed, source-grounded knowledge remains on the related concept pages and in ' +
  'their archived sources.'

let claimSeq = 0

async function seedSpace(slug: string): Promise<string> {
  const [space] = await db.insert<{ id: string }>('wk_spaces', { slug, name: `Space ${slug}` })
  return space!.id
}

/**
 * A readable page with claims, written straight into the tables.
 *
 * Deliberately NOT staged through createProposal + wk_apply_proposal, for two
 * reasons. Approval only ever produces `verified` claims, so the `draft` case
 * — a real status in the migration's CHECK constraint and one of the two
 * statuses that must NOT count as evidence — is unreachable through that path.
 * And approval's flip 5 disputes colliding frames, which would silently mutate
 * the statuses these tests are asserting on. Direct inserts state the fixture
 * exactly, which is what a test of a read wants.
 */
async function seedPage(space: string, slug: string, claims: SeedClaim[], options: PageOptions = {}): Promise<void> {
  const [concept] = await db.insert<{ id: string }>('wk_concepts', {
    space_id: space,
    slug,
    title: `Page ${slug}`,
  })
  const [revision] = await db.insert<{ id: string }>('wk_concept_revisions', {
    space_id: space,
    concept_id: concept!.id,
    rev: 1,
    status: 'current',
    title: `Page ${slug}`,
    summary: `What ${slug} is about`,
    markdown: options.markdown ?? `# ${slug}\n\nBody.`,
    // The marker lives on the REVISION, which is why it is set here and not on
    // the concept: a page stops being scaffolding when a revision that is not
    // scaffolding becomes current.
    agent_meta: JSON.stringify(options.kind ? { kind: options.kind } : {}),
  })
  await db.update('wk_concepts', { id: `eq.${concept!.id}` }, { current_revision_id: revision!.id })

  for (const target of options.relatesTo ?? []) {
    const [to] = await db.select<{ id: string }>('wk_concepts', {
      space_id: `eq.${space}`,
      slug: `eq.${target}`,
      limit: 1,
    })
    await db.insert('wk_relations', {
      space_id: space,
      from_concept_id: concept!.id,
      to_concept_id: to!.id,
      kind: 'related',
      status: 'active',
    })
  }

  for (const claim of claims) {
    claimSeq += 1
    const [row] = await db.insert<{ id: string }>('wk_claims', {
      space_id: space,
      concept_id: concept!.id,
      // A distinct object per claim keeps the exact-frame matcher out of this:
      // nothing here should ever look like a contradiction.
      subject: slug,
      predicate: 'has_fact',
      object: `fact-${claimSeq}`,
      status: claim.status,
    })
    if (claim.cites.length === 0) continue
    await db.insert(
      'wk_citations',
      claim.cites.map((index) => ({
        space_id: space,
        claim_id: row!.id,
        source_id: sourceIds[index]!,
        quote: `Verbatim from source ${index} for fact-${claimSeq}`,
        locator: '',
      })),
    )
  }
}

async function rowFor(space: string, slug: string): Promise<ConceptSummary> {
  const page = await listConcepts(db, space, { limit: 200 }, { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
  const row = page.items.find((item) => item.slug === slug)
  if (!row) throw new Error(`${slug} is not in the list — the fixture never became readable`)
  return row
}

/**
 * The row's measurement, insisted upon.
 *
 * Every fixture in this file except the reference targets is a knowledge page,
 * and for one of those a missing `evidence` is not an optional field doing its
 * job — it is the list having declined to measure a page it must measure. That
 * has to fail loudly here, rather than be narrowed away with a `?.` that would
 * let `undefined` sail through every count assertion below and report a green
 * suite for a list that answers nothing at all.
 */
async function measuredFor(space: string, slug: string): Promise<Evidence> {
  const { evidence } = await rowFor(space, slug)
  if (!evidence) throw new Error(`${slug} came back with no evidence — the list declined to measure a knowledge page`)
  return evidence
}

describe('concept list evidence (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    databaseUrl = await provisionIntegrationDatabase('wikikit_test_concept_evidence')
    await runMigrations({ databaseUrl })
    database = createPostgres({ databaseUrl } as Config)
    db = database.db
    spaceId = await seedSpace('evidence-space')

    const sources = await db.insert<{ id: string }>(
      'wk_sources',
      Array.from({ length: SOURCE_COUNT }, (_unused, index) => ({
        space_id: spaceId,
        content_hash: `hash-${index}`.padEnd(64, '0'),
        kind: 'markdown',
        title: `Source ${index}`,
        raw_content: `# Source ${index}`,
        markdown: `# Source ${index}`,
        summary: `Source ${index}`,
      })),
    )
    sourceIds = sources.map((source) => source.id)
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('a page whose every claim quotes a source reports nothing uncited', async () => {
    // All three VISIBLE statuses in one fixture. `disputed` and `deprecated`
    // are knowledge too — contested and retired knowledge, but knowledge a
    // reader sees — so a filter that only counted `verified` would under-report
    // exactly the pages most worth looking at.
    await seedPage(spaceId, 'fully-cited', [
      { status: 'verified', cites: [0] },
      { status: 'disputed', cites: [1] },
      { status: 'deprecated', cites: [0, 1] },
    ])
    expect((await rowFor(spaceId, 'fully-cited')).evidence).toEqual({
      claims: 3,
      uncited_claims: 0,
      sources: 2,
    })
  })

  it('uncited counts CLAIMS, not citation rows — a page with some of each', async () => {
    // The defect this test exists for: joining wk_claims to wk_citations
    // multiplies a claim by its citations, so a bare COUNT(*) over the join
    // reports 3 + 2 + 1 + 1 = 7 "claims" on a page that makes four. The
    // multi-citation claims are here precisely so that mistake cannot pass.
    await seedPage(spaceId, 'partly-cited', [
      cited(0, 1, 2), // three quotes
      cited(1, 3), // two quotes
      uncited(),
      uncited(),
    ])
    const evidence = await measuredFor(spaceId, 'partly-cited')
    expect(evidence.claims).toBe(4)
    expect(evidence.uncited_claims).toBe(2)
    expect(evidence.sources).toBe(4)
  })

  it('a hand-written page with no claims reports zero, zero, zero — never null', async () => {
    // This is the state the whole change exists to surface. A page typed into
    // the console has no claims at all, which today is indistinguishable from
    // a page synthesized out of twenty archived quotes. The aggregate is
    // un-grouped, so once it RUNS it answers with a row — three zeros, present,
    // and never an absent object a console renders as "unknown". Absence is
    // reserved for the page the question does not apply to, and this page is
    // not that page: it is the finding.
    await seedPage(spaceId, 'hand-written', [])
    const evidence = await measuredFor(spaceId, 'hand-written')
    expect(evidence).toEqual({ claims: 0, uncited_claims: 0, sources: 0 })
    for (const value of [evidence.claims, evidence.uncited_claims, evidence.sources]) {
      expect(value).not.toBeNull()
      // A count is a NUMBER. Postgres answers count() as bigint, which pg hands
      // back as a string unless the read casts or coerces — and `'0' === 0` is
      // false, so a string zero survives every equality check a console makes
      // and then renders as the wrong thing.
      expect(value).toBeNumber()
    }
  })

  it('proposed and draft claims are staged, not knowledge — the page reads as unevidenced', async () => {
    // Every claim here carries a citation, so the only thing standing between
    // this page and a healthy-looking row is the status filter. If it leaks,
    // the list advertises evidence for a page whose reader sees none: getConcept
    // serves VISIBLE_CLAIM_STATUSES only, so these claims are invisible on the
    // page itself. Two surfaces, one page, opposite answers.
    await seedPage(spaceId, 'staged-only', [
      { status: 'proposed', cites: [0] },
      { status: 'proposed', cites: [1] },
      { status: 'draft', cites: [2] },
    ])
    expect((await rowFor(spaceId, 'staged-only')).evidence).toEqual({
      claims: 0,
      uncited_claims: 0,
      sources: 0,
    })
  })

  it('a staged claim does not lend its source to the visible ones', async () => {
    // The mixed case the all-staged fixture cannot catch: the page IS
    // evidenced, so the filter runs but must run on the citation side too.
    // Counting sources over all claims would report two sources for a page
    // whose reader can check exactly one.
    await seedPage(spaceId, 'mixed-staging', [
      { status: 'verified', cites: [0] },
      { status: 'proposed', cites: [1] },
      { status: 'draft', cites: [2] },
    ])
    expect((await rowFor(spaceId, 'mixed-staging')).evidence).toEqual({
      claims: 1,
      uncited_claims: 0,
      sources: 1,
    })
  })

  it('two citations from one source count that source once', async () => {
    // "Backed by four sources" and "backed by one source quoted four times"
    // are different statements about how well corroborated a page is, and a
    // COUNT without DISTINCT tells the flattering one.
    await seedPage(spaceId, 'one-source-many-quotes', [cited(0), cited(0), cited(0, 0)])
    const evidence = await measuredFor(spaceId, 'one-source-many-quotes')
    expect(evidence.sources).toBe(1)
    expect(evidence.claims).toBe(3)

    await seedPage(spaceId, 'two-sources-many-quotes', [cited(0, 0), cited(0, 1), cited(1)])
    expect((await measuredFor(spaceId, 'two-sources-many-quotes')).sources).toBe(2)
  })

  it('a reference target is ABSENT from the list, while the page beside it that rests on nothing still reports zeros', async () => {
    // The defect this change exists for, and both halves of it in one read
    // because either half alone is satisfiable by a wrong implementation.
    //
    // A reference target is a page an import created so that reviewed relations
    // had somewhere to land: it carries prose that says so on its own face, it
    // carries active relations, and it makes no claims. Three zeros on such a
    // row are the same three numbers 'rests-on-nothing' carries below it — and
    // that one is a knowledge page an operator is supposed to act on. On a wiki
    // where eleven of twenty pages are targets, a stark zero on all of them
    // teaches the reader to ignore the zero that means something, and sends
    // whoever does look to a linter that correctly says nothing is wrong.
    //
    // So: absent for the target, MEASURED for its neighbour. An implementation
    // that reports zeros for both, or one that withholds the object from every
    // row, fails exactly one of these two expectations.
    await seedPage(spaceId, 'rests-on-nothing', [])
    await seedPage(spaceId, 'reference-target', [], {
      kind: 'structural-reference',
      markdown: REFERENCE_BODY,
      relatesTo: ['rests-on-nothing'],
    })

    const target = await rowFor(spaceId, 'reference-target')
    expect(target.evidence).toBeUndefined()
    // Absent, not a key holding undefined: `'evidence' in row` is what a caller
    // writes, and JSON.stringify drops the key entirely — the in-process shape
    // must not carry a distinction the wire cannot.
    expect('evidence' in target).toBe(false)

    // …and the measurement is the ONLY thing withheld. The page is still in the
    // index, under its own title, with its own summary — withholding a number
    // is not hiding a page, and a reader can still open it.
    expect(target.title).toBe('Page reference-target')
    expect((await getConcept(db, spaceId, { slug: 'reference-target' })).relations).toEqual([
      { to_slug: 'rests-on-nothing', kind: 'related', space: null },
    ])

    expect((await rowFor(spaceId, 'rests-on-nothing')).evidence).toEqual({
      claims: 0,
      uncited_claims: 0,
      sources: 0,
    })
  })

  it('the marker decides, not the counts: a reference target that does hold claims is still absent', async () => {
    // Pins WHICH rule is implemented, because "absent when all three would be
    // zero" passes the test above and is a different rule with a different
    // failure: it would withhold nothing from a target that has claims and
    // withhold from every blank knowledge page, which is the finding the index
    // exists to show.
    //
    // The marker is the deployment's own statement that this row is furniture,
    // and it sits on the CURRENT revision — so a row that grew real claims
    // under a scaffolding revision reads as absent until somebody approves a
    // revision that does not claim to be furniture, at which point it is
    // measured again. Self-healing, and readable off one row.
    await seedPage(spaceId, 'target-with-claims', [cited(0), uncited()], {
      kind: 'structural-reference',
      markdown: REFERENCE_BODY,
    })
    expect((await rowFor(spaceId, 'target-with-claims')).evidence).toBeUndefined()

    // The claims themselves are untouched — the page's own read still shows
    // them, exactly as it shows the body. Nothing here suppresses knowledge;
    // one summary declines to be computed.
    const detail = await getConcept(db, spaceId, { slug: 'target-with-claims' })
    expect(detail.claims.length).toBe(2)
  })

  it('the list and the page agree about the same page', async () => {
    // The defect worth the most here. A reader who scans the index and then
    // opens a row is comparing two reads of one fact, and a list that says
    // "6 claims, 2 uncited" over a page showing 4 claims does not read as a
    // rounding difference — it reads as a wiki that does not know what it
    // holds. So the list numbers are re-derived from getConcept, which is the
    // page's OWN read, for every fixture above.
    for (const slug of [
      'fully-cited',
      'partly-cited',
      'hand-written',
      'staged-only',
      'mixed-staging',
      'one-source-many-quotes',
      'two-sources-many-quotes',
    ]) {
      const detail = await getConcept(db, spaceId, { slug })
      const fromDetail: Evidence = {
        claims: detail.claims.length,
        uncited_claims: detail.claims.filter((claim) => claim.citations.length === 0).length,
        sources: new Set(detail.claims.flatMap((claim) => claim.citations.map((cite) => cite.source_id))).size,
      }
      expect(await measuredFor(spaceId, slug), slug).toEqual(fromDetail)
    }
  })

  it('the cost holds at the ceiling: 200 rows still answer in a constant number of queries', async () => {
    // listConcepts is clamped to 200 rows, so 200 is the worst page a client
    // can ask for. The failure this guards is N+1: an evidence lookup per row
    // reads fine, tests fine on a fixture of three, and turns the index into
    // 201 round trips on a real wiki — the kind of regression that only shows
    // up once somebody has enough pages to care about the feature.
    //
    // Statements are COUNTED rather than timed. A wall-clock bound loose
    // enough not to flake on a loaded CI box is loose enough to let a 200-query
    // index through; a count is exact and says what it means.
    const bigSpace = await seedSpace('cost-space')
    const tinySpace = await seedSpace('cost-space-tiny')
    await seedPage(tinySpace, 'only-page', [cited(0), uncited()])
    await seedBulk(bigSpace, 200)

    const { pool, statements } = countingPool(databaseUrl)
    // `createPostgres` will not end an injected pool, so the `finally` below
    // owns it — a leaked pool keeps the suite's process alive after bun test
    // has printed its summary.
    const counted = createPostgres({ databaseUrl } as Config, { pool })
    try {
      statements.length = 0
      const small = await listConcepts(
        counted.db,
        tinySpace,
        { limit: 200 },
        { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
      )
      const atOne = statements.length

      statements.length = 0
      const large = await listConcepts(
        counted.db,
        bigSpace,
        { limit: 200 },
        { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
      )
      const at200 = statements.length

      expect(small.items.length).toBe(1)
      expect(large.items.length).toBe(200)

      // The whole assertion: reading 200 pages costs what reading one costs.
      expect(at200).toBe(atOne)
      // And the absolute ceiling — the space lookup, the list itself, and at
      // most one batched aggregate. Anything above this is a design that walks
      // the page a second time.
      expect(at200).toBeLessThanOrEqual(3)

      // Every row answered, and answered correctly. An aggregate joined the
      // wrong way drops the rows it has nothing to say about, which would make
      // the cheapest query also the one that loses the hand-written pages —
      // and a lateral bound to the wrong row would give every page the first
      // page's numbers, which no count assertion would ever notice.
      for (const row of large.items) {
        expect(row.evidence, row.slug).toEqual({ claims: 2, uncited_claims: 1, sources: 1 })
      }
    } finally {
      await pool.end()
    }
  })
})

/* ------------------------------------------------------------------ fixtures */

/**
 * 200 readable pages, each with two claims and one citation, in a handful of
 * statements rather than 1,400.
 *
 * Written as bulk inserts because the cost test is the one test here that
 * needs a page at the clamp ceiling, and seeding it row by row would spend
 * more wall clock than every other test in the file combined. Claims are
 * matched back to their citations by `object`, never by the order the
 * multi-row INSERT ... RETURNING happened to hand back — that order is not
 * promised by Postgres, and a fixture that relies on an unpromised order is a
 * flake waiting for a planner change.
 */
async function seedBulk(space: string, pages: number): Promise<void> {
  const concepts = await db.insert<{ id: string; slug: string }>(
    'wk_concepts',
    Array.from({ length: pages }, (_unused, index) => ({
      space_id: space,
      slug: `bulk-${String(index).padStart(3, '0')}`,
      title: `Bulk ${index}`,
    })),
  )
  await db.insert(
    'wk_concept_revisions',
    concepts.map((concept) => ({
      space_id: space,
      concept_id: concept.id,
      rev: 1,
      status: 'current',
      title: `Bulk ${concept.slug}`,
      summary: 'Bulk',
      markdown: `# ${concept.slug}`,
    })),
  )
  await db.query(
    `UPDATE wk_concepts c
        SET current_revision_id = r.id
       FROM wk_concept_revisions r
      WHERE r.concept_id = c.id AND c.space_id = $1`,
    [space],
  )

  const claims = await db.insert<{ id: string; object: string }>(
    'wk_claims',
    concepts.flatMap((concept) => [
      {
        space_id: space,
        concept_id: concept.id,
        subject: concept.slug,
        predicate: 'has_fact',
        object: `${concept.slug}-cited`,
        status: 'verified',
      },
      {
        space_id: space,
        concept_id: concept.id,
        subject: concept.slug,
        predicate: 'has_other_fact',
        object: `${concept.slug}-uncited`,
        status: 'verified',
      },
    ]),
  )
  await db.insert(
    'wk_citations',
    claims
      .filter((claim) => claim.object.endsWith('-cited'))
      .map((claim) => ({
        space_id: space,
        claim_id: claim.id,
        source_id: sourceIds[0]!,
        quote: `Verbatim for ${claim.object}`,
        locator: '',
      })),
  )
}
