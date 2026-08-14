// Backpressure at the inbox, against real Postgres:
// WIKIKIT_INGEST_MAX_QUEUED_PER_SPACE, the 429 `ingest_queue_full` at the
// boundary, and 202 one job below it.
//
// WHY IT IS A REFUSAL AND NOT A LONGER QUEUE. Dropping fifty files costs fifty
// classify calls plus a synthesis call per page they touch — real money and
// hours of wall clock — and each one lands as a separate proposal a human has to
// decide. A queue that silently accepts all of it looks exactly like one that is
// keeping up, right until the review backlog is unclearable. That is the
// production failure this cap exists for, and the person doing the dropping is
// the only one who can decide to stop, so they are told.
//
// WHY IT MUST BE AN INTEGRATION TEST. Everything load-bearing here is a fact
// about SQL, and a stubbed pool would happily agree with whatever it was handed:
// which job STATES count toward the ceiling, that the count is scoped to one
// space, and where the check sits relative to the content-hash pre-check.
//
// RUN_INTEGRATION=1 gated.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createApp, type App } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { BUILT_IN_SCAFFOLDING_KINDS } from '../../src/domain/concepts.ts'
import { createLogger } from '../../src/logger.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

const BOOTSTRAP = 'wk_itest-queue-bootstrap'
/** Small enough to reach in four requests, large enough that the boundary is a boundary. */
const CAP = 3

function integrationConfig(databaseUrl: string): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    databaseUrl,
    keyPepper: 'itest-queue-pepper',
    bootstrapApiKey: BOOTSTRAP,
    llmProvider: 'anthropic' as const,
    llmApiKey: 'itest',
    llmApiKeyEnv: 'ANTHROPIC_API_KEY',
    anthropicBaseUrl: '',
    modelSynthesis: 'claude-sonnet-5',
    modelClassify: 'claude-haiku-4-5',
    modelAnswer: 'claude-sonnet-5',
    maxBodyBytes: 10 * 1024 * 1024,
    maxIngestTokens: 100_000,
    ingestConcurrency: 1,
    ingestLeaseMs: 15 * 60 * 1000,
    ingestHeartbeatMs: 30_000,
    ingestMaxRuntimeMs: 90 * 60 * 1000,
    ingestMaxQueuedPerSpace: CAP,
    webhookPollMs: 60_000,
    webhookTimeoutMs: 1000,
    webhookMaxAttempts: 1,
    webhookCircuitThreshold: 5,
    webhookAllowPrivateTargets: true,
    trustProxy: false,
    mcpSessionTtlMs: 60_000,
    mcpMaxSessions: 10,
    logLevel: 'error',
    version: '0.0.0-itest',
    llmConfigured: true,
    scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS,
    scaffoldingKindsDeclared: false,
    schedulerEnabled: false,
  }
}

let app: App
let database: Database
let db: Db
let base: string
let writerKey = ''

const json = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' })

interface Refusal {
  code: string
  error: string
  queued?: number
  limit?: number
  next_best_actions?: string[]
  source_id?: string
}

/** Submit one distinct document; returns the status and the parsed body. */
async function submit(
  space: string,
  markdown: string,
): Promise<{ status: number; body: Refusal & { ingest_id?: string } }> {
  const res = await fetch(`${base}/v1/spaces/${space}/ingest`, {
    method: 'POST',
    headers: json(writerKey),
    body: JSON.stringify({ markdown, title: markdown.slice(2, 40) }),
  })
  return { status: res.status, body: (await res.json()) as Refusal & { ingest_id?: string } }
}

const doc = (n: number) => `# Note ${n}\n\nBody of note number ${n}, unlike any other.\n`
const ARCHIVED = '# Archived note\n\nThis one is already in the archive before the queue fills.\n'

/** Force a job into a state the worker would otherwise have to reach. */
async function setStatus(ingestId: string, status: string): Promise<void> {
  await db.query(`UPDATE wk_ingest_jobs SET status = $2 WHERE id = $1`, [ingestId, status])
}

