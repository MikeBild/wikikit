// pipeline.ts — enqueue (sync 409/503 semantics) and the worker body:
// acquire → archive+dedup → classify → synthesize → detect → propose →
// agent-run audit + job terminal state. Deterministic and offline: FakeProvider
// for the LLM, a routed stub pool for Postgres (the domain-test pattern).
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import {
  ConflictError,
  IngestQueueFullError,
  LlmNotConfiguredError,
  UnprocessableError,
} from '../../src/domain/errors.ts'
import { computeInputHash } from '../../src/domain/proposals.ts'
import { sha256Hex } from '../../src/domain/sources.ts'
import { createIngestPipeline, parseQuotaResumeAt } from '../../src/ingest/pipeline.ts'
import { createLogger } from '../../src/logger.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'

interface Call {
  sql: string
  values: unknown[]
}
type Rows = Record<string, unknown>[]
interface Route {
  match: RegExp
  rows?: Rows | ((values: unknown[], call: number) => Rows)
  error?: unknown
}

function fakeDb(routes: Route[]) {
  const calls: Call[] = []
  const counts = new Map<Route, number>()
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    const route = routes.find((entry) => entry.match.test(sql))
    if (!route) return { rows: [], rowCount: 0 }
    const count = (counts.get(route) ?? 0) + 1
    counts.set(route, count)
    if (route.error) throw route.error
    const rows = typeof route.rows === 'function' ? route.rows(values, count) : (route.rows ?? [])
    return { rows, rowCount: rows.length }
  }
  const pool: PoolLike = { query, connect: async () => ({ query, release() {} }), end: async () => {} }
  const { db } = createPostgres({ databaseUrl: 'postgresql://stub' } as Config, { pool })
  return { db, calls }
}

const config = {
  databaseUrl: 'postgresql://stub',
  maxIngestTokens: 100_000,
  maxBodyBytes: 10 * 1024 * 1024,
  ingestConcurrency: 1,
} as Config

const logger = createLogger({ write: () => {} })

const RAW = '# OKF\n\nOKF is a draft spec.'
const HASH = sha256Hex(RAW)
const SRC_ID = '6f1e0dcb-5f0e-4b1a-9c1c-000000000001'

const sourceRow = {
  id: SRC_ID,
  kind: 'markdown',
  url: null,
  title: 'OKF',
  content_hash: HASH,
  raw_content: RAW,
  markdown: RAW,
  metadata: {},
  created_at: new Date('2026-07-01T10:00:00Z'),
}

const CURRENT_REV_ID = '77777777-7777-4777-8777-777777777777'

/** Route table for a full happy-path worker run over a markdown job. */
function workerRoutes(
  overrides: { index?: Rows; sourceHit?: boolean; jobInput?: unknown; blocked?: boolean } = {},
): Route[] {
  return [
    // Claim MUST precede the generic FOR UPDATE matchers — its SQL contains
    // FOR UPDATE SKIP LOCKED too. Only the first runOnce yields a job.
    {
      match: /RETURNING id, space_id, input/,
      rows: (_values, call) =>
        call === 1
          ? [
              {
                id: 'job-1',
                space_id: 'space-1',
                input: overrides.jobInput ?? { markdown: RAW },
                lease_owner: String(_values[0]),
              },
            ]
          : [],
    },
    { match: /j\.status = 'running'/, rows: [] }, // reaper (nothing orphaned)
    // Re-ingest blocker check: a hash hit only 409s while a pending/approved
    // proposal or a live/done job still references the source.
    { match: /SELECT 1 AS blocked/, rows: overrides.blocked ? [{ blocked: 1 }] : [] },
    { match: /SELECT \* FROM "public"\."wk_spaces"/, rows: [{ slug: 'dev', settings: {} }] },
    { match: /SELECT \* FROM "public"\."wk_sources"/, rows: overrides.sourceHit ? [sourceRow] : [] },
    { match: /INSERT INTO "public"\."wk_sources"/, rows: [sourceRow] },
    { match: /SELECT c\.slug, r\.title, r\.summary/, rows: overrides.index ?? [] }, // concept index
    // getConcept (affected-concept path)
    {
      match: /AS concept_id/,
      rows: [
        {
          concept_id: 'con-1',
          revision_id: CURRENT_REV_ID,
          slug: 'okf',
          title: 'OKF',
          summary: 's',
          markdown: '# old page',
          rev: 1,
          updated_at: new Date('2026-07-01T10:00:00Z'),
          agent_meta: {},
        },
      ],
    },
    { match: /SELECT \* FROM "public"\."wk_claims"/, rows: [] },
    { match: /rel\.status = 'active'/, rows: [] },
    { match: /unnest/, rows: [] }, // contradiction matcher (pipeline + staging tx)
    { match: /SELECT \* FROM "public"\."wk_change_proposals"/, rows: [] }, // proposal dedup miss
    { match: /id = ANY\(\$2::uuid\[\]\)/, rows: (values) => (values[1] as string[]).map((id) => ({ id })) },
    { match: /INSERT INTO "public"\."wk_change_proposals"/, rows: [{ id: 'prop-1' }] },
    {
      match: /SELECT id, current_revision_id FROM wk_concepts .* FOR UPDATE/,
      rows: [{ id: 'con-1', current_revision_id: null }],
    },
    { match: /COALESCE\(MAX\(rev\), 0\)/, rows: [{ next: 1 }] },
    { match: /INSERT INTO "public"\."wk_claims"/, rows: [{ id: 'claim-1' }] },
    { match: /INSERT INTO wk_decisions/, rows: [{ id: 'dec-1' }] }, // meeting-source decision mining
    // Terminal flips are guarded on status='running' and RETURN the flipped
    // row — an empty result means "already terminal, keep it".
    { match: /UPDATE "public"\."wk_ingest_jobs"/, rows: [{ id: 'job-1' }] },
  ]
}

