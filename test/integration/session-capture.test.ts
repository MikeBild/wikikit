// Session capture as a source STREAM, against real Postgres.
//
// The failure this pins is not hypothetical: lifecycle hooks fire on every
// turn-end their host offers, and each firing posts the SAME transcript grown
// longer. Without a stream identity one afternoon archives a source per turn
// and stacks a proposal per source, all describing the same session. With one,
// the growth is a supersedes chain on one stream and the review queue holds
// exactly one pending proposal — the newest.
//
// Gated behind RUN_INTEGRATION=1.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { captureSession, sessionStreamKey } from '../../src/agent/sessions.ts'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createIngestPipeline, type IngestPipeline } from '../../src/ingest/pipeline.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { createLogger } from '../../src/logger.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

const SESSION_ID = '019fe665-c0de-7000-8000-000000000001'
const STREAM_KEY = sessionStreamKey(SESSION_ID)

// A transcript the hook posts twice, the second time longer — the real shape:
// turn one taught one rule, turn two taught a second WITHOUT unteaching the
// first, so the later distillate is a strict superset of the earlier one.
const TURN_1 = 'human: fix the deploy\nhuman: RULE always let CI deploy'
const TURN_2 = `${TURN_1}\nassistant: ok\nhuman: RULE never edit generated files`

/**
 * A deterministic stand-in for the distiller: every `RULE ...` line becomes a
 * learning. Deterministic ONLY inside this test — the real distiller is not,
 * which is exactly why no source_version is derived from a transcript.
 */
function rulesIn(transcript: string) {
  return transcript
    .split('\n')
    .filter((line) => line.startsWith('human: RULE '))
    .map((line) => {
      const rule = line.slice('human: RULE '.length)
      return { title: rule, rule: `${rule}.`, quote: line }
    })
}

let database: Database
let db: Db
let spaceId = ''
let pipeline: IngestPipeline

function capture(transcript: string, sessionId?: string) {
  const llm = createFakeProvider({ distill: (input) => ({ learnings: rulesIn(input.transcript) }) })
  return captureSession(
    db,
    spaceId,
    { llm, ingest: pipeline },
    { transcript, ...(sessionId === undefined ? {} : { session_id: sessionId }) },
  )
}

async function streamSources() {
  const { rows } = await db.query<{ id: string; supersedes_source_id: string | null; content_hash: string }>(
    `SELECT s.id, s.supersedes_source_id, s.content_hash
       FROM wk_sources s
       JOIN wk_source_streams st ON st.id = s.stream_id
      WHERE st.space_id = $1 AND st.external_source_id = $2
      ORDER BY s.created_at ASC`,
    [spaceId, STREAM_KEY],
  )
  return rows
}

async function proposals() {
  return db.select<{ id: string; status: string; review_note: string | null; source_ids: string[] }>(
    'wk_change_proposals',
    { space_id: `eq.${spaceId}`, order: 'created_at.asc' },
  )
}

afterAll(async () => {
  if (!integration) return
  await database.close()
})

