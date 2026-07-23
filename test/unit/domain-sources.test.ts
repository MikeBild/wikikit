// sources domain — content-hash idempotency and keyset paging against a
// routing fake pool (no network, no Postgres). The SQL SHAPES are asserted
// because they carry the security contract: every statement filters by
// space_id.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { NotFoundError, ValidationError } from '../../src/domain/errors.ts'
import {
  createSource,
  decodeCursor,
  encodeCursor,
  getSource,
  listSources,
  persistSourceChunks,
  resolveChunkCitation,
  sha256Hex,
} from '../../src/domain/sources.ts'

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

const sourceRow = (id: string, hash = 'h') => ({
  id,
  kind: 'markdown',
  url: null,
  title: 'T',
  content_hash: hash,
  raw_content: '# raw',
  markdown: '# raw',
  metadata: {},
  created_at: new Date('2026-07-01T10:00:00Z'),
})

describe('sha256Hex', () => {
  test('matches the known sha256 test vector', () => {
    expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('createSource — sha256 idempotency', () => {
  const args = { kind: 'markdown' as const, raw: '# raw', markdown: '# raw' }

  test('hash hit returns the existing row with created=false and never inserts', async () => {
    const { db, calls } = fakeDb([{ match: /SELECT \* FROM "public"\."wk_sources"/, rows: [sourceRow('src-1')] }])
    const result = await createSource(db, 'space-1', args)
    expect(result.created).toBe(false)
    expect(result.source.id).toBe('src-1')
    expect(result.source.created_at).toBe('2026-07-01T10:00:00.000Z')
    expect(calls.some((call) => call.sql.startsWith('INSERT'))).toBe(false)
    // Space scoping: the dedup lookup filters by space_id AND content_hash.
    expect(calls[0]!.sql).toContain('"space_id" = $1')
    expect(calls[0]!.values[0]).toBe('space-1')
    expect(calls[0]!.values[1]).toBe(sha256Hex('# raw'))
  })

  test('fresh content inserts with the computed content_hash and created=true', async () => {
    const { db, calls } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_sources"/, rows: [] },
      { match: /INSERT INTO "public"\."wk_sources"/, rows: [sourceRow('src-2', sha256Hex('# raw'))] },
    ])
    const result = await createSource(db, 'space-1', args)
    expect(result.created).toBe(true)
    const insert = calls.find((call) => call.sql.startsWith('INSERT'))!
    expect(insert.values).toContain(sha256Hex('# raw'))
    expect(insert.values).toContain('space-1')
  })

  test('insert race (23505) converges on the winner row with created=false', async () => {
    const { db } = fakeDb([
      // First dedup lookup misses; the post-conflict re-select hits.
      {
        match: /SELECT \* FROM "public"\."wk_sources"/,
        rows: (_values, call) => (call === 1 ? [] : [sourceRow('src-winner')]),
      },
      { match: /INSERT INTO "public"\."wk_sources"/, error: Object.assign(new Error('duplicate'), { code: '23505' }) },
    ])
    const result = await createSource(db, 'space-1', args)
    expect(result).toMatchObject({ created: false, source: { id: 'src-winner' } })
  })

  test('non-unique-violation insert errors are rethrown', async () => {
    const { db } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_sources"/, rows: [] },
      { match: /INSERT INTO "public"\."wk_sources"/, error: Object.assign(new Error('boom'), { code: '57014' }) },
    ])
    await expect(createSource(db, 'space-1', args)).rejects.toThrow('boom')
  })

  test('invalid args are rejected before any SQL (zod boundary)', async () => {
    const { db, calls } = fakeDb([])
    await expect(createSource(db, 'space-1', { kind: 'markdown', raw: '', markdown: '' })).rejects.toThrow()
    expect(calls.length).toBe(0)
  })
})

