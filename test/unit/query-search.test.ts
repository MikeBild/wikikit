// search.ts — the LLM-free retrieval wrapper over the wk_search RPCs.
// Asserted here: boundary validation happens before any SQL, the calls go
// through the pinned db.call statements (never raw SQL), defaults mirror the
// MCP tool schema (limit 20, mode approved_only), rows map column-for-column
// to the SearchHit wire shape shared by REST and wikikit_search, and the
// source-evidence tier is appended strictly AFTER approved hits, and concept
// hits — and ONLY concept hits — carry the evidence summary.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { search, searchAcrossImports } from '../../src/query/search.ts'

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
    // Located by statement, not by call index: the evidence lookup for the
    // concept hit sits between the two tier queries, and pinning positions
    // would make every future statement look like a contract change.
    const sources = calls.find((call) => call.sql.includes('wk_search_sources'))!
    expect(sources.sql).toContain('FROM public.wk_search_sources($1, $2, $3)')
    expect(sources.values).toEqual([SPACE, 'okf', 7])
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

describe('search — evidence on concept hits', () => {
  // The aggregate's statement, recognised by its lateral. Matching on the SQL
  // rather than on call order is what makes "no concept hits ⇒ no statement"
  // assertable at all.
  const EVIDENCE_SQL = 'CROSS JOIN LATERAL'
  const evidenceCalls = (calls: Call[]) => calls.filter((call) => call.sql.includes(EVIDENCE_SQL))

  const CLAIM_ROW = {
    kind: 'claim',
    concept_slug: 'okf',
    claim_id: 'c1b0c9d8-0000-4000-8000-000000000009',
    title: 'OKF',
    headline: 'okf is <mark>draft</mark>',
    rank: 0.4,
  }

  test('a concept hit carries the three numbers measured for ITS page', async () => {
    const { db, calls } = fakeDb([
      { match: 'wk_search($1', rows: [CONCEPT_ROW, { ...CONCEPT_ROW, concept_slug: 'okf-history', rank: 0.2 }] },
      {
        match: EVIDENCE_SQL,
        rows: [
          { slug: 'okf', claims: 7, uncited_claims: 2, sources: 3 },
          { slug: 'okf-history', claims: 0, uncited_claims: 0, sources: 0 },
        ],
      },
    ])
    const hits = await search(db, SPACE, { q: 'okf' })
    // Each hit gets ITS OWN row, not the first row's. A lookup keyed by
    // position instead of by slug passes every count assertion and quietly
    // reports the top hit's evidence for the whole page.
    expect(hits.map((hit) => [hit.slug, hit.evidence])).toEqual([
      ['okf', { claims: 7, uncited_claims: 2, sources: 3 }],
      ['okf-history', { claims: 0, uncited_claims: 0, sources: 0 }],
    ])
    // Zero is a MEASUREMENT — the hand-written page that cites nothing is the
    // state this whole feature exists to make visible, and it must arrive as
    // three zeros rather than as an absent object.
    expect(hits[1]!.evidence).toBeDefined()
    // One statement for the whole page: an evidence lookup per hit reads fine
    // and turns a 50-hit search into 51 round trips.
    expect(evidenceCalls(calls).length).toBe(1)
    expect(evidenceCalls(calls)[0]!.values).toEqual([SPACE, ['okf', 'okf-history']])
  })

  test('a claim hit carries no evidence, even beside a concept hit on the same page', async () => {
    // The decision, pinned: the page's totals answer "how evidenced is this
    // page", which is not the question a claim hit raises ("is THIS claim
    // quoted"). Lending the container's numbers to the claim would put
    // `claims: 7` on a single claim and let `uncited_claims: 2` read as a
    // verdict on the matched one.
    const { db, calls } = fakeDb([
      { match: 'wk_search($1', rows: [CONCEPT_ROW, CLAIM_ROW] },
      { match: EVIDENCE_SQL, rows: [{ slug: 'okf', claims: 7, uncited_claims: 2, sources: 3 }] },
    ])
    const hits = await search(db, SPACE, { q: 'okf' })
    expect(hits[1]!.kind).toBe('claim')
    expect(hits[1]!.evidence).toBeUndefined()
    expect('evidence' in hits[1]!).toBe(false)
    expect(hits[0]!.evidence).toEqual({ claims: 7, uncited_claims: 2, sources: 3 })
    // The claim hit's slug must not widen the lookup either — it is already
    // there for the concept hit, and asking twice is the same page twice.
    expect(evidenceCalls(calls)[0]!.values).toEqual([SPACE, ['okf']])
  })

  test('a source-evidence hit carries no evidence — the tier means the opposite', async () => {
    // A chunk hit is explicitly NOT approved knowledge. An evidence summary on
    // it would decorate an unreviewed archived paragraph with the badge of a
    // curated page: the worst available misreading of this field.
    const { db } = fakeDb([
      { match: 'wk_search($1', rows: [] },
      { match: 'wk_search_sources($1', rows: [CHUNK_ROW] },
      { match: EVIDENCE_SQL, rows: [{ slug: 'okf', claims: 7, uncited_claims: 2, sources: 3 }] },
    ])
    const [hit] = await search(db, SPACE, { q: 'okf', mode: 'approved_then_sources' })
    expect(hit!.tier).toBe('source_evidence')
    expect(hit!.evidence).toBeUndefined()
  })

  test('no concept hits, no extra statement — a claim-filtered or empty search costs what it always did', async () => {
    const { db, calls } = fakeDb([{ match: 'wk_search($1', rows: [CLAIM_ROW] }])
    await search(db, SPACE, { q: 'okf', kind: 'claim' })
    expect(evidenceCalls(calls).length).toBe(0)

    const empty = fakeDb([])
    await search(empty.db, SPACE, { q: 'nothing' })
    expect(evidenceCalls(empty.calls).length).toBe(0)
  })

  test('a page that vanished between ranking and counting is left ABSENT, never zeroed', async () => {
    // The aggregate only counts readable pages, so a concept deleted (or
    // un-published) in the microseconds between the two statements returns no
    // row. Filling that in with zeros would publish "this page cites nothing"
    // about a page nobody measured — and zero has to keep meaning measured.
    const { db } = fakeDb([
      { match: 'wk_search($1', rows: [CONCEPT_ROW] },
      { match: EVIDENCE_SQL, rows: [] },
    ])
    const [hit] = await search(db, SPACE, { q: 'okf' })
    expect(hit!.evidence).toBeUndefined()
  })

  test('the hybrid arm reports evidence too — an arm is a ranker, not a different kind of hit', async () => {
    const { db } = fakeDb([
      { match: 'wk_search_hybrid($1', rows: [{ ...CONCEPT_ROW, rank: 0.031, matched_via: 'both' }] },
      { match: EVIDENCE_SQL, rows: [{ slug: 'okf', claims: 1, uncited_claims: 0, sources: 1 }] },
    ])
    const [hit] = await search(
      db,
      SPACE,
      { q: 'okf' },
      {
        llm: {
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
        },
        vector: { available: true },
      },
    )
    expect(hit!.evidence).toEqual({ claims: 1, uncited_claims: 0, sources: 1 })
  })

  test('a federated search counts each space in ITS OWN space_id', async () => {
    // Two spaces can hold the same slug, and claims are scoped by space_id.
    // Counting an imported space's page against the requesting space's id
    // returns zeros for a well-evidenced page — silently, and only in the
    // deployments that use imports.
    const IMPORTED = 'a4b0c9d8-0000-4000-8000-000000000002'
    const { db, calls } = fakeDb([
      { match: 'wk_search($1', rows: [CONCEPT_ROW] },
      { match: 'wk_spaces', rows: [{ id: IMPORTED }] },
      { match: EVIDENCE_SQL, rows: [{ slug: 'okf', claims: 2, uncited_claims: 0, sources: 1 }] },
    ])
    const { hits } = await searchAcrossImports(
      db,
      { id: SPACE, slug: 'home', settings: { imports: ['upstream'] } },
      { q: 'okf' },
    )
    expect(hits.map((hit) => hit.space)).toEqual(['home', 'upstream'])
    expect(evidenceCalls(calls).map((call) => call.values[0])).toEqual([SPACE, IMPORTED])
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
    // By statement rather than by index, for the same reason as above.
    expect(calls.some((call) => call.sql.includes('FROM public.wk_search_sources_hybrid($1, $2, $3, $4)'))).toBe(true)
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
