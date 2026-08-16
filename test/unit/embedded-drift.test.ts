// Embedded-migration drift gate.
// The compiled binary only ever sees embedded.ts — if a .sql file or the
// journal changes without re-running scripts/gen-embedded-migrations.ts, the
// binary would silently ship stale DDL. This test makes that a CI failure.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMBEDDED_JOURNAL, EMBEDDED_MIGRATIONS } from '../../src/db/migrations/embedded.ts'

const migrationsDir = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src', 'db', 'migrations')
const journalPath = join(migrationsDir, 'meta', '_journal.json')

describe('embedded migrations drift', () => {
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as typeof EMBEDDED_JOURNAL

  test('embedded journal matches meta/_journal.json exactly', () => {
    expect(EMBEDDED_JOURNAL).toEqual(journal)
  })

  test('journal entries are contiguous, ordered and uniquely tagged', () => {
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx)
    entries.forEach((entry, index) => expect(entry.idx).toBe(index))
    expect(new Set(entries.map((entry) => entry.tag)).size).toBe(entries.length)
  })

  test('every journal entry is embedded with the exact on-disk SQL and hash', () => {
    expect(EMBEDDED_MIGRATIONS.map((migration) => migration.tag)).toEqual(
      [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => entry.tag),
    )
    for (const migration of EMBEDDED_MIGRATIONS) {
      const sql = readFileSync(join(migrationsDir, `${migration.tag}.sql`), 'utf8')
      expect(migration.sql).toBe(sql)
      expect(migration.hash).toBe(createHash('sha256').update(sql).digest('hex'))
      // Statement splitting contract: '--> statement-breakpoint' markers only.
      const statements = sql
        .split('--> statement-breakpoint')
        .map((value) => value.trim())
        .filter(Boolean)
      expect(migration.statements).toEqual(statements)
      expect(migration.statements.length).toBeGreaterThan(0)
    }
  })

  test('no orphan .sql files outside the journal', () => {
    const tagged = new Set(journal.entries.map((entry) => entry.tag))
    const onDisk = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.replace(/\.sql$/, ''))
    for (const tag of onDisk) expect(tagged.has(tag)).toBe(true)
  })

  test('baseline carries the review functions; 0001 carries search — the schema contract anchors', () => {
    const baseline = EMBEDDED_MIGRATIONS.find((migration) => migration.tag === '0000_wk_baseline')!
    expect(baseline.sql).toContain('create or replace function public.wk_apply_proposal')
    expect(baseline.sql).toContain('create or replace function public.wk_reject_proposal')
    const search = EMBEDDED_MIGRATIONS.find((migration) => migration.tag === '0001_wk_search')!
    expect(search.sql).toContain('create or replace function public.wk_search(')
  })

  test('the pgvector repair ships guarded and idempotent — checkable without a database', () => {
    // 0041 exists because a recorded tag is never re-executed, so a host that
    // ran 0018 without pgvector can never get those objects from 0018. Two
    // properties make shipping it safe everywhere, and both are textual: it
    // no-ops where the extension is unavailable, and it can run on a host that
    // already has every object.
    const repair = EMBEDDED_MIGRATIONS.find((migration) => migration.tag === '0041_wk_embeddings_repair')!
    expect(repair, 'the repair migration must be journalled and embedded').toBeDefined()
    expect(repair.sql).toContain("pg_available_extensions where name = 'vector'")
    expect(repair.sql).toContain('create extension if not exists vector')
    expect(repair.sql).toContain('create table if not exists public.wk_embeddings')
    expect(repair.sql).toContain('create index if not exists wk_embeddings_hnsw_idx')
    expect(repair.sql).toContain('create index if not exists wk_embeddings_space_idx')
    expect(repair.sql).toContain('create or replace function public.wk_search_hybrid(')
    expect(repair.sql).toContain('create or replace function public.wk_search_sources_hybrid(')

    // The source twin must be 0040's SEVEN-argument body, never 0018's four:
    // src/db/postgres.ts pins the wider call, so a repair carrying the narrow
    // signature would break every approved_then_sources search.
    const sourcesHybrid = repair.sql.slice(
      repair.sql.indexOf('create or replace function public.wk_search_sources_hybrid('),
    )
    expect(sourcesHybrid).toContain('p_source_kind text default null')
    const live = EMBEDDED_MIGRATIONS.find((migration) => migration.tag === '0040_wk_search_sources_filters')!
    const bodyOf = (sql: string) => sql.slice(sql.indexOf('as $body$'), sql.lastIndexOf('$body$'))
    expect(bodyOf(sourcesHybrid)).toBe(bodyOf(live.sql.slice(live.sql.indexOf('wk_search_sources_hybrid('))))
  })
})
