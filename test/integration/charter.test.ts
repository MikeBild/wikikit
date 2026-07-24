// Charter end-to-end against a real Docker Postgres: versioning (latest +
// history), the bidirectional write split (authored → revision, overview →
// review gate), delete, and that the latest charter actually steers the ingest
// pipeline's classify + synthesize calls. Gated behind RUN_INTEGRATION=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import {
  deleteCharter,
  getCharter,
  getCharterHistory,
  parseCharterDocument,
  renderCharter,
  writeCharter,
} from '../../src/domain/charter.ts'
import { createIngestPipeline } from '../../src/ingest/pipeline.ts'
import { createLogger } from '../../src/logger.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db

const config = {
  databaseUrl: 'postgresql://stub',
  maxIngestTokens: 100_000,
  maxBodyBytes: 10 * 1024 * 1024,
  ingestConcurrency: 1,
} as Config

const logger = createLogger({ write: () => {} })

let counter = 0
async function seedSpace(): Promise<{ id: string; slug: string }> {
  const slug = `charter-${++counter}`
  const [row] = await db.insert<{ id: string; slug: string }>('wk_spaces', {
    slug,
    name: `Space ${slug}`,
    settings: {},
  })
  return row!
}

async function currentCount(spaceId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM wk_charter_revisions WHERE space_id = $1 AND status = 'current'`,
    [spaceId],
  )
  return rows[0]!.n
}

describe('charter (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_charter')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('auto-versions every write; latest + history + exactly one current', async () => {
    const space = await seedSpace()

    const first = await writeCharter(db, space.id, '# v1\n\nEmphasise decisions.')
    expect(first.rev).toBe(1)
    const second = await writeCharter(db, space.id, '# v2\n\nEmphasise decisions and voice.')
    expect(second.rev).toBe(2)

    const latest = await getCharter(db, space.id)
    expect(latest.rev).toBe(2)
    expect(latest.markdown).toContain('and voice')

    const old = await getCharter(db, space.id, { rev: 1 })
    expect(old.rev).toBe(1)
    expect(old.markdown).toContain('Emphasise decisions.')

    const history = await getCharterHistory(db, space.id)
    expect(history.map((h) => h.rev)).toEqual([2, 1]) // newest first
    expect(history.find((h) => h.status === 'current')!.rev).toBe(2)
    expect(await currentCount(space.id)).toBe(1)
  })

  it('an unchanged authored write is a no-op (no new revision)', async () => {
    const space = await seedSpace()
    const a = await writeCharter(db, space.id, 'Same text.')
    expect(a.rev).toBe(1)
    const b = await writeCharter(db, space.id, 'Same text.')
    expect(b.rev).toBe(1) // unchanged → still rev 1
    expect((await getCharterHistory(db, space.id)).length).toBe(1)
  })

  it('delete supersedes the current revision; idempotent; history retained', async () => {
    const space = await seedSpace()
    await writeCharter(db, space.id, 'To be deleted.')
    await deleteCharter(db, space.id)

    const after = await getCharter(db, space.id)
    expect(after.rev).toBeNull()
    expect(after.markdown).toBe('')
    expect(await currentCount(space.id)).toBe(0)
    // History is retained.
    expect((await getCharterHistory(db, space.id)).length).toBe(1)
    // Idempotent.
    await deleteCharter(db, space.id)
    expect(await currentCount(space.id)).toBe(0)
  })

  it('bidirectional authored round-trip: render → parse → same authored text, no-op re-write', async () => {
    const space = await seedSpace()
    const authored = '# Charter\n\nRules the maintainer wrote.'
    const w = await writeCharter(db, space.id, authored)

    const detail = await getCharter(db, space.id)
    const doc = renderCharter(detail)
    expect(parseCharterDocument(doc).authored).toBe(authored.trim())

    // Writing the full rendered document straight back changes nothing authored.
    const back = await writeCharter(db, space.id, doc)
    expect(back.rev).toBe(w.rev)
    expect(back.ingest_ids).toEqual([])
  })

  it('an edited overview block routes through the gate (enqueueOverviewEdit), authored untouched', async () => {
    const space = await seedSpace()
    await writeCharter(db, space.id, 'Authored, unchanged.')

    const detail = await getCharter(db, space.id)
    const edited = renderCharter(detail).replace(
      '<!-- /wikikit:overview -->',
      'Hand-added: wikikit replaces the legacy tool.\n<!-- /wikikit:overview -->',
    )

    const captured: string[] = []
    const result = await writeCharter(
      db,
      space.id,
      edited,
      {},
      {
        enqueueOverviewEdit: async (markdown) => {
          captured.push(markdown)
          return 'ingest-123'
        },
      },
    )
    expect(captured.length).toBe(1)
    expect(captured[0]).toContain('wikikit replaces the legacy tool')
    expect(result.ingest_ids).toEqual(['ingest-123'])
    // Authored half unchanged → no new revision.
    expect(result.rev).toBe(1)
  })

  it('the latest charter steers the pipeline classify + synthesize calls', async () => {
    const space = await seedSpace()
    const charter = '# Payments\n\nAlways capture decision rationale. Voice: terse.'
    await writeCharter(db, space.id, charter)

    const provider = createFakeProvider()
    const pipeline = createIngestPipeline(config, db, provider, logger)
    const enqueued = await pipeline.enqueue(db, space.id, { markdown: '# Note\n\nA fresh source about payments.' })
    if ('status' in enqueued) throw new Error('unexpected sync fast-path')
    await pipeline.runOnce()

    const classify = provider.calls.find((c) => c.method === 'classify')!
    const synthesize = provider.calls.find((c) => c.method === 'synthesize')!
    expect((classify.input as { charter?: string }).charter).toBe(charter)
    expect((synthesize.input as { charter?: string }).charter).toBe(charter)
  })

  it('a space with no charter passes no charter to the pipeline', async () => {
    const space = await seedSpace()
    const provider = createFakeProvider()
    const pipeline = createIngestPipeline(config, db, provider, logger)
    const enqueued = await pipeline.enqueue(db, space.id, { markdown: '# Note\n\nAnother fresh source.' })
    if ('status' in enqueued) throw new Error('unexpected sync fast-path')
    await pipeline.runOnce()

    const classify = provider.calls.find((c) => c.method === 'classify')!
    expect((classify.input as { charter?: string }).charter).toBeUndefined()
  })
})
