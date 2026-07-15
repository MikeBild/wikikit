// Embedded-migration drift gate (ContentKit check:embedded-drift pattern).
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
})
