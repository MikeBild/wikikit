// concepts domain — read-model assembly and the visibility-by-construction
// rule (reads join over current_revision_id, never over a status filter).
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { getConcept, getConceptHistory, getConceptIndex, listConcepts } from '../../src/domain/concepts.ts'
import { NotFoundError } from '../../src/domain/errors.ts'
import { encodeCursor } from '../../src/domain/sources.ts'

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
    return { rows: route?.rows ?? [], rowCount: route?.rows.length ?? 0 }
  }
  const pool: PoolLike = { query, connect: async () => ({ query, release() {} }), end: async () => {} }
  const { db } = createPostgres({ databaseUrl: 'postgresql://stub' } as Config, { pool })
  return { db, calls }
}

const summaryRow = (slug: string) => ({
  slug,
  title: `Title ${slug}`,
  summary: 'S',
  rev: 1,
  updated_at: new Date('2026-07-01T10:00:00Z'),
})

describe('listConcepts', () => {
  test('unknown space is a 404 before any concept query', async () => {
    const { db } = fakeDb([{ match: /wk_spaces/, rows: [] }])
    await expect(listConcepts(db, 'nope', {})).rejects.toBeInstanceOf(NotFoundError)
  })

  test('joins over current_revision_id, returns numeric epoch and keyset cursor', async () => {
    const { db, calls } = fakeDb([
      { match: /wk_spaces/, rows: [{ epoch: '7' }] }, // bigint arrives as string
      {
        match: /JOIN wk_concept_revisions r ON r\.id = c\.current_revision_id/,
        rows: [summaryRow('a'), summaryRow('b'), summaryRow('c')],
      },
    ])
    const page = await listConcepts(db, 'space-1', { limit: 2 })
    expect(page.epoch).toBe(7)
    expect(page.items.map((item) => item.slug)).toEqual(['a', 'b'])
    expect(page.next_after).toBe(encodeCursor('b'))
    const listCall = calls.find((call) => call.sql.includes('current_revision_id'))!
    expect(listCall.sql).toContain('c.space_id = $1')
    expect(listCall.values).toEqual(['space-1', 3])
  })

  test('after cursor becomes the slug keyset parameter', async () => {
    const { db, calls } = fakeDb([
      { match: /wk_spaces/, rows: [{ epoch: 0 }] },
      { match: /current_revision_id/, rows: [] },
    ])
    await listConcepts(db, 'space-1', { limit: 10, after: encodeCursor('m') })
    const listCall = calls.find((call) => call.sql.includes('current_revision_id'))!
    expect(listCall.sql).toContain('c.slug > $2')
    expect(listCall.values).toEqual(['space-1', 'm', 11])
  })
})

describe('getConcept', () => {
  test('assembles revision + visible claims with citations + outgoing relations', async () => {
    const { db, calls } = fakeDb([
      {
        match: /SELECT c\.id AS concept_id/,
        rows: [
          {
            concept_id: 'con-1',
            slug: 'okf',
            title: 'OKF',
            summary: 'Sum',
            markdown: '# OKF',
            rev: 3,
            updated_at: new Date('2026-07-01T10:00:00Z'),
            agent_meta: { model: 'claude-sonnet-5' },
          },
        ],
      },
      {
        match: /wk_claims/,
        rows: [
          {
            id: 'cl-1',
            subject: 'okf',
            predicate: 'is',
            object: 'a spec',
            status: 'verified',
            confidence: 0.9,
            valid_from: null,
            valid_until: null,
            created_at: new Date('2026-07-01T10:00:00Z'),
            agent_meta: {},
          },
        ],
      },
      { match: /wk_citations/, rows: [{ claim_id: 'cl-1', source_id: 'src-1', quote: 'q', locator: '' }] },
      { match: /rel\.from_concept_id = \$2/, rows: [{ to_slug: 'subkit', kind: 'related' }] },
    ])
    const detail = await getConcept(db, 'space-1', { slug: 'okf' })
    expect(detail).toMatchObject({
      slug: 'okf',
      title: 'OKF',
      markdown: '# OKF',
      rev: 3,
      updated_at: '2026-07-01T10:00:00.000Z',
      agent_meta: { model: 'claude-sonnet-5' },
      relations: [{ to_slug: 'subkit', kind: 'related' }],
    })
    expect(detail.claims[0]!.citations).toEqual([{ source_id: 'src-1', quote: 'q', locator: '' }])
    // The read joins the current pointer AND only active relations.
    expect(calls[0]!.sql).toContain('r.id = c.current_revision_id')
    const relationCall = calls.find((call) => call.sql.includes('from_concept_id'))!
    expect(relationCall.sql).toContain(`rel.status = 'active'`)
  })

  test('concept without a current revision reads as 404 (staged content is invisible)', async () => {
    const { db } = fakeDb([{ match: /SELECT c\.id AS concept_id/, rows: [] }])
    await expect(getConcept(db, 'space-1', { slug: 'staged-only' })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('getConceptHistory', () => {
  test('unknown concept is a 404', async () => {
    const { db } = fakeDb([{ match: /wk_concepts/, rows: [] }])
    await expect(getConceptHistory(db, 'space-1', { slug: 'ghost' })).rejects.toBeInstanceOf(NotFoundError)
  })

  test('returns ALL statuses newest-first with agent_meta (the audit surface)', async () => {
    const { db, calls } = fakeDb([
      { match: /wk_concepts/, rows: [{ id: 'con-1' }] },
      {
        match: /wk_concept_revisions/,
        rows: [
          {
            id: 'rev-2',
            rev: 2,
            status: 'proposed',
            title: 'T2',
            summary: '',
            base_revision_id: 'rev-1',
            proposal_id: 'prop-2',
            agent_meta: { model: 'claude-sonnet-5', prompt_version: 'synthesize.v1' },
            created_at: new Date('2026-07-02T10:00:00Z'),
          },
          {
            id: 'rev-1',
            rev: 1,
            status: 'current',
            title: 'T1',
            summary: '',
            base_revision_id: null,
            proposal_id: 'prop-1',
            agent_meta: { model: 'manual', prompt_version: 'manual' },
            created_at: new Date('2026-07-01T10:00:00Z'),
          },
        ],
      },
    ])
    const history = await getConceptHistory(db, 'space-1', { slug: 'okf' })
    expect(history.map((revision) => revision.status)).toEqual(['proposed', 'current'])
    expect(history[0]!.agent_meta).toEqual({ model: 'claude-sonnet-5', prompt_version: 'synthesize.v1' })
    expect(history[1]!.created_at).toBe('2026-07-01T10:00:00.000Z')
    const revisionsCall = calls.find((call) => call.sql.includes('wk_concept_revisions'))!
    expect(revisionsCall.sql).toContain('ORDER BY "rev" DESC')
  })
})

describe('getConceptIndex', () => {
  test('projects slug/title/summary of readable concepts only', async () => {
    const { db, calls } = fakeDb([{ match: /current_revision_id/, rows: [{ slug: 'a', title: 'A', summary: 's' }] }])
    expect(await getConceptIndex(db, 'space-1')).toEqual([{ slug: 'a', title: 'A', summary: 's' }])
    expect(calls[0]!.sql).toContain('r.id = c.current_revision_id')
    expect(calls[0]!.values).toEqual(['space-1'])
  })
})