describe('enqueue', () => {
  test('inserts a queued job and returns its id', async () => {
    const { db, calls } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_sources"/, rows: [] },
      { match: /INSERT INTO "public"\."wk_ingest_jobs"/, rows: [{ id: 'job-1' }] },
    ])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    const result = await pipeline.enqueue(db, 'space-1', { markdown: RAW })
    expect(result).toEqual({ ingest_id: 'job-1' })
    // INSERT specifically: enqueue also COUNTS the space's waiting jobs first
    // (the per-space queue cap), and that statement names the same table.
    const insert = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_ingest_jobs"'))!
    expect(insert.values).toContain('space-1')
    expect(insert.values).toContain('queued')
    // The validated request is stored verbatim (the worker re-parses it).
    expect(JSON.parse(insert.values.find((v) => typeof v === 'string' && String(v).startsWith('{')) as string)).toEqual(
      { markdown: RAW },
    )
  })

  test('rejects invalid requests before any SQL', async () => {
    const { db, calls } = fakeDb([])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await expect(pipeline.enqueue(db, 'space-1', {} as never)).rejects.toThrow()
    await expect(pipeline.enqueue(db, 'space-1', { markdown: '# a', text: 'b' })).rejects.toThrow()
    expect(calls.length).toBe(0)
  })

  test('answers 503 llm_not_configured synchronously when no key is set', async () => {
    const { db, calls } = fakeDb([])
    const unconfigured = { ...createFakeProvider(), configured: false }
    const pipeline = createIngestPipeline(config, db, unconfigured, logger)
    await expect(pipeline.enqueue(db, 'space-1', { markdown: RAW })).rejects.toBeInstanceOf(LlmNotConfiguredError)
    expect(calls.length).toBe(0) // fail fast — nothing queued
  })

  test('markdown/text bodies get the synchronous 409 already_ingested pre-check (source still working)', async () => {
    const { db, calls } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_sources"/, rows: [{ id: SRC_ID }] },
      // A pending proposal still references the source → conflict.
      { match: /SELECT 1 AS blocked/, rows: [{ blocked: 1 }] },
    ])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    const attempt = pipeline.enqueue(db, 'space-1', { markdown: RAW })
    await expect(attempt).rejects.toBeInstanceOf(ConflictError)
    await attempt.catch((error) => {
      expect(error.code).toBe('already_ingested')
      expect(error.details).toEqual({ source_id: SRC_ID })
    })
    // The pre-check hashes exactly what createSource will hash later.
    const check = calls.find((call) => call.sql.includes('wk_sources'))!
    expect(check.values).toContain(HASH)
    expect(calls.some((call) => call.sql.includes('INSERT INTO "public"."wk_ingest_jobs"'))).toBe(false)
  })

  test('a hash hit left over from a FAILED job does not block re-submission (§9.1 recovery)', async () => {
    const { db, calls } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_sources"/, rows: [{ id: SRC_ID }] },
      { match: /SELECT 1 AS blocked/, rows: [] }, // only failed jobs/proposals reference it
      { match: /INSERT INTO "public"\."wk_ingest_jobs"/, rows: [{ id: 'job-retry' }] },
    ])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    const result = await pipeline.enqueue(db, 'space-1', { markdown: RAW })
    expect(result).toEqual({ ingest_id: 'job-retry' })
    expect(calls.some((call) => call.sql.includes('INSERT INTO "public"."wk_ingest_jobs"'))).toBe(true)
  })

  test('a wikikit-marked body is refused 422 before any SQL (export-mirror loop guard)', async () => {
    const { db, calls } = fakeDb([])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    const mirrored = '---\nwikikit:\n  space: dev\n  kind: concept\n  slug: okf\n---\n\n# OKF\n\nMirrored body.\n'
    const attempt = pipeline.enqueue(db, 'space-1', { markdown: mirrored })
    await expect(attempt).rejects.toBeInstanceOf(UnprocessableError)
    await attempt.catch((error) => expect((error as UnprocessableError).code).toBe('unprocessable'))
    // text bodies and the `wikikit: ignore` opt-out are refused the same way.
    await expect(
      pipeline.enqueue(db, 'space-1', { text: '---\nwikikit: ignore\n---\nmy note' }),
    ).rejects.toBeInstanceOf(UnprocessableError)
    expect(calls.length).toBe(0) // fail fast — nothing queued, nothing counted
  })

  test('url ingests defer the dedup check to the worker (body unknown yet)', async () => {
    const { db, calls } = fakeDb([{ match: /INSERT INTO "public"\."wk_ingest_jobs"/, rows: [{ id: 'job-2' }] }])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    const result = await pipeline.enqueue(db, 'space-1', { url: 'https://example.com/a' })
    expect(result).toEqual({ ingest_id: 'job-2' })
    expect(calls.some((call) => call.sql.includes('wk_sources'))).toBe(false)
  })
})

describe('capture lifecycle', () => {
  test('capture parks the row keyless — no LLM guard, no dedup, no queue-room count', async () => {
    const { db, calls } = fakeDb([{ match: /INSERT INTO "public"\."wk_ingest_jobs"/, rows: [{ id: 'cap-1' }] }])
    const unconfigured = { ...createFakeProvider(), configured: false }
    const pipeline = createIngestPipeline(config, db, unconfigured, logger)
    const result = await pipeline.enqueue(db, 'space-1', { text: RAW, capture: true })
    expect(result).toEqual({ status: 'captured', ingest_id: 'cap-1' })
    // The insert is the ONLY statement: no wk_sources hash pre-check, no
    // waiting-jobs count — capture pays for nothing it does not use.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.values).toContain('captured')
    // The flag is persisted with the input, so a promoted job re-parses clean.
    expect(
      JSON.parse(calls[0]!.values.find((v) => typeof v === 'string' && String(v).startsWith('{')) as string),
    ).toEqual({ text: RAW, capture: true })
  })

  test('capture cannot park a wikikit-marked note — the loop guard outranks the capture branch', async () => {
    const { db, calls } = fakeDb([])
    // Keyless on purpose: the guard must fire even where capture skips the
    // LLM guard — a parked mirror note would be synthesized at promotion.
    const unconfigured = { ...createFakeProvider(), configured: false }
    const pipeline = createIngestPipeline(config, db, unconfigured, logger)
    const mirrored = '---\nwikikit:\n  space: dev\n  kind: concept\n  slug: okf\n---\n\n# OKF\n'
    await expect(pipeline.enqueue(db, 'space-1', { text: mirrored, capture: true })).rejects.toBeInstanceOf(
      UnprocessableError,
    )
    expect(calls.length).toBe(0) // nothing parked
  })

  test('the worker claim query never sees captured rows (queued only)', async () => {
    const { db, calls } = fakeDb([])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await pipeline.runOnce()
    const claim = calls.find((call) => call.sql.includes('FOR UPDATE SKIP LOCKED'))!
    expect(claim.sql).toContain(`WHERE status = 'queued'`)
  })

  test('processCapture promotes to queued, paying the LLM guard and the queue ceiling', async () => {
    const { db, calls } = fakeDb([
      {
        match: /SELECT \* FROM "public"\."wk_ingest_jobs"/,
        rows: [{ id: 'cap-1', space_id: 'space-1', status: 'captured' }],
      },
      { match: /AS waiting/, rows: [{ waiting: 0 }] },
    ])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await pipeline.processCapture(db, 'cap-1')
    const flip = calls.find((call) => call.sql.includes(`SET status = 'queued'`))!
    // Guarded on 'captured': a racing discard wins or loses cleanly.
    expect(flip.sql).toContain(`AND status = 'captured'`)
    expect(calls.some((call) => call.sql.includes('AS waiting'))).toBe(true)
  })

  test('processCapture answers 503 at promotion when no key is set — the note stays parked', async () => {
    const { db, calls } = fakeDb([
      {
        match: /SELECT \* FROM "public"\."wk_ingest_jobs"/,
        rows: [{ id: 'cap-1', space_id: 'space-1', status: 'captured' }],
      },
    ])
    const unconfigured = { ...createFakeProvider(), configured: false }
    const pipeline = createIngestPipeline(config, db, unconfigured, logger)
    await expect(pipeline.processCapture(db, 'cap-1')).rejects.toBeInstanceOf(LlmNotConfiguredError)
    expect(calls.some((call) => call.sql.includes(`SET status = 'queued'`))).toBe(false)
  })

  test('processCapture refuses a full queue — the guard capture skipped applies here', async () => {
    const { db, calls } = fakeDb([
      {
        match: /SELECT \* FROM "public"\."wk_ingest_jobs"/,
        rows: [{ id: 'cap-1', space_id: 'space-1', status: 'captured' }],
      },
      { match: /AS waiting/, rows: [{ waiting: 50 }] },
    ])
    const pipeline = createIngestPipeline(
      { ...config, ingestMaxQueuedPerSpace: 50 } as never,
      db,
      createFakeProvider(),
      logger,
    )
    await expect(pipeline.processCapture(db, 'cap-1')).rejects.toThrow(/queue/)
    expect(calls.some((call) => call.sql.includes(`SET status = 'queued'`))).toBe(false)
  })

  test('process and discard 409 ingest_not_captured on any other status', async () => {
    const { db } = fakeDb([
      {
        match: /SELECT \* FROM "public"\."wk_ingest_jobs"/,
        rows: [{ id: 'job-1', space_id: 'space-1', status: 'done' }],
      },
    ])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    for (const attempt of [() => pipeline.processCapture(db, 'job-1'), () => pipeline.discardCapture(db, 'job-1')]) {
      const failure = attempt().then(
        () => null,
        (error: unknown) => error,
      )
      expect(await failure).toBeInstanceOf(ConflictError)
      expect(((await failure) as ConflictError).code).toBe('ingest_not_captured')
    }
  })

  test('discardCapture is terminal: discarded + finished_at, row kept', async () => {
    const { db, calls } = fakeDb([
      {
        match: /SELECT \* FROM "public"\."wk_ingest_jobs"/,
        rows: [{ id: 'cap-1', space_id: 'space-1', status: 'captured' }],
      },
    ])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await pipeline.discardCapture(db, 'cap-1')
    const flip = calls.find((call) => call.sql.includes(`SET status = 'discarded'`))!
    expect(flip.sql).toContain('finished_at = now()')
    expect(flip.sql).toContain(`AND status = 'captured'`)
    expect(calls.some((call) => call.sql.includes('DELETE'))).toBe(false)
  })
})

