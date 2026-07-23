// search.ts — the LLM-free retrieval wrapper over the wk_search RPCs.
// Asserted here: boundary validation happens before any SQL, the calls go
// through the pinned db.call statements (never raw SQL), defaults mirror the
// MCP tool schema (limit 20, mode approved_only), rows map column-for-column
// to the SearchHit wire shape shared by REST and wikikit_search, and the
// source-evidence tier is appended strictly AFTER approved hits.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { search } from '../../src/query/search.ts'

interface Call {
  sql: string
  values: unknown[]
}

function fakeDb(routes: { match: string; rows: Record<string, unknown>[] }[] = []) {
  const calls: Call[] = []
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    const route = routes.find((entry) => sql.includes(entry.match))
    return { rows: route?.rows ?? [], rowCount: route?.rows.length ?? 0 }
  }
  const pool: PoolLike = { query, connect: async () => ({ query, release() {} }), end: async () => {} }
  const { db } = createPostgres({ databaseUrl: 'postgresql://stub' } as Config, { pool })
  return { db, calls }
}

const SPACE = 'a4b0c9d8-0000-4000-8000-000000000001'

const CONCEPT_ROW = {
  kind: 'concept',
  concept_slug: 'okf',
  claim_id: null,
  title: 'OKF',
  headline: '<mark>OKF</mark> spec',
  rank: 0.61,
}

const CHUNK_ROW = {
  source_id: 'b1b0c9d8-0000-4000-8000-000000000002',
  chunk_id: 'c2b0c9d8-0000-4000-8000-000000000003',
  chunk_index: 0,
  title: 'Meeting notes',
  url: null,
  heading: '## Rollout',
  headline: 'rollout <mark>postponed</mark>',
  rank: 0.9,
}

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

  test('approved_only (default) never touches wk_search_sources', async () => {
    const { db, calls } = fakeDb()
    await search(db, SPACE, { q: 'okf' })
    expect(calls.some((call) => call.sql.includes('wk_search_sources'))).toBe(false)
  })

  test('maps SQL columns to the SearchHit wire shape (concept_slug → slug, tier labeled)', async () => {
    const { db } = fakeDb([
      {
        match: 'wk_search($1',
        rows: [
          CONCEPT_ROW,
          {
            kind: 'claim',
            concept_slug: 'okf',
            claim_id: 'claim-1',
            title: 'OKF',
            headline: 'okf is <mark>draft</mark>',
            rank: 0.4,
          },
        ],
      },
    ])
    const hits = await search(db, SPACE, { q: 'okf' })
    expect(hits).toEqual([
      {
        kind: 'concept',
        tier: 'approved',
        slug: 'okf',
        claim_id: null,
        title: 'OKF',
        headline: '<mark>OKF</mark> spec',
        rank: 0.61,
        source_id: null,
        chunk_id: null,
        url: null,
        heading: null,
      },
      {
        kind: 'claim',
        tier: 'approved',
        slug: 'okf',
        claim_id: 'claim-1',
        title: 'OKF',
        headline: 'okf is <mark>draft</mark>',
        rank: 0.4,
        source_id: null,
        chunk_id: null,
        url: null,
        heading: null,
      },
    ])
  })

  test('approved_then_sources appends source_evidence hits AFTER approved hits — never interleaved', async () => {
    // The chunk outranks the concept (0.9 > 0.61) but must still come second:
    // ts_rank values across corpora are not comparable, tier order is the contract.
    const { db, calls } = fakeDb([
      { match: 'wk_search($1', rows: [CONCEPT_ROW] },
      { match: 'wk_search_sources($1', rows: [CHUNK_ROW] },
    ])
    const hits = await search(db, SPACE, { q: 'okf', mode: 'approved_then_sources', limit: 7 })
    expect(calls[1]!.sql).toContain('FROM public.wk_search_sources($1, $2, $3)')
    expect(calls[1]!.values).toEqual([SPACE, 'okf', 7])
    expect(hits.map((hit) => hit.tier)).toEqual(['approved', 'source_evidence'])
    expect(hits[1]).toEqual({
      kind: 'source_chunk',
      tier: 'source_evidence',
      slug: null,
      claim_id: null,
      title: 'Meeting notes',
      headline: 'rollout <mark>postponed</mark>',
      rank: 0.9,
      source_id: CHUNK_ROW.source_id,
      chunk_id: CHUNK_ROW.chunk_id,
      url: null,
      heading: '## Rollout',
    })
  })

  test('a kind filter suppresses the source tier (kinds name the approved shapes)', async () => {
    const { db, calls } = fakeDb([{ match: 'wk_search($1', rows: [] }])
    await search(db, SPACE, { q: 'okf', kind: 'concept', mode: 'approved_then_sources' })
    expect(calls.some((call) => call.sql.includes('wk_search_sources'))).toBe(false)
  })

  test('a source-titleless chunk falls back to heading, then a placeholder title', async () => {
    const { db } = fakeDb([
      { match: 'wk_search($1', rows: [] },
      { match: 'wk_search_sources($1', rows: [{ ...CHUNK_ROW, title: null }] },
    ])
    const [hit] = await search(db, SPACE, { q: 'okf', mode: 'approved_then_sources' })
    expect(hit!.title).toBe('## Rollout')
  })

  test('coerces string ranks (exotic drivers) to numbers', async () => {
    const { db } = fakeDb([
      {
        match: 'wk_search($1',
        rows: [{ kind: 'concept', concept_slug: 'a', claim_id: null, title: 'A', headline: 'h', rank: '0.25' }],
      },
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
    await expect(search(db, SPACE, { q: 'x', mode: 'everything' as never })).rejects.toThrow()
    expect(calls.length).toBe(0)
  })

  test('returns an empty array for no hits (never null)', async () => {
    const { db } = fakeDb([])
    expect(await search(db, SPACE, { q: 'nothing' })).toEqual([])
  })
})

