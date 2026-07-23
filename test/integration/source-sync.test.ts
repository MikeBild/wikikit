// Source-sync contract against real Postgres: the full connector matrix —
// first push, idempotent re-push, version conflict, new version with
// supersedes chain, content revert, tombstone + resurrect — plus the
// tombstoned-sources lint surfacing. wk_sources stays append-only throughout;
// only wk_source_streams mutates. Gated behind RUN_INTEGRATION=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createIngestPipeline, type IngestPipeline } from '../../src/ingest/pipeline.ts'
import { recordStreamVersion, tombstoneStream } from '../../src/domain/source-streams.ts'
import { lintSpace } from '../../src/domain/lint.ts'
import { ConflictError } from '../../src/domain/errors.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { createLogger } from '../../src/logger.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

const EXTERNAL_ID = 'gdrive:file123'
const V1 = '# Gerät A\n\nFirmware 1.0 ist installiert.'
const V2 = '# Gerät A\n\nFirmware 2.0 ist installiert.'

let database: Database
let db: Db
let spaceId = ''
let pipeline: IngestPipeline

function push(markdown: string, version: string) {
  return pipeline.enqueue(db, spaceId, {
    markdown,
    title: 'Gerät A',
    external_source_id: EXTERNAL_ID,
    source_version: version,
    observed_at: '2026-07-23T10:00:00.000Z',
  })
}

async function stream() {
  const [row] = await db.select<{
    id: string
    latest_source_id: string
    latest_version: string
    deleted_at: Date | null
  }>('wk_source_streams', { space_id: `eq.${spaceId}`, external_source_id: `eq.${EXTERNAL_ID}` })
  return row!
}

describe('source-sync contract (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_source_sync')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
    const [space] = await db.insert<{ id: string }>('wk_spaces', { slug: 'sync-space', name: 'Sync' })
    spaceId = space!.id
    pipeline = createIngestPipeline(
      { maxIngestTokens: 100_000, ingestConcurrency: 1, ingestLeaseMs: 60_000, ingestHeartbeatMs: 10_000 } as Config,
      db,
      createFakeProvider(),
      createLogger({ level: 'error' }),
    )
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  let firstSourceId = ''

  it('first push: queued job → archived source with stream identity → proposal', async () => {
    const enqueued = await push(V1, 'v1')
    expect('ingest_id' in enqueued).toBe(true)
    expect(await pipeline.runOnce()).toBe(true)

    const row = await stream()
    expect(row.latest_version).toBe('v1')
    firstSourceId = row.latest_source_id

    const [source] = await db.select<{ stream_id: string; source_version: string; supersedes_source_id: null }>(
      'wk_sources',
      { id: `eq.${firstSourceId}` },
    )
    expect(source!.stream_id).toBe(row.id)
    expect(source!.source_version).toBe('v1')
    expect(source!.supersedes_source_id).toBeNull()
  })

  it('idempotent re-push of the same version is a 200 unchanged, never a 409', async () => {
    const result = await push(V1, 'v1')
    expect(result).toMatchObject({ status: 'unchanged', source_id: firstSourceId })
  })

  it('same version marker with different content is a loud sync_version_conflict', async () => {
    await expect(
      recordStreamVersion(db, spaceId, {
        externalSourceId: EXTERNAL_ID,
        sourceVersion: 'v1',
        source: { kind: 'markdown', raw: V2, markdown: V2 },
      }),
    ).rejects.toMatchObject({ code: 'sync_version_conflict' })
    // The transaction rolled back — no orphaned v2 source row.
    const { rows } = await db.query(`SELECT 1 FROM wk_sources WHERE space_id = $1`, [spaceId])
    expect(rows.length).toBe(1)
  })

  let secondSourceId = ''

  it('a new version with new content supersedes the previous head', async () => {
    const enqueued = await push(V2, 'v2')
    expect('ingest_id' in enqueued).toBe(true)
    expect(await pipeline.runOnce()).toBe(true)

    const row = await stream()
    expect(row.latest_version).toBe('v2')
    secondSourceId = row.latest_source_id
    expect(secondSourceId).not.toBe(firstSourceId)

    const [source] = await db.select<{ supersedes_source_id: string }>('wk_sources', { id: `eq.${secondSourceId}` })
    expect(source!.supersedes_source_id).toBe(firstSourceId)
  })

  it('a content revert moves the head pointer back without a new archive row', async () => {
    const result = await push(V1, 'v3')
    expect(result).toMatchObject({ status: 'unchanged', source_id: firstSourceId })
    const row = await stream()
    expect(row.latest_source_id).toBe(firstSourceId)
    expect(row.latest_version).toBe('v3')
    const { rows } = await db.query(`SELECT 1 FROM wk_sources WHERE space_id = $1`, [spaceId])
    expect(rows.length).toBe(2) // still only v1-content and v2-content rows
  })

  it('tombstone is idempotent, emits the outbox event, and lint surfaces cited claims', async () => {
    // Approve the pending proposal so its claims become visible.
    const [proposal] = await db.select<{ id: string }>('wk_change_proposals', {
      space_id: `eq.${spaceId}`,
      status: 'eq.pending',
      limit: 1,
    })
    if (proposal) await db.call('wk_apply_proposal', [proposal.id, 'sync-test'])

    const first = await tombstoneStream(db, spaceId, { externalSourceId: EXTERNAL_ID })
    expect(first.already_tombstoned).toBe(false)
    const second = await tombstoneStream(db, spaceId, { externalSourceId: EXTERNAL_ID })
    expect(second.already_tombstoned).toBe(true)
    expect((await stream()).deleted_at).not.toBeNull()

    const { rows: events } = await db.query(
      `SELECT payload FROM wk_outbox_events WHERE space_id = $1 AND event_type = 'wikikit.source.tombstoned'`,
      [spaceId],
    )
    expect(events.length).toBe(1)

    const report = await lintSpace(db, spaceId)
    const findings = report.findings.filter((finding) => finding.rule === 'tombstoned-sources')
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings[0]!.details).toMatchObject({ external_source_id: EXTERNAL_ID })
    // Surfacing only: the claims themselves keep their status.
    const { rows: claims } = await db.query(`SELECT status FROM wk_claims WHERE space_id = $1`, [spaceId])
    expect(claims.every((claim) => (claim as { status: string }).status !== 'deprecated')).toBe(true)
  })

  it('a later push resurrects the tombstoned stream', async () => {
    const result = await push(V2, 'v4')
    expect(result).toMatchObject({ status: 'unchanged', source_id: secondSourceId })
    expect((await stream()).deleted_at).toBeNull()
  })

  it('an unknown stream tombstone 404s', async () => {
    await expect(tombstoneStream(db, spaceId, { externalSourceId: 'ghost:doc' })).rejects.toThrow('not found')
  })

  it('non-sync ingests keep the byte-exact 409 semantics', async () => {
    await expect(pipeline.enqueue(db, spaceId, { markdown: V1, title: 'No stream' })).rejects.toBeInstanceOf(
      ConflictError,
    )
  })
})