describe('evidence mode', () => {
  test('archives, chunks and completes done with a null proposal — zero model calls', async () => {
    const { db, calls } = fakeDb(workerRoutes({ jobInput: { markdown: RAW, evidence: true } }))
    const llm = createFakeProvider()
    const pipeline = createIngestPipeline(config, db, llm, logger)

    expect(await pipeline.runOnce()).toBe(true)

    // The caller decided this is evidence: no classify, no synthesize, no
    // audit rows — the FakeProvider is never consulted.
    expect(llm.calls.length).toBe(0)
    expect(calls.some((call) => call.sql.includes('"wk_agent_runs"'))).toBe(false)

    // Archived AND chunked — the source-evidence tier is fed before the stop.
    const sourceInsert = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_sources"'))!
    expect(sourceInsert.values).toContain(RAW)
    expect(sourceInsert.values).toContain(HASH)
    expect(calls.some((call) => call.sql.includes('"wk_source_chunks"'))).toBe(true)

    // phase stays honest: the early return sits BEFORE setPhase('classify').
    expect(calls.some((call) => call.values.includes('classify'))).toBe(false)

    // Terminal: done with the source and NO proposal.
    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.values).toContain('done')
    expect(jobUpdate.values).toContain(SRC_ID)
    expect(jobUpdate.values).not.toContain('prop-1')
    expect(calls.some((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))).toBe(false)
  })

  test('keyless: evidence enqueues (dedup pre-check still runs), normal ingest still 503s', async () => {
    const { db, calls } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_sources"/, rows: [] },
      { match: /INSERT INTO "public"\."wk_ingest_jobs"/, rows: [{ id: 'ev-1' }] },
    ])
    const unconfigured = { ...createFakeProvider(), configured: false }
    const pipeline = createIngestPipeline(config, db, unconfigured, logger)
    const result = await pipeline.enqueue(db, 'space-1', { markdown: RAW, evidence: true })
    expect(result).toEqual({ ingest_id: 'ev-1' })
    // Unlike capture, evidence stays behind the dedup pre-check …
    expect(calls.some((call) => call.sql.includes('wk_sources'))).toBe(true)
    // … and the same keyless deployment still refuses a normal ingest.
    await expect(pipeline.enqueue(db, 'space-1', { markdown: RAW })).rejects.toBeInstanceOf(LlmNotConfiguredError)
  })

  test('the queue ceiling refuses evidence when full — real worker work, unlike capture', async () => {
    const { db } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_sources"/, rows: [] },
      { match: /AS waiting/, rows: [{ waiting: 1 }] },
    ])
    const capped = { ...config, ingestMaxQueuedPerSpace: 1 } as Config
    const pipeline = createIngestPipeline(capped, db, createFakeProvider(), logger)
    await expect(pipeline.enqueue(db, 'space-1', { markdown: RAW, evidence: true })).rejects.toBeInstanceOf(
      IngestQueueFullError,
    )
  })
})

