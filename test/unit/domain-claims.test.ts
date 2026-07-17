// claims domain — visibility defaults, citation batching and the
// deterministic exact-frame contradiction matcher.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { findContradictions, listClaimsForConcept, VISIBLE_CLAIM_STATUSES } from '../../src/domain/claims.ts'

interface Call {
  sql: string
  values: unknown[]
}
type Rows = Record<string, unknown>[]

function fakeDb(routes: { match: RegExp; rows: Rows }[]) {
  const calls: Call[] = []
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    const route = routes.find((entry) => entry.match.test(sql))
    const rows =
      route?.rows ?? (sql.includes('"wk_spaces"') ? [{ settings: { functional_predicates: ['has_status'] } }] : [])
    return { rows, rowCount: rows.length }
  }
  const pool: PoolLike = { query, connect: async () => ({ query, release() {} }), end: async () => {} }
  const { db } = createPostgres({ databaseUrl: 'postgresql://stub' } as Config, { pool })
  return { db, calls }
}

const claimRow = (id: string, object = 'stable') => ({
  id,
  subject: 'okf',
  predicate: 'has_status',
  object,
  status: 'verified',
  confidence: 0.9,
  valid_from: null,
  valid_until: null,
  created_at: new Date('2026-07-01T10:00:00Z'),
  agent_meta: { model: 'fake' },
})

describe('listClaimsForConcept', () => {
  test('defaults to reader-visible statuses (never proposed/draft)', async () => {
    const { db, calls } = fakeDb([{ match: /wk_claims/, rows: [] }])
    await listClaimsForConcept(db, 'space-1', { conceptId: 'con-1' })
    expect(calls[0]!.sql).toContain('"status" IN ($3, $4, $5)')
    expect(calls[0]!.values.slice(2, 5)).toEqual([...VISIBLE_CLAIM_STATUSES])
    expect(calls[0]!.values[0]).toBe('space-1') // space-scoped
  })

  test('batches citations in one query and attaches them per claim', async () => {
    const { db, calls } = fakeDb([
      { match: /wk_claims/, rows: [claimRow('cl-1'), claimRow('cl-2', 'draft-v0.1')] },
      {
        match: /wk_citations/,
        rows: [
          { claim_id: 'cl-1', source_id: 'src-1', quote: 'q1', locator: 'lines 1-2' },
          { claim_id: 'cl-1', source_id: 'src-2', quote: 'q2', locator: '' },
        ],
      },
    ])
    const claims = await listClaimsForConcept(db, 'space-1', { conceptId: 'con-1' })
    expect(claims.length).toBe(2)
    expect(claims[0]!.citations.length).toBe(2)
    expect(claims[0]!.citations[0]).toEqual({ source_id: 'src-1', quote: 'q1', locator: 'lines 1-2' })
    expect(claims[1]!.citations).toEqual([])
    expect(claims[0]!.created_at).toBe('2026-07-01T10:00:00.000Z')
    // Exactly two statements: claims, then one batched citations lookup.
    expect(calls.length).toBe(2)
    expect(calls[1]!.sql).toContain('"claim_id" IN ($1, $2)')
  })

  test('no claims → no citations query at all', async () => {
    const { db, calls } = fakeDb([{ match: /wk_claims/, rows: [] }])
    expect(await listClaimsForConcept(db, 'space-1', { conceptId: 'con-1' })).toEqual([])
    expect(calls.length).toBe(1)
  })
})

describe('findContradictions — exact-frame matcher', () => {
  const incoming = [{ subject: 'okf', predicate: 'has_status', object: 'draft-v0.1' }]

  test('empty input returns [] without touching the database', async () => {
    const { db, calls } = fakeDb([])
    expect(await findContradictions(db, 'space-1', { claims: [] })).toEqual([])
    expect(calls.length).toBe(0)
  })

  test('same frame + different object against a persisted claim is a pair', async () => {
    const { db, calls } = fakeDb([
      {
        match: /unnest/,
        rows: [
          {
            id: 'cl-old',
            concept_id: 'con-old',
            subject: 'okf',
            predicate: 'has_status',
            object: 'production-ready',
            status: 'verified',
          },
        ],
      },
    ])
    const pairs = await findContradictions(db, 'space-1', { claims: incoming })
    expect(pairs).toEqual([
      {
        subject: 'okf',
        predicate: 'has_status',
        proposed_object: 'draft-v0.1',
        existing_object: 'production-ready',
        existing_claim_id: 'cl-old',
        existing_concept_id: 'con-old',
        existing_status: 'verified',
      },
    ])
    // Only verified/disputed on the persisted side — mirrors wk_apply_proposal.
    const collisionQuery = calls.find((call) => call.sql.includes('unnest'))!
    expect(collisionQuery.sql).toContain(`status IN ('verified', 'disputed')`)
    expect(collisionQuery.values[0]).toBe('space-1')
  })

  test('same frame + SAME object is agreement, not contradiction', async () => {
    const { db } = fakeDb([
      {
        match: /unnest/,
        rows: [
          {
            id: 'cl-old',
            concept_id: 'con-old',
            subject: 'okf',
            predicate: 'has_status',
            object: 'draft-v0.1',
            status: 'verified',
          },
        ],
      },
    ])
    expect(await findContradictions(db, 'space-1', { claims: incoming })).toEqual([])
  })

  test('different frame never matches', async () => {
    const { db } = fakeDb([
      {
        match: /unnest/,
        rows: [
          {
            id: 'cl-old',
            concept_id: 'con-old',
            subject: 'okf',
            predicate: 'is',
            object: 'production-ready',
            status: 'verified',
          },
        ],
      },
    ])
    expect(await findContradictions(db, 'space-1', { claims: incoming })).toEqual([])
  })

  test('undeclared predicates are multi-valued and never produce pairs', async () => {
    const { db, calls } = fakeDb([
      { match: /wk_spaces/, rows: [{ settings: {} }] },
      { match: /unnest/, rows: [] },
    ])
    expect(await findContradictions(db, 'space-1', { claims: incoming })).toEqual([])
    expect(calls.some((call) => call.sql.includes('unnest'))).toBe(false)
  })

  test('intra-batch collisions are detected with existing_claim_id null', async () => {
    const { db } = fakeDb([{ match: /unnest/, rows: [] }])
    const pairs = await findContradictions(db, 'space-1', {
      claims: [
        { subject: 'okf', predicate: 'has_status', object: 'draft' },
        { subject: 'okf', predicate: 'has_status', object: 'final' },
      ],
    })
    expect(pairs.length).toBe(1)
    expect(pairs[0]).toMatchObject({
      subject: 'okf',
      predicate: 'has_status',
      existing_claim_id: null,
      existing_concept_id: null,
    })
  })
})
