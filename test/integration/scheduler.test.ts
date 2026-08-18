// The in-process schedule worker against real Postgres — and above all: TWO
// instances against ONE database produce EXACTLY ONE briefing per window.
//
// WHY THAT IS THE POINT OF THE FILE. WikiKit ships as a binary an operator can
// run more than one of, and the claim discipline is the only thing standing
// between that and a duplicate report every morning. `FOR UPDATE SKIP LOCKED`
// plus advancing `next_run_at` INSIDE the claiming transaction is the whole
// mechanism: the second instance finds the row locked, skips it, and by the time
// it looks again the row is no longer due. That is a statement about Postgres
// row locks and transaction visibility — a fake pool can only agree with it, and
// asserting "the code calls SKIP LOCKED" asserts a string, not a behaviour. So
// the assertion here is the COUNT: one output, one advance, whatever the two
// instances do to each other.
//
// The direction of the trade is deliberate and also tested: the window is
// advanced BEFORE the job body runs, so a crash loses that window's report
// rather than risking two. A missing briefing is repaired by tomorrow's; a
// duplicate is noise in the record forever.
//
// RUN_INTEGRATION=1 gated.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createApp, type App } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { BUILT_IN_SCAFFOLDING_KINDS } from '../../src/domain/concepts.ts'
import { createLogger } from '../../src/logger.ts'
import { createScheduler, type Scheduler } from '../../src/schedule.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

const BOOTSTRAP = 'wk_itest-scheduler-bootstrap'

function integrationConfig(databaseUrl: string): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    databaseUrl,
    keyPepper: 'itest-scheduler-pepper',
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
    // The timers stay off in this file: both instances are driven by runOnce()
    // so the race is deterministic rather than a sleep somebody has to tune.
    schedulerEnabled: true,
  }
}

let app: App
let database: Database
let db: Db
let secondDatabase: Database
let instanceA: Scheduler
let instanceB: Scheduler
let base: string
let spaceId = ''
let adminKey = ''
let writerKey = ''

const json = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' })

async function outputs(kind: string): Promise<{ id: string; title: string; markdown: string }[]> {
  const { rows } = await db.query<{ id: string; title: string; markdown: string }>(
    `SELECT id, title, markdown FROM wk_outputs WHERE space_id = $1 AND kind = $2 ORDER BY created_at`,
    [spaceId, kind],
  )
  return rows
}

async function scheduleRow(kind: string): Promise<{ next_run_at: string | null; last_run_at: string | null }> {
  const { rows } = await db.query<{ next_run_at: string | null; last_run_at: string | null }>(
    `SELECT next_run_at, last_run_at FROM wk_schedules WHERE space_id = $1 AND kind = $2`,
    [spaceId, kind],
  )
  return rows[0]!
}

/** Open the window by hand — the alternative is waiting until tomorrow morning. */
async function makeDue(kind: string): Promise<void> {
  await db.query(
    `UPDATE wk_schedules SET next_run_at = now() - interval '1 minute' WHERE space_id = $1 AND kind = $2`,
    [spaceId, kind],
  )
}

