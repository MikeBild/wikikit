// Migration self-application against a real Docker Postgres.
// Gated behind RUN_INTEGRATION=1 — scripts/start-local.ts provisions the
// container (postgres:16-alpine on 127.0.0.1:55442).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import pg from 'pg'
import { EMBEDDED_MIGRATIONS } from '../../src/db/migrations/embedded.ts'
import { detectMigrationDrift, runMigrations } from '../../src/db/migrate.ts'
import { TABLES } from '../../src/db/postgres.ts'
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
    const fns = await client.query<{ proname: string; pronargs: number; pronargdefaults: number }>(
      `SELECT proname, pronargs, pronargdefaults
         FROM pg_proc JOIN pg_namespace n ON n.oid = pronamespace
        WHERE n.nspname = 'public'
          AND proname IN ('wk_apply_proposal','wk_reject_proposal','wk_search')`,
    )
    expect(fns.rows.length).toBe(3)
    for (const reviewFn of fns.rows.filter((row) => row.proname !== 'wk_search')) {
      expect(Number(reviewFn.pronargs)).toBe(4)
      expect(Number(reviewFn.pronargdefaults)).toBe(2) // v0.4 three-argument calls remain valid
    }
    const reviewChannel = await client.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'wk_change_proposals' AND column_name = 'review_channel'`,
    )
    expect(reviewChannel.rows[0]?.is_nullable).toBe('YES') // historical reviews stay unknown/null
  })

  it('0045 removes leaked test wikis and the retired environment setting', async () => {
    const cleanup = EMBEDDED_MIGRATIONS.find((migration) => migration.tag === '0045_wk_global_operator_surface')
    expect(cleanup, 'the environment cleanup migration must ship in the embedded bundle').toBeDefined()

    const kept = await client.query<{ id: string }>(
      `INSERT INTO public.wk_spaces (slug, name, settings)
       VALUES ('migration-0045-kept', 'Kept', '{"environment":"production","purpose":"keep"}'::jsonb)
       RETURNING id`,
    )
    const discarded = await client.query<{ id: string }>(
      `INSERT INTO public.wk_spaces (slug, name, settings)
       VALUES ('migration-0045-test', 'Disposable', '{"environment":"test"}'::jsonb)
       RETURNING id`,
    )
    await client.query(
      `INSERT INTO public.wk_sources (space_id, content_hash, kind, title, summary, raw_content, markdown)
       VALUES ($1::uuid, 'migration-0045-source', 'text', 'Disposable source', '', 'fixture', 'fixture')`,
      [discarded.rows[0]!.id],
    )

    // Reproduce a host that already contains rows from the retired model but
    // has not journalled the one-time cleanup yet.
    await client.query(`DELETE FROM public.wk_migrations WHERE tag = '0045_wk_global_operator_surface'`)
    const report = await runMigrations({ databaseUrl: url })
    expect(report.applied).toEqual(['0045_wk_global_operator_surface'])

    const gone = await client.query(`SELECT id FROM public.wk_spaces WHERE id = $1::uuid`, [discarded.rows[0]!.id])
    expect(gone.rows).toEqual([])
    const cascaded = await client.query(`SELECT id FROM public.wk_sources WHERE content_hash = 'migration-0045-source'`)
    expect(cascaded.rows).toEqual([])

    const retained = await client.query<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM public.wk_spaces WHERE id = $1::uuid`,
      [kept.rows[0]!.id],
    )
    expect(retained.rows[0]?.settings).toEqual({ purpose: 'keep' })
    await client.query(`DELETE FROM public.wk_spaces WHERE id = $1::uuid`, [kept.rows[0]!.id])
  })

  it('leaves exactly ONE source-search function per name, widened by defaults', async () => {
    // 0040 appends three defaulted filter parameters, which is a new signature
    // rather than a replacement — so it drops the earlier one in the same file.
    // Leaving both would not be conservative: a call with the old argument
    // count matches both candidates and Postgres answers 'function is not
    // unique' rather than choosing the older body. One function, whose
    // defaults answer the old three-argument call exactly as before.
    await runMigrations({ databaseUrl: url })
    const fns = await client.query<{ proname: string; pronargs: number; pronargdefaults: number }>(
      `SELECT proname, pronargs, pronargdefaults
         FROM pg_proc JOIN pg_namespace n ON n.oid = pronamespace
        WHERE n.nspname = 'public'
          AND proname IN ('wk_search_sources', 'wk_search_sources_hybrid')
        ORDER BY proname`,
    )
    const lexical = fns.rows.filter((row) => row.proname === 'wk_search_sources')
    expect(lexical.length).toBe(1)
    expect(Number(lexical[0]!.pronargs)).toBe(6)
    // limit + from + to + source_kind: every argument the pre-0040 caller did
    // not pass still has a default, which is what keeps that call working.
    expect(Number(lexical[0]!.pronargdefaults)).toBe(4)

    // The hybrid twin exists only where pgvector does (0018's guard, repeated
    // in 0040), so its absence is a valid schema rather than a failure.
    const hybrid = fns.rows.filter((row) => row.proname === 'wk_search_sources_hybrid')
    expect(hybrid.length).toBeLessThanOrEqual(1)
    for (const row of hybrid) {
      expect(Number(row.pronargs)).toBe(7)
      expect(Number(row.pronargdefaults)).toBe(4)
    }

    // The old call shape still resolves — the compatibility claim, made
    // against the database rather than asserted in a comment.
    const legacy = await client.query(
      `SELECT * FROM public.wk_search_sources('00000000-0000-4000-8000-000000000000'::uuid, 'anything', 5)`,
    )
    expect(legacy.rows).toEqual([])
  })

  it('is idempotent — a second run skips everything', async () => {
    const report = await runMigrations({ databaseUrl: url })
    expect(report.applied).toEqual([])
    expect(report.skipped).toBe(EMBEDDED_MIGRATIONS.length)
    expect(await detectMigrationDrift(client)).toEqual({ unknown_in_db: [], missing_in_db: [] })
  })

  it('0041 repairs a host that gained pgvector after 0018 was journalled', async () => {
    // The state this migration exists for: 0018 ran while the extension was
    // unavailable, so its guard created nothing and its tag was recorded all
    // the same. Because a recorded tag is never re-executed, only a tag the
    // journal has not seen can create those objects. Dropping them and
    // forgetting the repair tag reproduces that host exactly.
    const repair = EMBEDDED_MIGRATIONS.find((migration) => migration.tag === '0041_wk_embeddings_repair')
    expect(repair, 'the repair migration must ship in the embedded bundle').toBeDefined()

    const availability = await client.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    const pgvector = availability.rows.length > 0

    await client.query(`DROP FUNCTION IF EXISTS public.wk_search_hybrid(uuid,text,text,text,int)`)
    await client.query(
      `DROP FUNCTION IF EXISTS public.wk_search_sources_hybrid(uuid,text,text,int,timestamptz,timestamptz,text)`,
    )
    await client.query(`DROP TABLE IF EXISTS public.wk_embeddings`)
    await client.query(`DELETE FROM public.wk_migrations WHERE tag = '0041_wk_embeddings_repair'`)

    const report = await runMigrations({ databaseUrl: url })
    expect(report.applied).toEqual(['0041_wk_embeddings_repair'])

    const shape = async () => {
      const fns = await client.query<{ proname: string; pronargs: number }>(
        `SELECT proname, pronargs
           FROM pg_proc JOIN pg_namespace n ON n.oid = pronamespace
          WHERE n.nspname = 'public' AND proname IN ('wk_search_hybrid', 'wk_search_sources_hybrid')
          ORDER BY proname`,
      )
      const indexes = await client.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'wk_embeddings'`)
      return { fns: fns.rows, indexes: indexes.rows.length }
    }

    const repaired = await shape()
    if (!pgvector) {
      // Without the extension the file is a clean no-op — it is journalled as
      // applied and the schema is unchanged, which is a valid schema.
      expect(repaired.fns).toEqual([])
      expect(repaired.indexes).toBe(0)
      return
    }

    // Exactly one of each function, and the source twin at SEVEN arguments:
    // replaying 0018's four-argument body instead of 0040's would leave a
    // signature src/db/postgres.ts no longer calls, breaking every
    // approved_then_sources search.
    expect(repaired.fns.map((row) => row.proname)).toEqual(['wk_search_hybrid', 'wk_search_sources_hybrid'])
    expect(Number(repaired.fns[0]!.pronargs)).toBe(5)
    expect(Number(repaired.fns[1]!.pronargs)).toBe(7)
    expect(repaired.indexes).toBe(4) // pkey + unique + hnsw + space

    // Idempotent: the repair also runs on a host that already has everything,
    // which is every host that had pgvector before 0018 ran. Replayed
    // statement-for-statement it must add nothing and duplicate nothing.
    for (const statement of repair!.statements) await client.query(statement)
    expect(await shape()).toEqual(repaired)
  })

  it('the query layer knows exactly the tables the migrations made', async () => {
    // TABLES in src/db/postgres.ts is hand-written, and this is the only thing
    // that holds it to reality. assertKnownWkIdentifiers scans the text of
    // every raw query() and throws on any wk_ identifier the set does not
    // contain — so a migration that adds a table without touching TABLES
    // typechecks, ships, and throws the first time a request reaches the new
    // table, in production, with nothing having gone red on the way.
    //
    // It lives here rather than in test/unit/ because a unit test has no schema
    // to compare against: it could only carry a SECOND hand-written list of
    // tables, which is the same unverified artefact one layer up and stays
    // green on the day both lists are wrong together. The schema this database
    // holds after the migrations above is the only second opinion there is.
    //
    // Migrated here rather than leaning on the first test: runMigrations is
    // idempotent, and a comparison against a schema that only exists if some
    // earlier `it` happened to run is a comparison that passes vacuously the
    // moment somebody runs this one alone with `-t`.
    await runMigrations({ databaseUrl: url })
    const rows = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'wk\\_%'`,
    )
    // wk_migrations is absent from TABLES by design — migrate.ts owns the
    // journal on its own client, before the app layer exists — so it is the one
    // name this comparison drops rather than a hole in it.
    const inSchema = rows.rows.map((row) => row.table_name).filter((name) => name !== 'wk_migrations')
    expect(inSchema.length).toBeGreaterThan(0)

    const missing = inSchema.filter((name) => !TABLES.has(name)).sort()
    expect(
      missing,
      `in the schema, missing from TABLES (src/db/postgres.ts): ${missing.join(', ')} — every query() naming one of these throws at runtime; add them to TABLES`,
    ).toEqual([])

    const present = new Set(inSchema)
    const stale = [...TABLES].filter((name) => !present.has(name)).sort()
    expect(
      stale,
      `in TABLES (src/db/postgres.ts), no such table: ${stale.join(', ')} — a stale entry silently admits a mistyped identifier into raw SQL; remove them from TABLES`,
    ).toEqual([])
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