describe('worker — happy path (new concept from a markdown source)', () => {
  test('archives, classifies, synthesizes, proposes and audits in order', async () => {
    const { db, calls } = fakeDb(workerRoutes())
    const llm = createFakeProvider()
    const pipeline = createIngestPipeline(config, db, llm, logger)

    expect(await pipeline.runOnce()).toBe(true)

    // LLM call sequence: one classify over the compact index, one synthesize
    // for the single new concept the default classifier proposes.
    expect(llm.calls.map((call) => call.method)).toEqual(['classify', 'synthesize', 'extract_decisions'])
    const classifyInput = llm.calls[0]!.input as { source: { title: string | null }; conceptIndex: unknown[] }
    expect(classifyInput.source.title).toBe('OKF')
    expect(classifyInput.conceptIndex).toEqual([])
    const synthInput = llm.calls[1]!.input as {
      concept: { slug: string; currentMarkdown: string | null }
      source: { id: string }
      predicates: string[]
    }
    expect(synthInput.concept.slug).toBe('okf')
    expect(synthInput.concept.currentMarkdown).toBeNull() // new concept
    expect(synthInput.source.id).toBe(SRC_ID)
    expect(synthInput.predicates).toContain('is') // default vocabulary

    // Source archived with raw AND normalized markdown.
    const sourceInsert = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_sources"'))!
    expect(sourceInsert.values).toContain(RAW)
    expect(sourceInsert.values).toContain(HASH)

    // Proposal staged with the content-hash + prompt-version input hash and
    // §1.14-shaped agent_meta.
    const proposalInsert = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))!
    expect(proposalInsert.values).toContain(computeInputHash([HASH], 'synthesize.v3'))
    expect(proposalInsert.values).toContain('Ingest: OKF')
    const meta = JSON.parse(proposalInsert.values.find((v) => String(v).includes('prompt_version')) as string)
    expect(meta).toMatchObject({ model: 'fake', prompt_version: 'synthesize.v3', source_ids: [SRC_ID] })

    // Claim + citation with the supporting quote (FakeProvider quotes line 1).
    const citationInsert = calls.find((call) => call.sql.includes('"wk_citations"'))!
    expect(citationInsert.values).toContain('# OKF')
    expect(citationInsert.values).toContain(SRC_ID)

    // Audit: classify + synthesize + decision extraction, each pinned to job
    // AND proposal.
    const runsInsert = calls.find((call) => call.sql.includes('"wk_agent_runs"'))!
    expect(runsInsert.values).toContain('classify')
    expect(runsInsert.values).toContain('synthesize')
    expect(runsInsert.values).toContain('extract_decisions')
    expect(runsInsert.values.filter((value) => value === 'job-1').length).toBe(3)
    expect(runsInsert.values.filter((value) => value === 'prop-1').length).toBe(3)

    // Terminal: job done with source + proposal, atomically with the audit rows.
    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.values).toContain('done')
    expect(jobUpdate.values).toContain('prop-1')
    expect(jobUpdate.values).toContain(SRC_ID)
    const runsIndex = calls.indexOf(runsInsert)
    expect(calls.slice(runsIndex).some((call) => call.sql === 'COMMIT')).toBe(true)

    expect(await pipeline.runOnce()).toBe(false) // queue drained
  })

  test('affected concepts synthesize against their CURRENT page (merge-not-replace)', async () => {
    const { db, calls } = fakeDb(workerRoutes({ index: [{ slug: 'okf', title: 'OKF', summary: 's' }] }))
    const llm = createFakeProvider({ classify: () => ({ affected: ['okf'], new: [] }) })
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()
    const synthInput = llm.calls.find((call) => call.method === 'synthesize')!.input as {
      concept: { currentMarkdown: string | null }
    }
    expect(synthInput.concept.currentMarkdown).toBe('# old page')
    // Stale-base anchor = the revision the synthesis READ (before the LLM
    // calls), not whatever the pointer is at staging time.
    const revisionInsert = calls.find((call) => call.sql.includes('"wk_concept_revisions"'))!
    expect(revisionInsert.values).toContain(CURRENT_REV_ID)
  })

  test('new concepts stage an explicit null base (a concept approved mid-synthesis must fail stale-base)', async () => {
    const { db, calls } = fakeDb(workerRoutes())
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await pipeline.runOnce()
    const revisionInsert = calls.find((call) => call.sql.includes('"wk_concept_revisions"'))!
    expect(revisionInsert.values).toContain(null)
    expect(revisionInsert.values).not.toContain(CURRENT_REV_ID)
  })

  test('a meeting source stages proposed decisions (decision-log path)', async () => {
    const { db, calls } = fakeDb(workerRoutes({ jobInput: { markdown: RAW, source_kind: 'meeting' } }))
    const llm = createFakeProvider() // default emits one decision for meeting sources
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()

    // source_kind reaches synthesis…
    const synthInput = llm.calls.find((call) => call.method === 'synthesize')!.input as { sourceKind?: string }
    expect(synthInput.sourceKind).toBe('meeting')
    // …and it is persisted on the source metadata, not guessed.
    const sourceInsert = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_sources"'))!
    expect(sourceInsert.values.some((v) => String(v).includes('"source_kind":"meeting"'))).toBe(true)
    // …and a proposed wk_decisions row is staged for review.
    expect(calls.some((call) => call.sql.includes('INSERT INTO wk_decisions'))).toBe(true)
  })

  test('a non-meeting source stages no decisions', async () => {
    const { db, calls } = fakeDb(workerRoutes({ jobInput: { markdown: RAW, source_kind: 'note' } }))
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await pipeline.runOnce()
    expect(calls.some((call) => call.sql.includes('INSERT INTO wk_decisions'))).toBe(false)
    // The proposal still stages (the revision has value) — decisions are additive.
    expect(calls.some((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))).toBe(true)
  })

  test('ungrounded claims (quote not verbatim in the source) are dropped before staging', async () => {
    // Source is `# OKF\n\nOKF is a draft spec.` — one quote is verbatim, one is
    // invented. Only the grounded claim may reach wk_claims/wk_citations.
    const lines: string[] = []
    const capturing = createLogger({ write: (line) => void lines.push(line) })
    const { db, calls } = fakeDb(workerRoutes())
    const llm = createFakeProvider({
      synthesize: () => ({
        title: 'OKF',
        summary: 's',
        markdown: '# OKF',
        claims: [
          {
            subject: 'okf',
            predicate: 'is',
            object: 'draft',
            quote: 'OKF is a draft spec.',
            confidence: 0.9,
            valid_from: null,
            valid_until: null,
            context: null,
          },
          {
            subject: 'okf',
            predicate: 'has_status',
            object: 'production',
            quote: 'OKF is production ready.',
            confidence: 0.9,
            valid_from: null,
            valid_until: null,
            context: null,
          },
        ],
        relations: [],
        decisions: [],
      }),
    })
    const pipeline = createIngestPipeline(config, db, llm, capturing)
    await pipeline.runOnce()

    const staged = calls.flatMap((call) => call.values.map((v) => String(v)))
    // The grounded quote is staged…
    expect(staged.some((v) => v.includes('OKF is a draft spec.'))).toBe(true)
    // …the invented one never touches the database (dropped pre-staging).
    expect(staged.some((v) => v.includes('OKF is production ready.'))).toBe(false)
    // The proposal still stages (the grounded claim + revision have value).
    expect(calls.some((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))).toBe(true)
    // The drop is the gate SUCCEEDING — logged as routine signal (info), not
    // as an anomaly (warn).
    const drop = lines.map((line) => JSON.parse(line)).find((entry) => String(entry.msg).includes('ungrounded'))!
    expect(drop.level).toBe('info')
    expect(drop.dropped).toBe(1)
  })

  test('hallucinated affected slugs (not in the index) are dropped, not synthesized', async () => {
    const { db, calls } = fakeDb(workerRoutes())
    const llm = createFakeProvider({ classify: () => ({ affected: ['ghost'], new: [] }) })
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()
    expect(llm.calls.map((call) => call.method)).toEqual(['classify'])
    expect(calls.some((call) => call.sql.includes('wk_change_proposals') && call.sql.startsWith('INSERT'))).toBe(false)
    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.values).toContain('done') // source archived, no review work
  })

  test('claims without a supporting quote never reach wk_claims', async () => {
    const { db, calls } = fakeDb(workerRoutes())
    const llm = createFakeProvider({
      synthesize: (input) => ({
        title: input.concept.title,
        summary: 's',
        markdown: '# body',
        claims: [
          {
            subject: 'okf',
            predicate: 'is',
            object: 'unquotable',
            quote: '   ',
            confidence: 0.9,
            valid_from: null,
            valid_until: null,
            context: null,
          },
        ],
        relations: [],
        decisions: [],
      }),
    })
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()
    expect(calls.some((call) => call.sql.includes('INSERT INTO "public"."wk_claims"'))).toBe(false)
    // The proposal itself still stages (the revision has value without claims).
    expect(calls.some((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))).toBe(true)
  })

  test('oversized sources are budgeted before any model reads them', async () => {
    const longDoc = `# Big\n\n${'word '.repeat(2000)}`
    const bigHash = sha256Hex(longDoc)
    const routes = workerRoutes({ jobInput: { markdown: longDoc, title: 'Big' } })
    routes.splice(
      routes.findIndex((route) => route.match.source.includes('INSERT INTO "public"\\."wk_sources"')),
      1,
      {
        match: /INSERT INTO "public"\."wk_sources"/,
        rows: [{ ...sourceRow, content_hash: bigHash, raw_content: longDoc, markdown: longDoc, title: 'Big' }],
      },
    )
    const tightConfig = { ...config, maxIngestTokens: 100 } as Config
    const { db } = fakeDb(routes)
    const llm = createFakeProvider()
    const pipeline = createIngestPipeline(tightConfig, db, llm, logger)
    await pipeline.runOnce()
    const classifyInput = llm.calls[0]!.input as { source: { markdown: string } }
    expect(classifyInput.source.markdown.length).toBeLessThan(longDoc.length)
    expect(classifyInput.source.markdown).toContain('truncated') // model is told
  })
})

