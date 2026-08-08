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
// All three are numbers, always, on every row — 0 is a measurement, null is
// not, and the read must never hand the console a null to render.
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
import pg from 'pg'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db, type PoolLike } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import type { ClaimStatus } from '../../src/domain/claims.ts'
import { getConcept, listConcepts, type ConceptSummary } from '../../src/domain/concepts.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

/**
 * Restated from the summary rather than imported loose, so a rename of the
 * field on the row is a compiler error here and not three files of
 * `undefined`.
 */
type Evidence = ConceptSummary['evidence']

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
async function seedPage(space: string, slug: string, claims: SeedClaim[]): Promise<void> {
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
    markdown: `# ${slug}\n\nBody.`,
  })
  await db.update('wk_concepts', { id: `eq.${concept!.id}` }, { current_revision_id: revision!.id })

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
  const page = await listConcepts(db, space, { limit: 200 })
  const row = page.items.find((item) => item.slug === slug)
  if (!row) throw new Error(`${slug} is not in the list — the fixture never became readable`)
  return row
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
    const evidence = (await rowFor(spaceId, 'partly-cited')).evidence
    expect(evidence.claims).toBe(4)
    expect(evidence.uncited_claims).toBe(2)
    expect(evidence.sources).toBe(4)
  })

  it('a hand-written page with no claims reports zero, zero, zero — never null', async () => {
    // This is the state the whole change exists to surface. A page typed into
    // the console has no claims at all, which today is indistinguishable from
    // a page synthesized out of twenty archived quotes. A LEFT JOIN with no
    // matching rows yields NULL, and a null rendered by a console that expects
    // a number is a blank cell or a crash — so coalescing to 0 is part of the
    // read's contract, not an implementation detail.
    await seedPage(spaceId, 'hand-written', [])
    const { evidence } = await rowFor(spaceId, 'hand-written')
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
    const evidence = (await rowFor(spaceId, 'one-source-many-quotes')).evidence
    expect(evidence.sources).toBe(1)
    expect(evidence.claims).toBe(3)

    await seedPage(spaceId, 'two-sources-many-quotes', [cited(0, 0), cited(0, 1), cited(1)])
    expect((await rowFor(spaceId, 'two-sources-many-quotes')).evidence.sources).toBe(2)
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
      expect((await rowFor(spaceId, slug)).evidence, slug).toEqual(fromDetail)
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
      const small = await listConcepts(counted.db, tinySpace, { limit: 200 })
      const atOne = statements.length

      statements.length = 0
      const large = await listConcepts(counted.db, bigSpace, { limit: 200 })
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

/**
 * A PoolLike that records every statement before passing it through.
 *
 * `createPostgres` already takes an injected pool for exactly this kind of
 * observation, so nothing in production code has to grow a hook to be
 * measurable. Note it wraps `connect()` too: `db.tx` runs through a checked-out
 * client, and a pool that only counted autocommit statements would report zero
 * for anything transactional.
 */
function countingPool(url: string): { pool: PoolLike; statements: string[] } {
  const inner = new pg.Pool({ connectionString: url, max: 4 })
  const statements: string[] = []
  return {
    statements,
    pool: {
      async query(sql, values) {
        statements.push(sql)
        const result = await inner.query(sql, values as unknown[])
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount }
      },
      async connect() {
        const client = await inner.connect()
        return {
          async query(sql, values) {
            statements.push(sql)
            const result = await client.query(sql, values as unknown[])
            return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount }
          },
          release: () => client.release(),
        }
      },
      async end() {
        await inner.end()
      },
    },
  }
}