// ---------------------------------------------------------------------------
// WIKIKIT_DEFAULT_BRIEFING — a new wiki starts armed
//
// WHY this is an integration test and not a unit one: the claim is that the row
// exists, is enabled and carries a computed next_run_at after an ordinary
// POST /v1/spaces — that is the seam between the route, the schedule module and
// the table, and a fake pool can only agree with itself about it. The seed is
// deliberately best-effort, so the test that matters most is the NEGATIVE one:
// `off` must leave the wiki with no timetable at all rather than an off row.
describe('the default briefing on a new wiki (integration)', () => {
  let seededDb: Database | null = null
  let seededApp: App | null = null
  let seededBase = ''

  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_seed_briefing')
    const config: Config = {
      ...integrationConfig(url),
      defaultBriefing: { at_time: '07:00', timezone: 'Europe/Berlin' },
    }
    await runMigrations(config)
    seededDb = createPostgres(config)
    seededApp = createApp(config, {
      database: seededDb,
      llm: createFakeProvider(),
      logger: createLogger({ level: 'error', write: () => {} }),
    })
    await new Promise<void>((resolve) => seededApp!.server.listen(0, '127.0.0.1', resolve))
    seededBase = `http://127.0.0.1:${(seededApp!.server.address() as { port: number }).port}`
  })

  afterAll(async () => {
    if (seededApp) await new Promise<void>((resolve) => seededApp!.server.close(() => resolve()))
    if (seededDb) await seededDb.close()
  })

  test.skipIf(!integration)('a wiki created over REST comes back with an armed briefing', async () => {
    const created = await fetch(`${seededBase}/v1/spaces`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ slug: 'fresh', name: 'Fresh Space' }),
    })
    expect(created.status).toBe(201)

    const res = await fetch(`${seededBase}/v1/spaces/fresh/schedules`, { headers: json(BOOTSTRAP) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      schedules: {
        kind: string
        at_time: string
        timezone: string
        weekday: number | null
        enabled: boolean
        next_run_at: string | null
        last_run_at: string | null
      }[]
    }

    // Exactly the briefing, never the weekly health report: an empty wiki has
    // nothing to say in a health document, and the briefing costs no tokens.
    expect(body.schedules).toHaveLength(1)
    const [briefing] = body.schedules
    expect(briefing!.kind).toBe('briefing')
    expect(briefing!.at_time).toBe('07:00')
    expect(briefing!.timezone).toBe('Europe/Berlin')
    expect(briefing!.weekday).toBeNull()
    expect(briefing!.enabled).toBe(true)
    // Armed, not merely present — a seeded row with a null next_run_at is
    // invisible to the claim query and would never fire.
    expect(briefing!.next_run_at).not.toBeNull()
    expect(new Date(briefing!.next_run_at!).getTime()).toBeGreaterThan(Date.now())
    expect(briefing!.last_run_at).toBeNull()
  })

  test.skipIf(!integration)('the seed is a starting point, not a lock — an operator overwrites it', async () => {
    await fetch(`${seededBase}/v1/spaces`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ slug: 'retimed', name: 'Retimed Space' }),
    })
    const put = await fetch(`${seededBase}/v1/spaces/retimed/schedules`, {
      method: 'PUT',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({
        schedules: [{ kind: 'briefing', at_time: '18:30', weekday: null, timezone: 'UTC', enabled: true }],
      }),
    })
    expect(put.status).toBe(200)
    const body = (await put.json()) as { schedules: { at_time: string; timezone: string }[] }
    expect(body.schedules).toHaveLength(1)
    expect(body.schedules[0]!.at_time).toBe('18:30')
    expect(body.schedules[0]!.timezone).toBe('UTC')
  })
})

