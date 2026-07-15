// Migration self-application against a real Docker Postgres.
// Gated behind RUN_INTEGRATION=1 — scripts/start-local.ts provisions the
// container (postgres:16-alpine on 127.0.0.1:55442).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import pg from 'pg'
import { EMBEDDED_MIGRATIONS } from '../../src/db/migrations/embedded.ts'
import { detectMigrationDrift, runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

describe('migrations (integration)', () => {
  let url = ''
  let client: pg.Client

  beforeAll(async () => {
    if (!integration) return
    url = await provisionIntegrationDatabase('wikikit_test_migrations')
    client = new pg.Client({ connectionString: url })
    await client.connect()
  })

  afterAll(async () => {
    if (!integration) return
    await client.end().catch(() => {})
  })

  it('applies all embedded migrations on a fresh database', async () => {
    const report = await runMigrations({ databaseUrl: url })
    expect(report.applied).toEqual(EMBEDDED_MIGRATIONS.map((migration) => migration.tag))
    expect(report.skipped).toBe(0)

    // Schema smoke: core tables and both review functions exist.
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'wk\\_%'`,
    )
    const names = tables.rows.map((row) => row.table_name as string)
    for (const expected of ['wk_spaces', 'wk_concept_revisions', 'wk_change_proposals', 'wk_outbox_events']) {
      expect(names).toContain(expected)
    }
    const fns = await client.query(
      `SELECT proname FROM pg_proc JOIN pg_namespace n ON n.oid = pronamespace WHERE n.nspname = 'public' AND proname IN ('wk_apply_proposal','wk_reject_proposal','wk_search')`,
    )
    expect(fns.rows.length).toBe(3)
  })

  it('is idempotent — a second run skips everything', async () => {
    const report = await runMigrations({ databaseUrl: url })
    expect(report.applied).toEqual([])
    expect(report.skipped).toBe(EMBEDDED_MIGRATIONS.length)
    expect(await detectMigrationDrift(client)).toEqual({ unknown_in_db: [], missing_in_db: [] })
  })

  it('serializes concurrent migrators under the advisory lock — applied exactly once', async () => {
    const freshUrl = await provisionIntegrationDatabase('wikikit_test_migrations_race')
    // Four binaries booting at once (deploy overlap): all must succeed, and
    // the sum of applied tags across racers must be exactly one full set.
    const reports = await Promise.all(Array.from({ length: 4 }, () => runMigrations({ databaseUrl: freshUrl })))
    const totalApplied = reports.flatMap((report) => report.applied)
    expect(totalApplied.sort()).toEqual(EMBEDDED_MIGRATIONS.map((migration) => migration.tag).sort())
    for (const report of reports) {
      expect(report.applied.length + report.skipped).toBe(EMBEDDED_MIGRATIONS.length)
    }

    const raceClient = new pg.Client({ connectionString: freshUrl })
    await raceClient.connect()
    try {
      const journal = await raceClient.query('SELECT tag FROM public.wk_migrations ORDER BY tag')
      expect(journal.rows.map((row) => row.tag)).toEqual(EMBEDDED_MIGRATIONS.map((migration) => migration.tag).sort())
    } finally {
      await raceClient.end()
    }
  })

  it('backfills hash drift without re-running SQL', async () => {
    await client.query(`UPDATE public.wk_migrations SET hash = 'tampered' WHERE tag = '0001_wk_search'`)
    const report = await runMigrations({ databaseUrl: url })
    expect(report.applied).toEqual([])
    expect(report.hash_drift_backfilled).toBe(1)
    const row = await client.query(`SELECT hash FROM public.wk_migrations WHERE tag = '0001_wk_search'`)
    expect(row.rows[0]!.hash).toBe(EMBEDDED_MIGRATIONS.find((m) => m.tag === '0001_wk_search')!.hash)
  })
})
