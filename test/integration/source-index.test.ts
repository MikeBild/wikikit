// The index window (WIKIKIT_SOURCE_INDEX_DAYS) against real Postgres.
//
// The unit test beside it (test/unit/domain-sources.test.ts) pins the predicate
// TEXT — that the array clause is spelled, that <= 0 issues nothing. What a
// stub cannot answer is whether those clauses actually spare the rows they name,
// and that is the whole risk here: unindexAgedSources is one statement whose six
// guards are the only thing between an hourly sweep and evidence somebody is
// still using. `wk_change_proposals.source_ids` is the sharpest of them, because
// it is a uuid[] with NO foreign key behind it — nothing in the schema would
// complain if the clause were dropped.
//
// Every fixture below is old enough to be swept, so any source that keeps its
// chunks keeps them because of ONE named guard. The last case is the other half
// of the contract: the plain aged source loses its chunks and its wk_sources row
// survives byte for byte, because the archive is verbatim and forever and this
// feature exists precisely so it can stay that way. RUN_INTEGRATION=1 gated.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { BUILT_IN_SCAFFOLDING_KINDS } from '../../src/domain/concepts.ts'
import { spaceHealth } from '../../src/domain/health.ts'
import { unindexAgedSources } from '../../src/domain/sources.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db
let spaceId = ''
let conceptId = ''

/** Older than any window a test uses — the age guard is never what spares a row here. */
const AGED = '400 days'

/**
 * An archived source with one retrieval chunk, backdated past every window.
 * `metadata` is the only knob any case needs beyond the row itself.
 */
async function seedSource(name: string, metadata: Record<string, unknown> = {}): Promise<string> {
  const {
    rows: [source],
  } = await db.query<{ id: string }>(
    `INSERT INTO wk_sources (space_id, content_hash, kind, title, raw_content, markdown, metadata, created_at)
     VALUES ($1, $2, 'markdown', $3, $4, $4, $5::jsonb, now() - interval '${AGED}')
     RETURNING id`,
    [
      spaceId,
      name.padEnd(64, '0'),
      name,
      `# ${name}\n\nThe telemetry run reported nothing unusual.`,
      JSON.stringify(metadata),
    ],
  )
  await db.insert('wk_source_chunks', {
    space_id: spaceId,
    source_id: source!.id,
    chunk_index: 0,
    heading: name,
    content: `The ${name} run reported nothing unusual.`,
    tokens: 9,
  })
  return source!.id
}

/** How many chunks the source still has — the one number every case reads. */
async function chunksOf(sourceId: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM wk_source_chunks WHERE source_id = $1',
    [sourceId],
  )
  return rows[0]!.count
}

/** The archive row itself, so a sweep can be proven not to have touched it. */
async function archiveRow(sourceId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await db.select<Record<string, unknown>>('wk_sources', { id: `eq.${sourceId}`, limit: 1 })
  return row
}