describe('worker — failure paths', () => {
  test('content-hash hit at the worker fails the job as already_ingested + event (source still working)', async () => {
    const { db, calls } = fakeDb(workerRoutes({ sourceHit: true, blocked: true }))
    const llm = createFakeProvider()
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()

    expect(llm.calls.length).toBe(0) // dedup gate sits BEFORE any LLM spend
    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.values).toContain('failed')
    const error = JSON.parse(jobUpdate.values.find((v) => String(v).includes('already_ingested')) as string)
    expect(error.code).toBe('already_ingested')
    expect(jobUpdate.values).toContain(SRC_ID) // points at the existing source

    const outbox = calls.find((call) => call.sql.includes('wk_outbox_events'))!
    expect(outbox.values[1]).toBe('wikikit.ingest.failed')
    expect(JSON.parse(outbox.values[2] as string)).toMatchObject({
      ingest_id: 'job-1',
      space: 'dev',
      error: { code: 'already_ingested' },
    })
  })

  test('content-hash hit whose earlier job FAILED reuses the archived source and proceeds', async () => {
    const { db, calls } = fakeDb(workerRoutes({ sourceHit: true, blocked: false }))
    const llm = createFakeProvider()
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()

    // Pipeline ran end-to-end against the EXISTING source row.
    expect(llm.calls.map((call) => call.method)).toEqual(['classify', 'synthesize', 'extract_decisions'])
    expect(calls.some((call) => call.sql.includes('INSERT INTO "public"."wk_sources"'))).toBe(false)
    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.values).toContain('done')
    expect(jobUpdate.values).toContain(SRC_ID)
  })

  test('an LLM failure fails the job with ingest_failed and emits the event', async () => {
    const { db, calls } = fakeDb(workerRoutes())
    const llm = createFakeProvider({
      classify: () => {
        throw new Error('model exploded')
      },
    })
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()
    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.values).toContain('failed')
    const error = JSON.parse(jobUpdate.values.find((v) => String(v).includes('model exploded')) as string)
    expect(error).toEqual({ code: 'ingest_failed', message: 'model exploded' })
    expect(calls.some((call) => call.sql.includes('wk_outbox_events'))).toBe(true)
  })

  test('the worker re-validates stored job input instead of trusting the row', async () => {
    const { db, calls } = fakeDb(workerRoutes({ jobInput: { bogus: true } }))
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await pipeline.runOnce()
    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.values).toContain('failed')
  })

  test('the reaper flips orphaned running jobs to worker_lost on every poll', async () => {
    const { db, calls } = fakeDb(workerRoutes())
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await pipeline.runOnce()
    const reap = calls.find((call) => call.sql.includes("j.status = 'running'"))!
    expect(JSON.parse(reap.values[0] as string).code).toBe('worker_lost')
    expect(calls.indexOf(reap)).toBeLessThan(
      calls.findIndex((call) => call.sql.includes('RETURNING id, space_id, input')),
    )
  })

  test('the reaper emits wikikit.ingest.failed for every reaped job, atomically with the flip', async () => {
    const routes = workerRoutes()
    routes.splice(
      routes.findIndex((route) => route.match.source.includes("j\\.status = 'running'")),
      1,
      {
        match: /j\.status = 'running'/,
        rows: [{ id: 'job-lost', space_id: 'space-1', space_slug: 'dev' }],
      },
    )
    const { db, calls } = fakeDb(routes)
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await pipeline.runOnce()
    const outbox = calls.find((call) => call.sql.includes('wk_outbox_events'))!
    expect(outbox.values[1]).toBe('wikikit.ingest.failed')
    expect(JSON.parse(outbox.values[2] as string)).toMatchObject({
      ingest_id: 'job-lost',
      space: 'dev',
      error: { code: 'worker_lost' },
    })
    // Same transaction: the event lands between the reap's BEGIN and COMMIT.
    const reapIndex = calls.findIndex((call) => call.sql.includes("j.status = 'running'"))
    const outboxIndex = calls.indexOf(outbox)
    const commitIndex = calls.findIndex((call, index) => index > reapIndex && call.sql === 'COMMIT')
    expect(outboxIndex).toBeGreaterThan(reapIndex)
    expect(outboxIndex).toBeLessThan(commitIndex)
  })

  test('a terminal flip is guarded on status=running (a reaped job is never regressed to done)', async () => {
    const routes = workerRoutes()
    // The job update matches ZERO rows — someone (the reaper) already
    // terminalized it while the worker was finishing.
    routes.splice(
      routes.findIndex((route) => route.match.source.includes('wk_ingest_jobs')),
      1,
      {
        match: /UPDATE "public"\."wk_ingest_jobs"/,
        rows: [],
      },
    )
    const { db, calls } = fakeDb(routes)
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await pipeline.runOnce()
    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.sql).toContain('"status" = $')
    expect(jobUpdate.values).toContain('running') // the guard predicate
  })

  test('a live long-running worker heartbeats its lease until the terminal flip', async () => {
    const routes = workerRoutes()
    routes.unshift({ match: /SET heartbeat_at = now\(\)/, rows: [{ id: 'job-1' }] })
    const { db, calls } = fakeDb(routes)
    const llm = createFakeProvider()
    const classify = llm.classify.bind(llm)
    llm.classify = async (input) => {
      // Longer than the whole lease: without renewal the concurrent reaper
      // would be entitled to fail this still-live job.
      await new Promise((resolve) => setTimeout(resolve, 130))
      return classify(input)
    }
    const pipeline = createIngestPipeline(config, db, llm, logger, { leaseMs: 50, heartbeatMs: 10 })

    await pipeline.runOnce()

    const heartbeats = calls.filter((call) => call.sql.includes('SET heartbeat_at = now()'))
    expect(heartbeats.length).toBeGreaterThanOrEqual(3)
    expect(heartbeats.every((call) => call.values.includes('job-1'))).toBe(true)
    const terminal = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(terminal.values).toContain('done')
  })
})

