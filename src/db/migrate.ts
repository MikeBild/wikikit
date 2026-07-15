// Advisory-lock self-migration — the ContentKit migrate.mjs pattern ported to
// TypeScript. The binary migrates itself at boot (and via --migrate); deploy
// scripts never run app SQL.
//
// WHY an advisory lock: two systemd instances (deploy overlap, or a crashed
// unit restarting while the new binary boots) must never both decide a
// migration is pending. pg_advisory_lock(hashtext('wikikit_migrations')) is a
// cluster-wide mutex every WikiKit binary agrees on; the loser simply waits,
// then sees everything already applied and skips.
//
// WHY tag + hash: the tag (file name) is the authoritative identity of a
// migration; the sha256 of its SQL detects drift. Same tag with a different
// hash means the committed SQL changed after it was applied — the journal is
// backfilled with the new hash (comment-only edits never re-execute DDL) and
// a warning is logged so a REAL semantic edit is visible in ops logs instead
// of silently diverging.
import pg from 'pg'
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from './migrations/embedded.ts'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'

const { Pool } = pg

// hashtext() keys the lock off a stable string instead of a magic number, so
// the key survives copy-paste into psql during incident response.
export const MIGRATION_LOCK_SQL = "SELECT pg_advisory_lock(hashtext('wikikit_migrations'))"
export const MIGRATION_UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('wikikit_migrations'))"

export interface MigrationReport {
  /** Tags applied by THIS run, in order. */
  applied: string[]
  /** Tags already present (or hash-adopted) and therefore skipped. */
  skipped: number
  /** Tags whose recorded hash was updated without re-running SQL. */
  hash_drift_backfilled?: number
}

interface ClientLike {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

async function ensureMigrationsTable(client: ClientLike): Promise<void> {
  // pgcrypto before anything else: gen_random_uuid() defaults appear in the
  // very first CREATE TABLE of the baseline.
  await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')
  await client.query(`
    CREATE TABLE IF NOT EXISTS "public"."wk_migrations" (
      tag text PRIMARY KEY,
      hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

async function appliedState(client: ClientLike): Promise<{ hashByTag: Map<string, string> }> {
  const result = await client.query('SELECT tag, hash FROM "public"."wk_migrations"')
  return {
    hashByTag: new Map(result.rows.map((row) => [String(row.tag), String(row.hash)])),
  }
}

/**
 * Applies an embedded migration set on a connection that already owns the
 * advisory lock. Each pending migration runs inside its own transaction with
 * its journal insert, so a mid-migration failure leaves the previous
 * migrations durable and the failed one fully rolled back (zero rows).
 */
export async function applyMigrations(
  client: ClientLike,
  migrations: EmbeddedMigration[] = EMBEDDED_MIGRATIONS,
  logger?: Logger,
): Promise<MigrationReport> {
  await ensureMigrationsTable(client)
  const { hashByTag } = await appliedState(client)
  const report: Required<MigrationReport> = { applied: [], skipped: 0, hash_drift_backfilled: 0 }

  for (const migration of migrations) {
    const recorded = hashByTag.get(migration.tag)
    if (recorded !== undefined) {
      if (recorded === migration.hash) {
        report.skipped++
      } else {
        await client.query('UPDATE "public"."wk_migrations" SET hash = $1 WHERE tag = $2', [
          migration.hash,
          migration.tag,
        ])
        report.hash_drift_backfilled++
        logger?.warn('migration hash drift backfilled', { tag: migration.tag, hash: migration.hash })
      }
      continue
    }

    const started = Date.now()
    await client.query('BEGIN')
    try {
      for (const statement of migration.statements) await client.query(statement)
      await client.query('INSERT INTO "public"."wk_migrations" (tag, hash) VALUES ($1, $2)', [
        migration.tag,
        migration.hash,
      ])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
    report.applied.push(migration.tag)
    logger?.info('migration applied', {
      tag: migration.tag,
      statements: migration.statements.length,
      ms: Date.now() - started,
    })
  }
  return report
}

/**
 * Journal ↔ bundle drift inspection (ops diagnostic, also used at boot for a
 * loud warning). unknown_in_db = journal rows this binary does not know
 * (older binary against a newer database — usually fine, never auto-fixed);
 * missing_in_db = embedded migrations not yet applied.
 */
export async function detectMigrationDrift(
  client: ClientLike,
  migrations: EmbeddedMigration[] = EMBEDDED_MIGRATIONS,
): Promise<{ unknown_in_db: { tag: string; hash: string }[]; missing_in_db: { tag: string; hash: string }[] }> {
  await ensureMigrationsTable(client)
  const result = await client.query('SELECT tag, hash FROM "public"."wk_migrations" ORDER BY applied_at, tag')
  const embeddedTags = new Set(migrations.map((migration) => migration.tag))
  const dbTags = new Set(result.rows.map((row) => String(row.tag)))
  return {
    unknown_in_db: result.rows
      .filter((row) => !embeddedTags.has(String(row.tag)))
      .map((row) => ({ tag: String(row.tag), hash: String(row.hash) })),
    missing_in_db: migrations.filter((migration) => !dbTags.has(migration.tag)).map(({ tag, hash }) => ({ tag, hash })),
  }
}

export async function runMigrationsWithPool(
  pool: { connect(): Promise<pg.PoolClient> },
  logger?: Logger,
  migrations: EmbeddedMigration[] = EMBEDDED_MIGRATIONS,
): Promise<MigrationReport> {
  const lockClient = await pool.connect()
  try {
    await lockClient.query(MIGRATION_LOCK_SQL)
    logger?.info('applying embedded migrations', { total: migrations.length })
    const report = await applyMigrations(lockClient, migrations, logger)
    const drift = await detectMigrationDrift(lockClient, migrations)
    if (drift.unknown_in_db.length) {
      logger?.warn('migration lineage drift detected', { unknown: drift.unknown_in_db })
    }
    logger?.info('embedded migrations complete', {
      applied: report.applied.length,
      skipped: report.skipped,
      hash_drift_backfilled: report.hash_drift_backfilled ?? 0,
    })
    return report
  } finally {
    await lockClient.query(MIGRATION_UNLOCK_SQL).catch(() => {})
    lockClient.release()
  }
}

export async function runMigrations(
  config: Pick<Config, 'databaseUrl'>,
  logger?: Logger,
  migrations: EmbeddedMigration[] = EMBEDDED_MIGRATIONS,
): Promise<MigrationReport> {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required for embedded migrations')
  // A tiny dedicated pool: migration is a boot-time, single-connection affair;
  // the app pool is created afterwards by createPostgres.
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 })
  pool.on('error', (error) => logger?.error('migration pool error', { error: String(error) }))
  try {
    return await runMigrationsWithPool(pool, logger, migrations)
  } finally {
    await pool.end()
  }
}

export function listEmbeddedMigrations(): EmbeddedMigration[] {
  return EMBEDDED_MIGRATIONS
}