describe('the schedule worker (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_scheduler')
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

    const created = await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ slug: 'demo', name: 'Demo Space' }),
    })
    spaceId = ((await created.json()) as { id: string }).id
    const mint = async (name: string, scopes: string[]) => {
      const res = await fetch(`${base}/v1/api-keys`, {
        method: 'POST',
        headers: json(BOOTSTRAP),
        body: JSON.stringify({ name, scopes }),
      })
      return ((await res.json()) as { key: string }).key
    }
    adminKey = await mint('admin', ['admin'])
    writerKey = await mint('writer', ['knowledge:read', 'knowledge:propose'])

    // One change waiting for review, backdated — the fact the whole briefing
    // exists to report. A count reads the same on the day a backlog appears and
    // a month later; the AGE is what turns a queue into a backlog.
    const accepted = await fetch(`${base}/v1/spaces/demo/ingest`, {
      method: 'POST',
      headers: json(writerKey),
      body: JSON.stringify({ markdown: '# Yard rules\n\nEvery shipment is checked twice.\n', title: 'Yard rules' }),
    })
    expect(accepted.status).toBe(202)
    await app.ingest.runOnce()
    await db.query(`UPDATE wk_change_proposals SET created_at = now() - interval '21 days' WHERE space_id = $1`, [
      spaceId,
    ])

    // Two instances of the worker, each on its OWN pool — the closest a test
    // gets to two binaries pointed at one database.
    secondDatabase = createPostgres(config)
    const logger = createLogger({ level: 'error', write: () => {} })
    instanceA = createScheduler({ db, logger }, config)
    instanceB = createScheduler({ db: secondDatabase.db, logger }, config)
  })

  afterAll(async () => {
    if (!integration) return
    await secondDatabase?.close()
    await app.close()
  })

  it('a PUT arms both kinds without firing either of them', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/schedules`, {
      method: 'PUT',
      headers: json(adminKey),
      body: JSON.stringify({
        schedules: [
          { kind: 'briefing', at_time: '07:00', timezone: 'Europe/Berlin', enabled: true },
          { kind: 'health', at_time: '08:30', weekday: 1, timezone: 'Europe/Berlin', enabled: true },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const { schedules } = (await res.json()) as {
      schedules: { kind: string; weekday: number | null; next_run_at: string | null }[]
    }
    expect(schedules.map((entry) => entry.kind).sort()).toEqual(['briefing', 'health'])
    // A freshly saved schedule starts at its next real window — never
    // immediately, or saving a form at 09:00 would file a report at 09:00.
    for (const entry of schedules) expect(new Date(entry.next_run_at!).getTime()).toBeGreaterThan(Date.now())
    expect(schedules.find((entry) => entry.kind === 'briefing')!.weekday).toBeNull() // null IS daily
  })

  it('nothing is claimed while nothing is due', async () => {
    expect(await instanceA.runOnce()).toBe(false)
    expect(await instanceB.runOnce()).toBe(false)
    expect(await outputs('briefing')).toHaveLength(0)
  })

  // ------------------------------------------------------------------ the race
  it('TWO instances, one due window: exactly ONE briefing and ONE advance', async () => {
    const before = await scheduleRow('briefing')
    await makeDue('briefing')

    // Both poll at the same instant, which is what two binaries on one cron-free
    // timer actually do.
    const ran = await Promise.all([instanceA.runOnce(), instanceB.runOnce()])
    expect(ran.filter(Boolean)).toHaveLength(1)

    // The assertion the SKIP LOCKED claim exists for.
    const written = await outputs('briefing')
    expect(written).toHaveLength(1)

    const after = await scheduleRow('briefing')
    expect(after.last_run_at).not.toBeNull()
    // Advanced ONCE: a second claim would have pushed the window another day
    // out, so the row would be due the day after tomorrow and one morning would
    // silently have no briefing.
    const advance = new Date(after.next_run_at!).getTime() - Date.now()
    expect(advance).toBeGreaterThan(0)
    expect(advance).toBeLessThanOrEqual(25 * 60 * 60 * 1000)
    expect(after.next_run_at).not.toBe(before.next_run_at)
  })

  it('and neither instance runs it again on the next poll', async () => {
    expect(await instanceA.runOnce()).toBe(false)
    expect(await instanceB.runOnce()).toBe(false)
    expect(await outputs('briefing')).toHaveLength(1)
  })

  it('a second window produces a second briefing — the window advanced, it did not stop', async () => {
    await makeDue('briefing')
    const ran = await Promise.all([instanceB.runOnce(), instanceA.runOnce()])
    expect(ran.filter(Boolean)).toHaveLength(1)
    expect(await outputs('briefing')).toHaveLength(2)
  })

  it('the briefing states the AGE of the oldest waiting change, not only the count', async () => {
    // The production finding, in one document: 436 proposals, the oldest three
    // weeks old, and every surface reporting the installation as healthy.
    const [briefing] = await outputs('briefing')
    expect(briefing!.title).toMatch(/^Briefing \d{4}-\d{2}-\d{2}$/)
    expect(briefing!.markdown).toContain('1 knowledge change(s) await review.')
    expect(briefing!.markdown).toContain('21 day(s) old')
    // LLM-free by construction: a daily job that costs money is a daily job
    // somebody switches off, and the moment it is off the wiki goes quiet again.
    expect(briefing!.markdown).toContain('## What you need to decide')
  })

  // ----------------------------------------------------------------- health
  it('the health run writes its report and the push seam in ONE transaction', async () => {
    await makeDue('health')
    const ran = await Promise.all([instanceA.runOnce(), instanceB.runOnce()])
    expect(ran.filter(Boolean)).toHaveLength(1)

    const [report] = await outputs('health')
    expect(report).toBeDefined()
    expect(report!.markdown).toContain('finding(s)')

    // WikiKit sends no mail and never will — there is no SMTP in a single
    // binary — so delivery IS the Output plus this event. The outbox row exists
    // if and only if the report it announces committed, which is why they share
    // a transaction.
    const { rows } = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM wk_outbox_events WHERE space_id = $1 AND event_type = 'wikikit.health.reported'`,
      [spaceId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.output_id).toBe(report!.id)
    expect(rows[0]!.payload.space).toBe('demo')
    // The summary an alerting rule branches on — never the document, which is
    // kilobytes of markdown behind output_id.
    expect(rows[0]!.payload.pending_proposals).toBe(1)
    expect(rows[0]!.payload.oldest_pending_days).toBe(21)
    expect(rows[0]!.payload.findings).toMatchObject({ error: expect.any(Number), warn: expect.any(Number) })
  })

  it('a CLEAN scheduled health run still persists its report — an empty report is information', async () => {
    // The invariant, pinned: the report is the record that somebody looked,
    // and a run that writes a row only when it finds something turns silence
    // into ambiguity ("healthy" and "never ran" would look identical).
    const created = await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: json(BOOTSTRAP),
      body: JSON.stringify({ slug: 'pristine', name: 'Pristine Space' }),
    })
    const pristineId = ((await created.json()) as { id: string }).id
    // A current charter is the one thing a truly clean space must positively
    // hold — without it the missing-charter note is a (correct) finding.
    await db.insert('wk_charter_revisions', {
      space_id: pristineId,
      rev: 1,
      status: 'current',
      markdown: '# Charter\n\nNothing belongs here yet.',
      created_by: 'scheduler-test',
    })
    const put = await fetch(`${base}/v1/spaces/pristine/schedules`, {
      method: 'PUT',
      headers: json(adminKey),
      body: JSON.stringify({
        schedules: [{ kind: 'health', at_time: '08:30', timezone: 'Europe/Berlin', enabled: true }],
      }),
    })
    expect(put.status).toBe(200)
    await db.query(
      `UPDATE wk_schedules SET next_run_at = now() - interval '1 minute' WHERE space_id = $1 AND kind = 'health'`,
      [pristineId],
    )
    expect(await instanceA.runOnce()).toBe(true)

    const { rows } = await db.query<{ markdown: string }>(
      `SELECT markdown FROM wk_outputs WHERE space_id = $1 AND kind = 'health'`,
      [pristineId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.markdown).toContain('0 fault(s), 0 warning(s), 0 note(s) across 0 finding(s).')
  })

  it('a weekly schedule lands on its weekday, in its own zone', async () => {
    // 1 = Monday, the convention Postgres extract(dow) and getUTCDay share.
    const { next_run_at: next } = await scheduleRow('health')
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'long' }).format(
      new Date(next!),
    )
    expect(weekday).toBe('Monday')
  })

  // ---------------------------------------------------------------- disabling
  it('a disabled schedule is DISARMED, not armed-and-skipped', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/schedules`, {
      method: 'PUT',
      headers: json(adminKey),
      body: JSON.stringify({
        schedules: [{ kind: 'briefing', at_time: '07:00', timezone: 'Europe/Berlin', enabled: false }],
      }),
    })
    expect(res.status).toBe(200)
    const { schedules } = (await res.json()) as { schedules: { kind: string; next_run_at: string | null }[] }
    // A null window keeps it out of the claim query AND out of the partial
    // index — cheaper and, more to the point, impossible to fire by accident.
    expect(schedules).toHaveLength(1)
    expect(schedules[0]!.next_run_at).toBeNull()

    // The kind left OUT of the body is gone: the PUT is a replace, which is why
    // there is no DELETE route.
    const remaining = await db.query<{ kind: string }>(`SELECT kind FROM wk_schedules WHERE space_id = $1`, [spaceId])
    expect(remaining.rows.map((row) => row.kind)).toEqual(['briefing'])

    const briefingsBefore = (await outputs('briefing')).length
    expect(await instanceA.runOnce()).toBe(false)
    expect((await outputs('briefing')).length).toBe(briefingsBefore)
  })

  it('an upsert preserves last_run_at — "when did this last go out" survives a time change', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/schedules`, {
      method: 'PUT',
      headers: json(adminKey),
      body: JSON.stringify({
        schedules: [{ kind: 'briefing', at_time: '06:15', timezone: 'Pacific/Auckland', enabled: true }],
      }),
    })
    expect(res.status).toBe(200)
    const row = await scheduleRow('briefing')
    expect(row.last_run_at).not.toBeNull()
    expect(new Date(row.next_run_at!).getTime()).toBeGreaterThan(Date.now())
  })

  it('a non-admin key cannot read or write the timetable', async () => {
    // admin, because a schedule is installation configuration: it decides what
    // this server does on its own, on somebody else's clock.
    expect((await fetch(`${base}/v1/spaces/demo/schedules`, { headers: json(writerKey) })).status).toBe(403)
    const write = await fetch(`${base}/v1/spaces/demo/schedules`, {
      method: 'PUT',
      headers: json(writerKey),
      body: JSON.stringify({ schedules: [] }),
    })
    expect(write.status).toBe(403)
  })
})