describe('worker — provider quota exhaustion', () => {
  // The reset date must stay in the future relative to the test run: the
  // pause-until-resume_at assertions below would flip once real time passes
  // a hardcoded date. Mirrors the provider's exact phrasing.
  const RESET = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const RESET_DATE = `${RESET.getUTCFullYear()}-${pad(RESET.getUTCMonth() + 1)}-${pad(RESET.getUTCDate())}`
  const RESET_TIME = `${pad(RESET.getUTCHours())}:${pad(RESET.getUTCMinutes())}`
  const RESET_ISO = `${RESET_DATE}T${RESET_TIME}:00.000Z`
  const QUOTA_MESSAGE = `You have reached your specified API usage limits. You will regain access on ${RESET_DATE} at ${RESET_TIME} UTC.`
  const quotaProvider = () =>
    createFakeProvider({
      classify: () => {
        throw new Error(QUOTA_MESSAGE)
      },
    })

  test('parseQuotaResumeAt reads the provider reset timestamp (null without one)', () => {
    expect(parseQuotaResumeAt(QUOTA_MESSAGE)).toBe(RESET_ISO)
    expect(parseQuotaResumeAt('quota exceeded')).toBeNull()
  })

  test('a quota hit parks the job as quota_blocked with the parsed resume_at — never failed', async () => {
    const { db, calls } = fakeDb(workerRoutes())
    const pipeline = createIngestPipeline(config, db, quotaProvider(), logger)
    await pipeline.runOnce()

    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.values).toContain('quota_blocked')
    expect(jobUpdate.values).toContain(RESET_ISO)
    expect(jobUpdate.values).not.toContain('failed')
    const error = JSON.parse(jobUpdate.values.find((v) => String(v).includes('usage limits')) as string)
    expect(error.code).toBe('quota_blocked')
    // Non-terminal on purpose: no wikikit.ingest.failed event — the job
    // requeues on its own once the provider window reopens.
    expect(calls.some((call) => call.sql.includes('wk_outbox_events'))).toBe(false)
  })

  test('a quota message without a parseable reset time falls back to +6h', async () => {
    const { db, calls } = fakeDb(workerRoutes())
    const llm = createFakeProvider({
      classify: () => {
        throw new Error('quota exceeded')
      },
    })
    const before = Date.now()
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()
    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    const resumeAt = jobUpdate.values.map((v) => Date.parse(String(v))).find((t) => t > before + 5 * 60 * 60 * 1000)
    expect(resumeAt).toBeDefined()
    expect(resumeAt!).toBeLessThanOrEqual(Date.now() + 6 * 60 * 60 * 1000)
  })

  test('entering quota_blocked emits exactly ONE error line, then claiming pauses silently', async () => {
    const lines: string[] = []
    const capturing = createLogger({ write: (line) => void lines.push(line) })
    const { db, calls } = fakeDb(workerRoutes())
    const pipeline = createIngestPipeline(config, db, quotaProvider(), capturing)

    await pipeline.runOnce()
    const errors = lines.map((line) => JSON.parse(line)).filter((entry) => entry.level === 'error')
    expect(errors.length).toBe(1)
    expect(errors[0].msg).toContain('quota')
    expect(errors[0].resume_at).toBe(RESET_ISO)

    // Paused until resume_at: not a single further SQL statement or log line.
    const sqlBefore = calls.length
    expect(await pipeline.runOnce()).toBe(false)
    expect(calls.length).toBe(sqlBefore)
    expect(lines.map((line) => JSON.parse(line)).filter((entry) => entry.level === 'error').length).toBe(1)
  })

  test('due quota_blocked jobs are requeued before each claim', async () => {
    const { db, calls } = fakeDb(workerRoutes())
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await pipeline.runOnce()
    const requeue = calls.findIndex((call) => call.sql.includes("status = 'quota_blocked'"))
    expect(requeue).toBeGreaterThanOrEqual(0)
    expect(calls[requeue]!.sql).toContain("SET status = 'queued'")
    expect(requeue).toBeLessThan(calls.findIndex((call) => call.sql.includes('RETURNING id, space_id, input')))
  })
})

describe('start/stop lifecycle', () => {
  test('stop() wakes idle loops and resolves promptly', async () => {
    const { db } = fakeDb([{ match: /RETURNING id, space_id, input/, rows: [] }])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger, { pollMs: 60_000 })
    pipeline.start()
    pipeline.start() // idempotent — no duplicate loops
    // Give the loop one tick to reach its idle sleep, then stop must not wait
    // out the 60s poll interval.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const before = Date.now()
    await pipeline.stop()
    expect(Date.now() - before).toBeLessThan(1000)
  })
})

describe('worker — adjudication (0021)', () => {
  // A persisted-side frame collision must trigger ONE adjudicate call whose
  // verdict routes the staged claim: complementary → exempt stamp, temporal →
  // supersedes_claim_id, contradictory/failure → dispute path.
  function collisionRoutes(): Route[] {
    const routes = workerRoutes()
    return [
      // Functional predicate declared → the matcher considers 'is'.
      {
        match: /SELECT \* FROM "public"\."wk_spaces"/,
        rows: [{ slug: 'dev', settings: { functional_predicates: ['is'] } }],
      },
      // Persisted collision for the fake's default claim (okf is described).
      {
        match: /unnest/,
        rows: [
          {
            id: '9a1e0dcb-5f0e-4b1a-9c1c-00000000c01d',
            concept_id: 'con-old',
            subject: 'okf',
            predicate: 'is',
            object: 'something-else',
            object_normalized: null,
            context: null,
            valid_from: null,
            valid_until: null,
            status: 'verified',
            quote: 'old quote',
          },
        ],
      },
      ...routes.filter((route) => !String(route.match).includes('wk_spaces')),
    ]
  }

  test('temporal verdict stages supersedes_claim_id and reports a supersession', async () => {
    const { db, calls } = fakeDb(collisionRoutes())
    const llm = createFakeProvider({ adjudicate: () => ({ verdict: 'temporal', reason: 'version moved on' }) })
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()

    expect(llm.calls.filter((call) => call.method === 'adjudicate')).toHaveLength(1)
    const claimInsert = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_claims"'))!
    expect(claimInsert.values).toContain('9a1e0dcb-5f0e-4b1a-9c1c-00000000c01d') // supersedes target staged
    const proposalInsert = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))!
    expect(String(proposalInsert.values[2])).toContain('1 supersession')
    expect(String(proposalInsert.values[2])).not.toContain('contradiction')
  })

  test('complementary verdict stamps the exemption and drops the contradiction from the summary', async () => {
    const { db, calls } = fakeDb(collisionRoutes())
    const llm = createFakeProvider({ adjudicate: () => ({ verdict: 'complementary', reason: 'both hold' }) })
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()

    const claimInsert = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_claims"'))!
    expect(claimInsert.values.some((value) => String(value).includes('"adjudication":"complementary"'))).toBe(true)
    const proposalInsert = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))!
    expect(String(proposalInsert.values[2])).not.toContain('contradiction')
  })

  test('adjudication failure falls back to the contradictory dispute path — the job never fails', async () => {
    const { db, calls } = fakeDb(collisionRoutes())
    const llm = createFakeProvider({
      adjudicate: () => {
        throw new Error('provider exploded')
      },
    })
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()

    const proposalInsert = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))!
    expect(String(proposalInsert.values[2])).toContain('1 contradiction')
    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.values).toContain('done')
  })
})

