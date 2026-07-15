// search.ts — the LLM-free retrieval wrapper over the wk_search RPC.
// Asserted here: boundary validation happens before any SQL, the call goes
// through the pinned db.call('wk_search') statement (never raw SQL), defaults
// mirror the MCP tool schema (limit 20), and rows map column-for-column to
// the SearchHit wire shape shared by REST and wikikit_search.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { search } from '../../src/query/search.ts'

interface Call {
  sql: string
  values: unknown[]
}

function fakeDb(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = []
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    return { rows, rowCount: rows.length }
  }
  const pool: PoolLike = { query, connect: async () => ({ query, release() {} }), end: async () => {} }
  const { db } = createPostgres({ databaseUrl: 'postgresql://stub' } as Config, { pool })
  return { db, calls }
}

const SPACE = 'a4b0c9d8-0000-4000-8000-000000000001'

describe('search', () => {
  test('goes through the whitelisted wk_search RPC with the documented defaults', async () => {
    const { db, calls } = fakeDb()
    await search(db, SPACE, { q: 'okf' })
    expect(calls.length).toBe(1)
    // The pinned statement from the FUNCTIONS registry — search must never
    // hand-write FTS SQL of its own (visibility rules live in the function).
    expect(calls[0]!.sql).toContain('FROM public.wk_search($1, $2, $3, $4)')
    // kind omitted → NULL (both kinds); limit omitted → 20, NOT null (LIMIT
    // NULL would disable the cap).
    expect(calls[0]!.values).toEqual([SPACE, 'okf', null, 20])
  })

  test('passes kind and limit through when given', async () => {
    const { db, calls } = fakeDb()
    await search(db, SPACE, { q: 'okf', kind: 'claim', limit: 5 })
    expect(calls[0]!.values).toEqual([SPACE, 'okf', 'claim', 5])
  })

  test('maps SQL columns to the SearchHit wire shape (concept_slug → slug)', async () => {
    const { db } = fakeDb([
      {
        kind: 'concept',
        concept_slug: 'okf',
        claim_id: null,
        title: 'OKF',
        headline: '<mark>OKF</mark> spec',
        rank: 0.61,
      },
      {
        kind: 'claim',
        concept_slug: 'okf',
        claim_id: 'claim-1',
        title: 'OKF',
        headline: 'okf is <mark>draft</mark>',
        rank: 0.4,
      },
    ])
    const hits = await search(db, SPACE, { q: 'okf' })
    expect(hits).toEqual([
      { kind: 'concept', slug: 'okf', claim_id: null, title: 'OKF', headline: '<mark>OKF</mark> spec', rank: 0.61 },
      {
        kind: 'claim',
        slug: 'okf',
        claim_id: 'claim-1',
        title: 'OKF',
        headline: 'okf is <mark>draft</mark>',
        rank: 0.4,
      },
    ])
  })

  test('coerces string ranks (exotic drivers) to numbers', async () => {
    const { db } = fakeDb([
      { kind: 'concept', concept_slug: 'a', claim_id: null, title: 'A', headline: 'h', rank: '0.25' },
    ])
    const [hit] = await search(db, SPACE, { q: 'a' })
    expect(hit!.rank).toBe(0.25)
    expect(typeof hit!.rank).toBe('number')
  })

  test('rejects invalid args before any SQL (zod at the boundary)', async () => {
    const { db, calls } = fakeDb()
    await expect(search(db, SPACE, { q: '' })).rejects.toThrow()
    await expect(search(db, SPACE, { q: 'x', limit: 0 })).rejects.toThrow()
    await expect(search(db, SPACE, { q: 'x', limit: 51 })).rejects.toThrow()
    await expect(search(db, SPACE, { q: 'x', kind: 'bogus' as never })).rejects.toThrow()
    expect(calls.length).toBe(0)
  })

  test('returns an empty array for no hits (never null)', async () => {
    const { db } = fakeDb([])
    expect(await search(db, SPACE, { q: 'nothing' })).toEqual([])
  })
})
