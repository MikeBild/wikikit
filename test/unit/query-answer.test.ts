// answer.ts — retrieval-then-synthesis with the audit contract.
// Asserted here: the 503 guard fires before any SQL, empty retrieval STILL
// produces exactly one audited answer.v1 call (not_in_knowledge_base), claim
// evidence carries status + quote (disputed surfaced, deprecated excluded),
// hallucinated citations are dropped, and vanished concepts are skipped.
// Deterministic and offline: FakeProvider + the routed stub pool.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { LlmNotConfiguredError } from '../../src/domain/errors.ts'
import { answerQuestion } from '../../src/query/answer.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import type { AnswerEvidence } from '../../src/llm/schemas.ts'

interface Call {
  sql: string
  values: unknown[]
}
type Rows = Record<string, unknown>[]
interface Route {
  match: RegExp
  rows?: Rows | ((values: unknown[]) => Rows)
}

function fakeDb(routes: Route[]) {
  const calls: Call[] = []
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    const route = routes.find((entry) => entry.match.test(sql))
    if (!route) return { rows: [], rowCount: 0 }
    const rows = typeof route.rows === 'function' ? route.rows(values) : (route.rows ?? [])
    return { rows, rowCount: rows.length }
  }
  const pool: PoolLike = { query, connect: async () => ({ query, release() {} }), end: async () => {} }
  const { db } = createPostgres({ databaseUrl: 'postgresql://stub' } as Config, { pool })
  return { db, calls }
}

const SPACE = 'a4b0c9d8-0000-4000-8000-000000000001'

const conceptRow = {
  concept_id: 'con-1',
  slug: 'okf',
  title: 'Open Knowledge Format',
  summary: 'A knowledge bundle spec.',
  markdown: '# OKF\n\nOKF is a draft spec.',
  rev: 3,
  updated_at: new Date('2026-07-01T10:00:00Z'),
  agent_meta: {},
}

const claimBase = {
  subject: 'okf',
  predicate: 'has_status',
  confidence: 0.9,
  valid_from: null,
  valid_until: null,
  created_at: new Date('2026-07-01T10:00:00Z'),
  agent_meta: {},
}

/** Routes for a retrieval that finds the 'okf' concept with the given claims. */
function routes(overrides: { hits?: Rows; claims?: Rows; citations?: Rows; concept?: Rows } = {}): Route[] {
  return [
    {
      match: /FROM public\.wk_search/,
      rows: overrides.hits ?? [
        {
          kind: 'concept',
          concept_slug: 'okf',
          claim_id: null,
          title: 'Open Knowledge Format',
          headline: 'h',
          rank: 0.9,
        },
      ],
    },
    { match: /AS concept_id/, rows: overrides.concept ?? [conceptRow] },
    { match: /SELECT \* FROM "public"\."wk_claims"/, rows: overrides.claims ?? [] },
    { match: /SELECT \* FROM "public"\."wk_citations"/, rows: overrides.citations ?? [] },
    { match: /rel\.status = 'active'/, rows: [] },
    { match: /INSERT INTO "public"\."wk_agent_runs"/, rows: [{ id: 'run-1' }] },
  ]
}