// ---------------------------------------------------------------------------
// Decision extraction (decisions.v1) — one call per ingest, deduped against
// the decisions the space already holds.
//
// The bug these cover: decisions used to come out of synthesis, which runs
// once per affected concept. Each call read the same source and proposed the
// same choice under its own slug, so one decision entered the log up to five
// times. Extraction now happens once and compares against the active set.
// ---------------------------------------------------------------------------

/** Route table where the space already holds two active decisions. */
function decisionRoutes(active: Rows = []): Route[] {
  return [{ match: /SELECT \* FROM "public"\."wk_decisions"/, rows: active }, ...workerRoutes()]
}

const ACTIVE_DECISIONS: Rows = [
  {
    id: '8f2c1a44-1111-4111-8111-000000000001',
    slug: 'ship-on-friday',
    title: 'Ship on Friday',
    decision: 'Releases go out on Friday mornings.',
  },
]

/** One extracted decision, with the markers defaulted to "new". */
function found(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'ship-on-friday-2',
    title: 'Ship on Friday',
    context: 'Release cadence was on the table.',
    decision: 'Releases go out on Friday mornings.',
    rationale: '',
    alternatives: [],
    duplicate_of: null,
    updates: null,
    ...overrides,
  }
}

describe('worker — decision extraction and dedupe', () => {
  test('runs ONE extraction call for the whole source, not one per concept', async () => {
    const { db } = fakeDb(
      decisionRoutes().map((route) =>
        route.match.source.includes('c\\.slug, r\\.title')
          ? {
              ...route,
              rows: [
                { slug: 'okf', title: 'OKF', summary: 's' },
                { slug: 'wikikit', title: 'WikiKit', summary: 's' },
              ],
            }
          : route,
      ),
    )
    const llm = createFakeProvider({
      classify: () => ({ affected: ['okf', 'wikikit'], new: [] }),
      extractDecisions: () => ({ decisions: [found()] }),
    })
    await createIngestPipeline(config, db, llm, logger).runOnce()

    // Two concepts synthesized, but decisions were mined exactly once — the
    // whole point of moving them out of the per-concept loop.
    expect(llm.calls.filter((call) => call.method === 'synthesize').length).toBe(2)
    expect(llm.calls.filter((call) => call.method === 'extract_decisions').length).toBe(1)
  })

  test('a decision the space already holds is counted, not staged again', async () => {
    const { db, calls } = fakeDb(decisionRoutes(ACTIVE_DECISIONS))
    const llm = createFakeProvider({
      extractDecisions: () => ({
        decisions: [found({ duplicate_of: 'ship-on-friday' }), found({ slug: 'a-new-choice', duplicate_of: null })],
      }),
    })
    await createIngestPipeline(config, db, llm, logger).runOnce()

    const staged = calls.filter((call) => call.sql.includes('INSERT INTO wk_decisions'))
    expect(staged.length).toBe(1)
    expect(staged[0]!.values).toContain('a-new-choice')
    // The reviewer is told what was found and dropped; a silent skip would
    // read as "the source recorded nothing".
    const proposal = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))!
    expect(String(proposal.values[2])).toContain('1 decision already recorded (not re-staged)')
  })

  test('a slug that already names an active decision IS that decision, marker or not', async () => {
    const { db, calls } = fakeDb(decisionRoutes(ACTIVE_DECISIONS))
    const llm = createFakeProvider({
      extractDecisions: () => ({ decisions: [found({ slug: 'ship-on-friday' })] }),
    })
    await createIngestPipeline(config, db, llm, logger).runOnce()

    // Previously the staging upsert swallowed this collision without a word
    // (ON CONFLICT ... WHERE status <> 'active'). Now it is reported.
    expect(calls.filter((call) => call.sql.includes('INSERT INTO wk_decisions')).length).toBe(0)
    const proposal = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))!
    expect(String(proposal.values[2])).toContain('1 decision already recorded')
  })

  test('a decision that CHANGES an active one is staged with the supersede pointer', async () => {
    const { db, calls } = fakeDb(decisionRoutes(ACTIVE_DECISIONS))
    const llm = createFakeProvider({
      extractDecisions: () => ({
        decisions: [
          found({
            slug: 'ship-on-friday',
            decision: 'Releases move to Tuesday mornings.',
            updates: 'ship-on-friday',
          }),
        ],
      }),
    })
    await createIngestPipeline(config, db, llm, logger).runOnce()

    const staged = calls.find((call) => call.sql.includes('INSERT INTO wk_decisions'))!
    expect(staged.values).toContain('8f2c1a44-1111-4111-8111-000000000001')
    // Both rows must coexist under unique(space_id, slug) until approval
    // retires the old one, so the successor gets a slug of its own.
    expect(staged.values).toContain('ship-on-friday-2')
    const proposal = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))!
    expect(String(proposal.values[2])).toContain('1 decision update')
  })

  test('a marker naming a decision that does not exist is staged as new, never merged', async () => {
    const { db, calls } = fakeDb(decisionRoutes(ACTIVE_DECISIONS))
    const llm = createFakeProvider({
      extractDecisions: () => ({ decisions: [found({ slug: 'invented', duplicate_of: 'no-such-decision' })] }),
    })
    await createIngestPipeline(config, db, llm, logger).runOnce()

    const staged = calls.filter((call) => call.sql.includes('INSERT INTO wk_decisions'))
    expect(staged.length).toBe(1)
    expect(staged[0]!.values).toContain('invented')
  })

  test('repeats of one slug within a single extraction collapse to the first', async () => {
    const { db, calls } = fakeDb(decisionRoutes())
    const llm = createFakeProvider({
      extractDecisions: () => ({ decisions: [found({ title: 'First' }), found({ title: 'Second' })] }),
    })
    await createIngestPipeline(config, db, llm, logger).runOnce()

    const staged = calls.filter((call) => call.sql.includes('INSERT INTO wk_decisions'))
    expect(staged.length).toBe(1)
    expect(staged[0]!.values).toContain('First')
  })

  test('the per-ingest cap bounds how much decision work one proposal can carry', async () => {
    const { db, calls } = fakeDb(decisionRoutes())
    const llm = createFakeProvider({
      extractDecisions: () => ({
        decisions: Array.from({ length: 14 }, (_, index) => found({ slug: `choice-${index}` })),
      }),
    })
    await createIngestPipeline(config, db, llm, logger).runOnce()

    expect(calls.filter((call) => call.sql.includes('INSERT INTO wk_decisions')).length).toBe(10)
  })

  test('synthesis output no longer carries decisions into the proposal', async () => {
    const { db, calls } = fakeDb(decisionRoutes())
    const llm = createFakeProvider({ extractDecisions: () => ({ decisions: [] }) })
    await createIngestPipeline(config, db, llm, logger).runOnce()

    expect(calls.some((call) => call.sql.includes('INSERT INTO wk_decisions'))).toBe(false)
    const extraction = llm.calls.find((call) => call.method === 'extract_decisions')!
    // The extractor is given the active set — without it, "already recorded"
    // is not a question it can answer.
    expect(extraction.input).toHaveProperty('existingDecisions')
  })
})