describe('source index window (integration)', () => {
  /** Fixture name → source id, filled by beforeAll and read by every case. */
  const seeded: Record<string, string> = {}

  beforeAll(async () => {
    if (!integration) return
    const databaseUrl = await provisionIntegrationDatabase('wikikit_test_source_index')
    await runMigrations({ databaseUrl })
    database = createPostgres({ databaseUrl } as Config)
    db = database.db
    const [space] = await db.insert<{ id: string }>('wk_spaces', { slug: 'archive', name: 'Archive' })
    spaceId = space!.id
    const [concept] = await db.insert<{ id: string }>('wk_concepts', {
      space_id: spaceId,
      slug: 'telemetry',
      title: 'Telemetry',
    })
    conceptId = concept!.id

    const cited = await seedSource('cited')
    const proposed = await seedSource('proposed')
    const streamHead = await seedSource('stream-head')
    const inFlight = await seedSource('in-flight')
    const derived = await seedSource('derived', { derived_from_output_id: '99999999-9999-4999-8999-999999999999' })
    const plain = await seedSource('plain')

    // Guard 1 — a claim quotes it, and a reviewer follows that citation back.
    const [claim] = await db.insert<{ id: string }>('wk_claims', {
      space_id: spaceId,
      concept_id: conceptId,
      subject: 'telemetry',
      predicate: 'reports',
      object: 'nothing unusual',
      status: 'verified',
    })
    await db.insert('wk_citations', {
      space_id: spaceId,
      claim_id: claim!.id,
      source_id: cited,
      quote: 'The cited run reported nothing unusual.',
    })

    // Guard 2 — named by a PENDING proposal (and, below, an approved one), in a
    // uuid[] no foreign key protects.
    await db.query(
      `INSERT INTO wk_change_proposals (space_id, status, title, input_hash, source_ids)
       VALUES ($1, 'pending', 'Weigh the telemetry', 'hash-pending', ARRAY[$2::uuid])`,
      [spaceId, proposed],
    )
    // A rejected proposal naming the plain source: a decided proposal is not a
    // reason to keep evidence in the index, or the guard would never release.
    await db.query(
      `INSERT INTO wk_change_proposals (space_id, status, title, input_hash, source_ids)
       VALUES ($1, 'rejected', 'Rejected', 'hash-rejected', ARRAY[$2::uuid])`,
      [spaceId, plain],
    )

    // Guard 3 — the head of a sync stream: a connector's current truth.
    await db.insert('wk_source_streams', {
      space_id: spaceId,
      external_source_id: 'connector:telemetry',
      latest_source_id: streamHead,
    })

    // Guard 4 — an ingest job still parked on a provider quota.
    await db.insert('wk_ingest_jobs', {
      space_id: spaceId,
      status: 'quota_blocked',
      input: JSON.stringify({ markdown: '# in flight' }),
      source_id: inFlight,
    })
    // A finished job on the plain source, because finishJob stamps a source_id
    // on EVERY terminal job — a `done` row must not keep evidence indexed.
    await db.insert('wk_ingest_jobs', {
      space_id: spaceId,
      status: 'done',
      input: JSON.stringify({ markdown: '# plain' }),
      source_id: plain,
    })

    Object.assign(seeded, { cited, proposed, streamHead, inFlight, derived, plain })
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('the archive block is reported with a null window while the feature is off', async () => {
    // Announced before anything is swept: six archived sources, all indexed, and
    // index_days null because 0 is a window nobody set.
    const health = await spaceHealth(
      db,
      spaceId,
      {},
      { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS, gapTopicsEnabled: false, sourceIndexDays: 0 },
    )
    expect(health.archive).toEqual({ sources: 6, indexed: 6, unindexed: 0, index_days: null })
  })

  it('a window of 0 sweeps nothing, however old the archive is', async () => {
    expect(await unindexAgedSources(db, 0)).toBe(0)
    expect(await chunksOf(seeded.plain!)).toBe(1)
  })

  it('sweeps the plain aged source only, and spares each of the five guarded ones', async () => {
    // One statement, one window, and every fixture is old enough to go: what
    // survives, survives because of the clause that names it.
    expect(await unindexAgedSources(db, 30)).toBe(1)

    expect(await chunksOf(seeded.plain!), 'a plain aged evidence source should have left the index').toBe(0)
    expect(await chunksOf(seeded.cited!), 'a cited source must stay citable').toBe(1)
    expect(await chunksOf(seeded.proposed!), 'a source under a pending proposal must stay findable').toBe(1)
    expect(await chunksOf(seeded.streamHead!), 'a stream head is current truth, not history').toBe(1)
    expect(await chunksOf(seeded.inFlight!), 'an unfinished ingest job is still going to chunk it').toBe(1)
    expect(await chunksOf(seeded.derived!), 'a derived source is counted by pending_derived').toBe(1)
  })

  it('the swept source keeps its archive row, verbatim', async () => {
    const row = await archiveRow(seeded.plain!)
    expect(row).toBeDefined()
    expect(row!.raw_content).toBe('# plain\n\nThe telemetry run reported nothing unusual.')
    expect(row!.markdown).toBe('# plain\n\nThe telemetry run reported nothing unusual.')
    // ...and the health block now says so, with the window that did it.
    const health = await spaceHealth(
      db,
      spaceId,
      {},
      { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS, gapTopicsEnabled: false, sourceIndexDays: 30 },
    )
    expect(health.archive).toEqual({ sources: 6, indexed: 5, unindexed: 1, index_days: 30 })
  })

  it('an APPROVED proposal keeps its evidence indexed too, and the guard releases when nothing names it', async () => {
    // The array clause is the only protection there is: no foreign key, no
    // cascade, nothing else in the schema knows this reference exists.
    const approved = await seedSource('approved-evidence')
    await db.query(
      `INSERT INTO wk_change_proposals (space_id, status, title, input_hash, source_ids)
       VALUES ($1, 'approved', 'Approved', 'hash-approved', ARRAY[$2::uuid])`,
      [spaceId, approved],
    )
    expect(await unindexAgedSources(db, 30)).toBe(0)
    expect(await chunksOf(approved)).toBe(1)

    // Same source, same age; only the proposal's status changed.
    await db.query("UPDATE wk_change_proposals SET status = 'rejected' WHERE input_hash = 'hash-approved'")
    expect(await unindexAgedSources(db, 30)).toBe(1)
    expect(await chunksOf(approved)).toBe(0)
  })

  it('a source inside the window is untouched, and re-indexing puts a swept one back', async () => {
    // Fresh evidence: the window is a window, not a purge.
    const {
      rows: [fresh],
    } = await db.query<{ id: string }>(
      `INSERT INTO wk_sources (space_id, content_hash, kind, title, raw_content, markdown)
       VALUES ($1, $2, 'markdown', 'fresh', '# fresh', '# fresh') RETURNING id`,
      [spaceId, 'fresh'.padEnd(64, '0')],
    )
    await db.insert('wk_source_chunks', {
      space_id: spaceId,
      source_id: fresh!.id,
      chunk_index: 0,
      heading: 'fresh',
      content: 'Written this morning.',
      tokens: 3,
    })
    expect(await unindexAgedSources(db, 30)).toBe(0)
    expect(await chunksOf(fresh!.id)).toBe(1)

    // The reversibility the feature rests on: nothing about the swept row
    // prevents the chunks from being written again.
    await db.insert('wk_source_chunks', {
      space_id: spaceId,
      source_id: seeded.plain!,
      chunk_index: 0,
      heading: 'plain',
      content: 'The plain run reported nothing unusual.',
      tokens: 9,
    })
    expect(await chunksOf(seeded.plain!)).toBe(1)
  })
})