describe('listSources — keyset pagination', () => {
  test('over-fetches by one and emits next_before only when more rows exist', async () => {
    const rows = [sourceRow('a'), sourceRow('b'), sourceRow('c')]
    const { db, calls } = fakeDb([{ match: /FROM wk_sources/, rows }])
    const page = await listSources(db, 'space-1', { limit: 2 })
    expect(page.items.map((item) => item.id)).toEqual(['a', 'b'])
    // Cursor carries ONLY the boundary row id — its created_at is re-read in
    // SQL so JS millisecond Dates can never truncate the microsecond keyset.
    expect(page.next_before).toBe(encodeCursor('b'))
    expect(calls[0]!.sql).toContain('WHERE space_id = $1')
    expect(calls[0]!.values).toEqual(['space-1', 3]) // limit + 1
  })

  test('last page has next_before null', async () => {
    const { db } = fakeDb([{ match: /FROM wk_sources/, rows: [sourceRow('a')] }])
    const page = await listSources(db, 'space-1', { limit: 2 })
    expect(page.next_before).toBeNull()
  })

  test('before cursor decodes into an id-only keyset that re-reads the boundary timestamp in SQL', async () => {
    const { db, calls } = fakeDb([{ match: /FROM wk_sources/, rows: [] }])
    await listSources(db, 'space-1', { limit: 10, before: encodeCursor('b') })
    // Row-value comparison against a subselect: comparing against a JS-parsed
    // Date would truncate microseconds and silently skip same-millisecond
    // rows (burst inserts) — the boundary row's own timestamp is authoritative.
    expect(calls[0]!.sql).toContain('(created_at, id) < (SELECT created_at, id FROM wk_sources WHERE id = $2::uuid)')
    expect(calls[0]!.values).toEqual(['space-1', 'b', 11])
  })

  test('garbage cursor is a ValidationError, not SQL', async () => {
    const { db, calls } = fakeDb([])
    await expect(listSources(db, 'space-1', { before: '!!!' })).rejects.toBeInstanceOf(ValidationError)
    expect(calls.length).toBe(0)
  })

  test('cursor round-trip', () => {
    expect(decodeCursor(encodeCursor('x', 'y'), 2)).toEqual(['x', 'y'])
    expect(() => decodeCursor(encodeCursor('x'), 2)).toThrow(ValidationError)
  })
})

describe('getSource', () => {
  test('is space-scoped and 404s on a miss', async () => {
    const { db, calls } = fakeDb([{ match: /SELECT \* FROM "public"\."wk_sources"/, rows: [] }])
    await expect(getSource(db, 'space-1', { id: 'src-1' })).rejects.toBeInstanceOf(NotFoundError)
    expect(calls[0]!.sql).toContain('"space_id" = $2')
    expect(calls[0]!.values).toEqual(['src-1', 'space-1', 1])
  })
})

describe('persistSourceChunks', () => {
  const source = { id: 'src-1', markdown: '# Title\n\nIntro.\n\n## A\n\nBody A.' }

  test('inserts one row per retrieval chunk with sequential indexes', async () => {
    const { db, calls } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_source_chunks"/, rows: [] },
      { match: /INSERT INTO "public"\."wk_source_chunks"/, rows: [] },
    ])
    const written = await persistSourceChunks(db, 'space-1', source)
    expect(written).toBe(2)
    const insert = calls.find((call) => call.sql.includes('INSERT INTO "public"."wk_source_chunks"'))!
    // Plain insert, no ON CONFLICT DO UPDATE: the INSERT-only trigger owns
    // search_vector; races converge via the 23505 catch instead.
    expect(insert.sql).not.toContain('ON CONFLICT')
    expect(insert.values).toContain('# Title')
    expect(insert.values).toContain('## A')
  })

  test('a chunk-insert race (23505) converges silently', async () => {
    const { db } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_source_chunks"/, rows: [] },
      {
        match: /INSERT INTO "public"\."wk_source_chunks"/,
        error: Object.assign(new Error('duplicate'), { code: '23505' }),
      },
    ])
    expect(await persistSourceChunks(db, 'space-1', source)).toBe(0)
  })

  test('no-ops when chunks already exist (reuse/backfill path)', async () => {
    const { db, calls } = fakeDb([{ match: /SELECT \* FROM "public"\."wk_source_chunks"/, rows: [{ id: 'chunk-1' }] }])
    expect(await persistSourceChunks(db, 'space-1', source)).toBe(0)
    expect(calls.some((call) => call.sql.includes('INSERT'))).toBe(false)
  })
})

describe('resolveChunkCitation', () => {
  test('resolves a chunk to its canonical source_id + verbatim quote', async () => {
    const { db, calls } = fakeDb([
      {
        match: /SELECT \* FROM "public"\."wk_source_chunks"/,
        rows: [{ source_id: 'src-9', content: '## Rollout\n\nPostponed to Q3.' }],
      },
    ])
    const resolved = await resolveChunkCitation(db, 'space-1', 'chunk-9')
    expect(resolved).toEqual({ source_id: 'src-9', quote: '## Rollout\n\nPostponed to Q3.' })
    // Space-scoped lookup — a foreign chunk can never resolve.
    expect(calls[0]!.values).toContain('space-1')
    expect(calls[0]!.values).toContain('chunk-9')
  })

  test('404s an unknown or foreign chunk id', async () => {
    const { db } = fakeDb([{ match: /SELECT \* FROM "public"\."wk_source_chunks"/, rows: [] }])
    await expect(resolveChunkCitation(db, 'space-1', 'ghost')).rejects.toBeInstanceOf(NotFoundError)
  })
})