// ---------------------------------------------------------------------------
// Progress and the runtime ceiling
// ---------------------------------------------------------------------------

describe('worker — phase, progress and the runtime ceiling', () => {
  test('publishes the stage it is in, and its position inside the synthesis loop', async () => {
    const { db, calls } = fakeDb(decisionRoutes())
    const llm = createFakeProvider({ extractDecisions: () => ({ decisions: [] }) })
    await createIngestPipeline(config, db, llm, logger).runOnce()

    const phases = calls.filter((call) => call.sql.includes('SET phase')).map((call) => call.values[2])
    expect(phases).toEqual(['acquire', 'classify', 'synthesize', 'synthesize', 'decisions', 'adjudicate', 'propose'])
    // The total is published BEFORE the loop: "0 of 1" at minute one is what
    // makes "1 of 1" at minute three mean something.
    const synthesis = calls.filter((call) => call.sql.includes('SET phase') && call.values[2] === 'synthesize')
    expect(synthesis.map((call) => [call.values[3], call.values[4]])).toEqual([
      [0, 1],
      [1, 1],
    ])
  })

  test('a failed progress write never costs the ingest it describes', async () => {
    const { db, calls } = fakeDb([
      { match: /SET phase/, error: new Error('progress write exploded') },
      ...decisionRoutes(),
    ])
    const llm = createFakeProvider({ extractDecisions: () => ({ decisions: [] }) })
    await createIngestPipeline(config, db, llm, logger).runOnce()

    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.values).toContain('done')
  })

  test('claiming a job clears the previous attempt’s progress', async () => {
    const { db, calls } = fakeDb(decisionRoutes())
    await createIngestPipeline(config, db, createFakeProvider(), logger).runOnce()
    const claim = calls.find((call) => call.sql.includes('RETURNING id, space_id, input'))!
    expect(claim.sql).toContain('phase = null')
    expect(claim.sql).toContain('progress_done = null')
  })

  test('a job over the ceiling is aborted and fails with error.code=timeout', async () => {
    const { db, calls } = fakeDb(decisionRoutes())
    const outcomes: [string, number][] = []
    const llm = {
      ...createFakeProvider(),
      // A call that never returns on its own — exactly the shape that made a
      // live worker renew its lease forever.
      synthesize: (_input: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted by the ceiling')))
        }),
    } as never
    const pipeline = createIngestPipeline(config, db, llm, logger, {
      maxRuntimeMs: 10,
      metrics: { ingestJob: (status, ms) => outcomes.push([status, ms]) },
    })
    await pipeline.runOnce()

    const jobUpdate = calls.find(
      (call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"') && call.values.includes('failed'),
    )!
    expect(String(jobUpdate.values.find((value) => String(value).includes('code')))).toContain('timeout')
    expect(outcomes.map(([status]) => status)).toEqual(['timeout'])
  })

  test('the reaper is the backstop for a worker that renews its lease but never finishes', async () => {
    const reaped: unknown[][] = []
    const outcomes: string[] = []
    const { db } = fakeDb([
      {
        // The runtime pass — distinct from the lease pass below.
        match: /j\.started_at < now\(\)/,
        rows: (values) => {
          reaped.push(values)
          return [{ id: 'job-stuck', space_id: 'space-1', space_slug: 'dev', runtime_ms: 2_700_000 }]
        },
      },
      { match: /j\.status = 'running'/, rows: [] },
      { match: /RETURNING id, space_id, input/, rows: [] },
      { match: /INSERT INTO "public"\."wk_outbox_events"/, rows: [] },
    ])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger, {
      maxRuntimeMs: 60_000,
      metrics: { ingestJob: (status) => outcomes.push(status) },
    })
    await pipeline.runOnce()

    expect(String(reaped[0]![0])).toContain('timeout')
    expect(outcomes).toEqual(['timeout'])
  })
})

describe('worker — re-synthesis of an archived source', () => {
  test('resynthesize runs the current pipeline over content the archive already holds', async () => {
    const { db, calls } = fakeDb(
      decisionRoutes().map((route) =>
        route.match.source === 'RETURNING id, space_id, input'
          ? {
              ...route,
              rows: (values: unknown[], call: number) =>
                call === 1
                  ? [
                      {
                        id: 'job-1',
                        space_id: 'space-1',
                        input: { markdown: RAW, resynthesize: true },
                        lease_owner: String(values[0]),
                      },
                    ]
                  : [],
            }
          : route,
      ),
    )
    // Both gates would refuse this content: it is archived AND an approved
    // proposal references it.
    const routes = calls
    const llm = createFakeProvider({ extractDecisions: () => ({ decisions: [] }) })
    await createIngestPipeline(config, db, llm, logger).runOnce()
    void routes

    const jobUpdate = calls.find((call) => call.sql.includes('UPDATE "public"."wk_ingest_jobs"'))!
    expect(jobUpdate.values).toContain('done')
  })

  test('without the flag, an archived source still refuses a second ingest', async () => {
    const { db } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_sources"/, rows: [{ id: SRC_ID }] },
      { match: /SELECT 1 AS blocked/, rows: [{ blocked: 1 }] },
    ])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    await expect(pipeline.enqueue(db, 'space-1', { markdown: RAW })).rejects.toBeInstanceOf(ConflictError)
  })

  test('with the flag, enqueue accepts the same content again', async () => {
    const { db } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_sources"/, rows: [{ id: SRC_ID }] },
      { match: /SELECT 1 AS blocked/, rows: [{ blocked: 1 }] },
      { match: /INSERT INTO "public"\."wk_ingest_jobs"/, rows: [{ id: 'job-resynth' }] },
    ])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    expect(await pipeline.enqueue(db, 'space-1', { markdown: RAW, resynthesize: true })).toEqual({
      ingest_id: 'job-resynth',
    })
  })
})