async function waiting(space: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM wk_ingest_jobs j JOIN wk_spaces s ON s.id = j.space_id
      WHERE s.slug = $1 AND j.status IN ('queued', 'quota_blocked')`,
    [space],
  )
  return rows[0]!.count
}

const queued: string[] = []

describe('the per-space ingest queue cap (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_queue_cap')
    const config = integrationConfig(url)
    await runMigrations(config)
    database = createPostgres(config)
    db = database.db
    app = createApp(config, {
      database,
      llm: createFakeProvider(),
      logger: createLogger({ level: 'error', write: () => {} }),
    })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`

    for (const slug of ['demo', 'other']) {
      await fetch(`${base}/v1/spaces`, {
        method: 'POST',
        headers: json(BOOTSTRAP),
        body: JSON.stringify({ slug, name: slug }),
      })
    }
    const key = await fetch(`${base}/v1/api-keys`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ name: 'writer', scopes: ['knowledge:read', 'knowledge:propose'] }),
    })
    writerKey = ((await key.json()) as { key: string }).key
  })

  afterAll(async () => {
    if (!integration) return
    await app.close()
  })

  it('one document is archived first, so the dedup path can be told apart later', async () => {
    const first = await submit('demo', ARCHIVED)
    expect(first.status).toBe(202)
    expect(await app.ingest.runOnce()).toBe(true)
    expect(await waiting('demo')).toBe(0)
  })

  it('accepts up to the ceiling and refuses AT it, with the numbers in the envelope', async () => {
    for (let index = 0; index < CAP; index++) {
      const accepted = await submit('demo', doc(index))
      expect(accepted.status, `submission ${index} was refused early`).toBe(202)
      queued.push(accepted.body.ingest_id!)
    }
    expect(await waiting('demo')).toBe(CAP)

    const refused = await submit('demo', doc(99))
    expect(refused.status).toBe(429)
    expect(refused.body.code).toBe('ingest_queue_full')
    // Both numbers ride in the envelope so a bulk uploader can say "37 of your
    // 50 files were accepted, the queue is at its ceiling" without a second
    // round trip.
    expect(refused.body.queued).toBe(CAP)
    expect(refused.body.limit).toBe(CAP)
    expect(refused.body.next_best_actions?.length).toBeGreaterThan(0)
    // …and it says the review gate, not the worker, is usually the bottleneck.
    expect(refused.body.next_best_actions!.join(' ')).toContain('review')
    // Nothing was queued: the refusal is a refusal, not a partial accept.
    expect(await waiting('demo')).toBe(CAP)
  })

  it('is NOT the neighbouring 429 — a queue-full is not a rate limit', async () => {
    // Rate limiting is about request FREQUENCY and its remedy is "wait and retry
    // the same call". Here the request was perfectly paced; what is full is the
    // work queue, and a client that treats this as a rate limit retries in a
    // loop and learns nothing.
    const refused = await submit('demo', doc(98))
    expect(refused.body.code).not.toBe('rate_limited')
    expect(refused.body.error).toContain('nothing was queued')
  })

  it('the ceiling is PER SPACE — a full wiki does not block a quiet one', async () => {
    const other = await submit('other', doc(1))
    expect(other.status).toBe(202)
  })

  it('a RUNNING job does not count: it is draining, not waiting', async () => {
    // Counting it would make the effective ceiling wobble with the worker's
    // pace, which is not something an operator can reason about.
    await setStatus(queued[0]!, 'running')
    expect(await waiting('demo')).toBe(CAP - 1)
    const accepted = await submit('demo', doc(97))
    expect(accepted.status).toBe(202)
    queued.push(accepted.body.ingest_id!)
  })

  it('a QUOTA-BLOCKED job does count: it is accepted work nobody has done', async () => {
    // The case the cap exists for. A space whose provider quota is exhausted
    // would otherwise accumulate unbounded work behind a ceiling that reads
    // zero — the exact situation the guard is meant to catch.
    await setStatus(queued[1]!, 'quota_blocked')
    expect(await waiting('demo')).toBe(CAP)
    const refused = await submit('demo', doc(96))
    expect(refused.status).toBe(429)
    expect(refused.body.queued).toBe(CAP)
  })

  it('content already archived still answers already_ingested, not queue_full', async () => {
    // Ordering: the cap sits AFTER the content-hash pre-check. A re-submission
    // of archived content was never going to queue anything, and 409 with the
    // source id is the precise answer — replacing it with a vaguer refusal would
    // lose the one fact the caller can act on.
    const duplicate = await submit('demo', ARCHIVED)
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.code).toBe('already_ingested')
    expect(duplicate.body.source_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('draining below the ceiling opens the door again', async () => {
    // Which is the whole shape of the contract: a refusal that never clears is
    // an outage, and this one clears the moment the queue does.
    await db.query(`UPDATE wk_ingest_jobs SET status = 'done' WHERE status IN ('queued', 'quota_blocked')`)
    expect(await waiting('demo')).toBe(0)
    const accepted = await submit('demo', doc(95))
    expect(accepted.status).toBe(202)
  })
})