describe('answerQuestion', () => {
  test('throws LlmNotConfiguredError before any SQL when no key is set', async () => {
    const { db, calls } = fakeDb(routes())
    const llm = { ...createFakeProvider(), configured: false }
    await expect(answerQuestion(db, SPACE, llm, { question: 'Is OKF ready?' })).rejects.toBeInstanceOf(
      LlmNotConfiguredError,
    )
    expect(calls.length).toBe(0)
  })

  test('rejects invalid args before any SQL (zod at the boundary)', async () => {
    const { db, calls } = fakeDb(routes())
    const llm = createFakeProvider()
    await expect(answerQuestion(db, SPACE, llm, { question: '' })).rejects.toThrow()
    await expect(answerQuestion(db, SPACE, llm, { question: 'q', top_k: 0 })).rejects.toThrow()
    await expect(answerQuestion(db, SPACE, llm, { question: 'q', top_k: 51 })).rejects.toThrow()
    expect(calls.length).toBe(0)
  })

  test('empty retrieval still makes ONE audited call and reports not-in-knowledge-base', async () => {
    const { db, calls } = fakeDb(routes({ hits: [] }))
    const llm = createFakeProvider()
    const result = await answerQuestion(db, SPACE, llm, { question: 'Unknown topic?' })

    // The LLM is called even on empty evidence — agent_run_id is non-nullable
    // by contract, and the model owns the "not covered" phrasing.
    expect(llm.calls.map((call) => call.method)).toEqual(['answer'])
    expect((llm.calls[0]!.input as { evidence: unknown[] }).evidence).toEqual([])
    expect(result.not_in_knowledge_base).toBe(true)
    expect(result.citations).toEqual([])
    expect(result.agent_run_id).toBe('run-1')
    expect(calls.some((call) => call.sql.includes('wk_agent_runs'))).toBe(true)
  })

  test('happy path: evidence = concept page + claims, answer cited and audited', async () => {
    const claims: Rows = [
      { ...claimBase, id: 'claim-1', object: 'draft', status: 'verified' },
      { ...claimBase, id: 'claim-2', object: 'production-ready', status: 'disputed' },
    ]
    const citations: Rows = [{ claim_id: 'claim-1', source_id: 'src-1', quote: 'OKF is a draft spec.', locator: '' }]
    const { db, calls } = fakeDb(routes({ claims, citations }))
    const llm = createFakeProvider()
    const result = await answerQuestion(db, SPACE, llm, { question: 'Is OKF production ready?', top_k: 3 })

    // top_k drives the retrieval limit.
    const searchCall = calls.find((call) => call.sql.includes('wk_search'))!
    expect(searchCall.values).toEqual([SPACE, 'Is OKF production ready?', null, 3])

    const evidence = (llm.calls[0]!.input as { evidence: AnswerEvidence[] }).evidence
    // Concept page first (title + summary + budgeted markdown), then claims.
    expect(evidence[0]).toMatchObject({ kind: 'concept', slug: 'okf', status: null })
    expect(evidence[0]!.text).toContain('# Open Knowledge Format')
    expect(evidence[0]!.text).toContain('OKF is a draft spec.')

    // Claim evidence carries STATUS (disputed must reach the model) and the
    // verbatim citation quote.
    const claimEvidence = evidence.filter((entry) => entry.kind === 'claim')
    expect(claimEvidence).toHaveLength(2)
    expect(claimEvidence[0]).toMatchObject({ slug: 'okf', status: 'verified' })
    expect(claimEvidence[0]!.text).toContain('okf has_status draft')
    expect(claimEvidence[0]!.text).toContain('source quote: "OKF is a draft spec."')
    expect(claimEvidence[1]).toMatchObject({ status: 'disputed' })
    expect(claimEvidence[1]!.text).toContain('production-ready')

    // Citations resolve through the loaded evidence.
    expect(result.citations).toEqual([{ slug: 'okf', title: 'Open Knowledge Format' }])
    expect(result.not_in_knowledge_base).toBe(false)
    expect(result.agent_run_id).toBe('run-1')

    // Audit row: kind 'answer', production-shaped run meta.
    const audit = calls.find((call) => call.sql.includes('wk_agent_runs'))!
    expect(audit.values).toContain('answer')
    expect(audit.values).toContain('fake')
    expect(audit.values).toContain('answer.v1')
    expect(audit.values).toContain(SPACE)
  })

  test('deprecated claims never become evidence', async () => {
    const claims: Rows = [{ ...claimBase, id: 'claim-3', object: 'retired', status: 'deprecated' }]
    const { db } = fakeDb(routes({ claims }))
    const llm = createFakeProvider()
    await answerQuestion(db, SPACE, llm, { question: 'Is OKF ready?' })
    const evidence = (llm.calls[0]!.input as { evidence: AnswerEvidence[] }).evidence
    expect(evidence.filter((entry) => entry.kind === 'claim')).toEqual([])
  })

  test('duplicate hits (concept + its claims) load the concept once', async () => {
    const hits: Rows = [
      { kind: 'concept', concept_slug: 'okf', claim_id: null, title: 'OKF', headline: 'h', rank: 0.9 },
      { kind: 'claim', concept_slug: 'okf', claim_id: 'claim-1', title: 'OKF', headline: 'h', rank: 0.5 },
    ]
    const { db, calls } = fakeDb(routes({ hits }))
    const llm = createFakeProvider()
    await answerQuestion(db, SPACE, llm, { question: 'okf?' })
    expect(calls.filter((call) => call.sql.includes('AS concept_id')).length).toBe(1)
  })

  test('cited slugs the model never saw are dropped from citations', async () => {
    const { db } = fakeDb(routes())
    const llm = createFakeProvider({
      answer: () => ({
        answer_markdown: 'See [okf] and [ghost].',
        cited_slugs: ['okf', 'ghost', 'okf'],
        not_in_knowledge_base: false,
      }),
    })
    const result = await answerQuestion(db, SPACE, llm, { question: 'okf?' })
    // 'ghost' was never evidence → hallucinated reference, dropped; 'okf'
    // de-duplicated.
    expect(result.citations).toEqual([{ slug: 'okf', title: 'Open Knowledge Format' }])
  })

  test('a concept that vanished between search and load is skipped, not fatal', async () => {
    const hits: Rows = [
      { kind: 'concept', concept_slug: 'gone', claim_id: null, title: 'Gone', headline: 'h', rank: 0.9 },
    ]
    // getConcept finds no current revision → NotFoundError → skipped.
    const { db } = fakeDb(routes({ hits, concept: [] }))
    const llm = createFakeProvider()
    const result = await answerQuestion(db, SPACE, llm, { question: 'gone?' })
    expect((llm.calls[0]!.input as { evidence: unknown[] }).evidence).toEqual([])
    expect(result.not_in_knowledge_base).toBe(true)
  })

  test('oversized concept pages are budgeted before reaching the model', async () => {
    const bigMarkdown = `# Big\n\n${'word '.repeat(30_000)}` // ~37k tokens > 4k cap
    const { db } = fakeDb(routes({ concept: [{ ...conceptRow, markdown: bigMarkdown }] }))
    const llm = createFakeProvider()
    await answerQuestion(db, SPACE, llm, { question: 'okf?' })
    const evidence = (llm.calls[0]!.input as { evidence: AnswerEvidence[] }).evidence
    expect(evidence[0]!.text.length).toBeLessThan(bigMarkdown.length)
    expect(evidence[0]!.text).toContain('truncated')
  })
})