describe('search — hybrid dispatch', () => {
  const embedOk = {
    embedConfigured: true,
    embed: async () => ({
      output: { embeddings: [[0.25, 0.5]], dimensions: 2 },
      run: {
        model: 'fake',
        prompt_version: 'embed.v1',
        input_hash: 'x',
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: 0,
      },
    }),
  }

  test('with pgvector + embed provider, both tiers go through the hybrid RPCs and carry matched_via', async () => {
    const { db, calls } = fakeDb([
      { match: 'wk_search_hybrid($1', rows: [{ ...CONCEPT_ROW, rank: 0.031, matched_via: 'both' }] },
      { match: 'wk_search_sources_hybrid($1', rows: [{ ...CHUNK_ROW, rank: 0.016, matched_via: 'vector' }] },
    ])
    const hits = await search(
      db,
      SPACE,
      { q: 'okf', mode: 'approved_then_sources' },
      { llm: embedOk, vector: { available: true } },
    )
    expect(calls[0]!.sql).toContain('FROM public.wk_search_hybrid($1, $2, $3, $4, $5)')
    expect(calls[0]!.values[2]).toBe('[0.25,0.5]')
    expect(calls[1]!.sql).toContain('FROM public.wk_search_sources_hybrid($1, $2, $3, $4)')
    expect(hits.map((hit) => hit.matched_via)).toEqual(['both', 'vector'])
  })

  test('degrades to lexical when the embed call fails — never errors', async () => {
    const { db, calls } = fakeDb([{ match: 'wk_search($1', rows: [CONCEPT_ROW] }])
    const failing = {
      embedConfigured: true,
      embed: async () => {
        throw new Error('provider down')
      },
    }
    const hits = await search(db, SPACE, { q: 'okf' }, { llm: failing, vector: { available: true } })
    expect(calls[0]!.sql).toContain('FROM public.wk_search($1, $2, $3, $4)')
    expect(hits[0]!.matched_via).toBeUndefined()
  })

  test('stays lexical without the pgvector probe or without an embed provider', async () => {
    const { db, calls } = fakeDb([{ match: 'wk_search($1', rows: [] }])
    await search(db, SPACE, { q: 'okf' }, { llm: embedOk, vector: { available: false } })
    await search(
      db,
      SPACE,
      { q: 'okf' },
      { llm: { embedConfigured: false, embed: embedOk.embed }, vector: { available: true } },
    )
    expect(calls.every((call) => call.sql.includes('FROM public.wk_search($1'))).toBe(true)
  })
})
