// pipeline.ts — enqueue (sync 409/503 semantics) and the worker body:
// acquire → archive+dedup → classify → synthesize → detect → propose →
// agent-run audit + job terminal state. Deterministic and offline: FakeProvider
// for the LLM, a routed stub pool for Postgres (the domain-test pattern).
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { ConflictError, LlmNotConfiguredError } from '../../src/domain/errors.ts'
import { computeInputHash } from '../../src/domain/proposals.ts'
import { sha256Hex } from '../../src/domain/sources.ts'
import { createIngestPipeline } from '../../src/ingest/pipeline.ts'
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
        call === 1 ? [{ id: 'job-1', space_id: 'space-1', input: overrides.jobInput ?? { markdown: RAW } }] : [],
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
    const insert = calls.find((call) => call.sql.includes('wk_ingest_jobs'))!
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

  test('url ingests defer the dedup check to the worker (body unknown yet)', async () => {
    const { db, calls } = fakeDb([{ match: /INSERT INTO "public"\."wk_ingest_jobs"/, rows: [{ id: 'job-2' }] }])
    const pipeline = createIngestPipeline(config, db, createFakeProvider(), logger)
    const result = await pipeline.enqueue(db, 'space-1', { url: 'https://example.com/a' })
    expect(result.ingest_id).toBe('job-2')
    expect(calls.some((call) => call.sql.includes('wk_sources'))).toBe(false)
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
    expect(llm.calls.map((call) => call.method)).toEqual(['classify', 'synthesize'])
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
    expect(proposalInsert.values).toContain(computeInputHash([HASH], 'synthesize.v1'))
    expect(proposalInsert.values).toContain('Ingest: OKF')
    const meta = JSON.parse(proposalInsert.values.find((v) => String(v).includes('prompt_version')) as string)
    expect(meta).toMatchObject({ model: 'fake', prompt_version: 'synthesize.v1', source_ids: [SRC_ID] })

    // Claim + citation with the supporting quote (FakeProvider quotes line 1).
    const citationInsert = calls.find((call) => call.sql.includes('"wk_citations"'))!
    expect(citationInsert.values).toContain('# OKF')
    expect(citationInsert.values).toContain(SRC_ID)

    // Audit: classify + synthesize runs pinned to job AND proposal.
    const runsInsert = calls.find((call) => call.sql.includes('"wk_agent_runs"'))!
    expect(runsInsert.values).toContain('classify')
    expect(runsInsert.values).toContain('synthesize')
    expect(runsInsert.values.filter((value) => value === 'job-1').length).toBe(2)
    expect(runsInsert.values.filter((value) => value === 'prop-1').length).toBe(2)

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
    const { db, calls } = fakeDb(workerRoutes())
    const llm = createFakeProvider({
      synthesize: () => ({
        title: 'OKF',
        summary: 's',
        markdown: '# OKF',
        claims: [
          { subject: 'okf', predicate: 'is', object: 'draft', quote: 'OKF is a draft spec.', confidence: 0.9 },
          {
            subject: 'okf',
            predicate: 'has_status',
            object: 'production',
            quote: 'OKF is production ready.',
            confidence: 0.9,
          },
        ],
        relations: [],
        decisions: [],
      }),
    })
    const pipeline = createIngestPipeline(config, db, llm, logger)
    await pipeline.runOnce()

    const staged = calls.flatMap((call) => call.values.map((v) => String(v)))
    // The grounded quote is staged…
    expect(staged.some((v) => v.includes('OKF is a draft spec.'))).toBe(true)
    // …the invented one never touches the database (dropped pre-staging).
    expect(staged.some((v) => v.includes('OKF is production ready.'))).toBe(false)
    // The proposal still stages (the grounded claim + revision have value).
    expect(calls.some((call) => call.sql.includes('INSERT INTO "public"."wk_change_proposals"'))).toBe(true)
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
        claims: [{ subject: 'okf', predicate: 'is', object: 'unquotable', quote: '   ', confidence: 0.9 }],
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
    expect(llm.calls.map((call) => call.method)).toEqual(['classify', 'synthesize'])
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