describe('session capture as a source stream (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_session_capture')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
    const [space] = await db.insert<{ id: string }>('wk_spaces', { slug: 'capture-space', name: 'Capture' })
    spaceId = space!.id
    pipeline = createIngestPipeline(
      { maxIngestTokens: 100_000, ingestConcurrency: 1, ingestLeaseMs: 60_000, ingestHeartbeatMs: 10_000 } as Config,
      db,
      createFakeProvider(),
      createLogger({ level: 'error' }),
    )
  })

  let firstSourceId = ''
  let firstProposalId = ''

  it('the first capture opens the stream and stages one proposal', async () => {
    const result = await capture(TURN_1, SESSION_ID)
    expect(result.status).toBe('queued')
    expect(result.learnings).toBe(1)
    expect(await pipeline.runOnce()).toBe(true)

    const sources = await streamSources()
    expect(sources.length).toBe(1)
    firstSourceId = sources[0]!.id
    expect(sources[0]!.supersedes_source_id).toBeNull()

    // No version marker: the hook has none to give, and dedup does the work.
    const [stream] = await db.select<{ latest_source_id: string; latest_version: string | null }>('wk_source_streams', {
      space_id: `eq.${spaceId}`,
      external_source_id: `eq.${STREAM_KEY}`,
    })
    expect(stream!.latest_source_id).toBe(firstSourceId)
    expect(stream!.latest_version).toBeNull()

    const pending = (await proposals()).filter((row) => row.status === 'pending')
    expect(pending.length).toBe(1)
    firstProposalId = pending[0]!.id
  })

  it('the same session grown longer supersedes its predecessor and retires its proposal', async () => {
    const result = await capture(TURN_2, SESSION_ID)
    expect(result.status).toBe('queued')
    expect(result.learnings).toBe(2)
    expect(await pipeline.runOnce()).toBe(true)

    // ONE stream, two versions, chained — not two unrelated sources.
    const sources = await streamSources()
    expect(sources.length).toBe(2)
    expect(sources[1]!.supersedes_source_id).toBe(firstSourceId)
    const { rows: streams } = await db.query(
      `SELECT 1 FROM wk_source_streams WHERE space_id = $1 AND external_source_id = $2`,
      [spaceId, STREAM_KEY],
    )
    expect(streams.length).toBe(1)

    // ONE thing to review. The predecessor did not survive as a competitor.
    const all = await proposals()
    const pending = all.filter((row) => row.status === 'pending')
    expect(pending.length).toBe(1)
    expect(pending[0]!.source_ids).toEqual([sources[1]!.id])

    const retired = all.find((row) => row.id === firstProposalId)!
    expect(retired.status).toBe('failed')
    expect(retired.review_note).toContain('superseded by a newer capture')
    expect(retired.review_note).toContain(sources[1]!.id)
  })

  it('a re-capture with unchanged learnings converges — no source, no proposal, no error', async () => {
    const before = await proposals()
    const result = await capture(TURN_2, SESSION_ID)

    // The sync fast-path, reported under the SAME status the streamless
    // content-hash conflict uses — the hook cannot tell them apart.
    expect(result).toMatchObject({ status: 'already_captured', ingest_id: null, learnings: 2 })
    expect(await pipeline.runOnce()).toBe(false) // nothing was queued

    expect((await streamSources()).length).toBe(2)
    expect((await proposals()).length).toBe(before.length)
  })

  it('a capture without a session_id behaves exactly as before — no stream, 409-shaped dedup', async () => {
    const transcript = 'human: RULE tag releases from main only'
    const first = await capture(transcript)
    expect(first.status).toBe('queued')
    expect(await pipeline.runOnce()).toBe(true)

    const { rows } = await db.query<{ id: string; supersedes_source_id: string | null }>(
      `SELECT id, supersedes_source_id FROM wk_sources WHERE space_id = $1 AND stream_id IS NULL`,
      [spaceId],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.supersedes_source_id).toBeNull()

    // Same rules taught again → same markdown → same hash → already_captured
    // via the ConflictError path, not via a stream.
    const again = await capture(transcript)
    expect(again).toMatchObject({ status: 'already_captured', ingest_id: null })
    expect((await db.select('wk_source_streams', { space_id: `eq.${spaceId}` })).length).toBe(1)
  })

  it('a routine session still writes nothing at all', async () => {
    const llm = createFakeProvider() // default distiller: no learnings
    const result = await captureSession(
      db,
      spaceId,
      { llm, ingest: pipeline },
      { transcript: 'human: fix typo\nassistant: done', session_id: 'sess-routine' },
    )
    expect(result.status).toBe('no_learnings')
    // No stream is opened for a session that taught nothing.
    const streams = await db.select('wk_source_streams', {
      space_id: `eq.${spaceId}`,
      external_source_id: `eq.${sessionStreamKey('sess-routine')}`,
    })
    expect(streams.length).toBe(0)
  })
})
