// The overview's post-processing rules, on a stubbed pool: which spaces get a
// row at all, and the null-not-zero discipline the real aggregates are also
// held to by the integration suite. The SQL itself runs against Postgres in
// test/integration/spaces-overview.test.ts.
import { describe, expect, test } from 'bun:test'
import type { Db } from '../../src/db/postgres.ts'
import { reviewOverview, spacesOverview } from '../../src/domain/health.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

function stubDb(
  proposals: Record<string, unknown>[],
  concepts: Record<string, unknown>[] = [],
): Db & { queries: string[] } {
  const queries: string[] = []
  return {
    queries,
    query: async (text: string) => {
      queries.push(text)
      const rows = text.includes('FROM wk_change_proposals') ? proposals : concepts
      return { rows, rowCount: rows.length }
    },
  } as unknown as Db & { queries: string[] }
}

describe('reviewOverview', () => {
  test('an empty space list issues no query and answers an empty map', async () => {
    const db = stubDb([])
    expect(await reviewOverview(db, [])).toEqual(new Map())
    expect(db.queries).toEqual([])
  })

  test('a space with no rows is a measured zero with a null age, never 0 days', async () => {
    const rows = await reviewOverview(stubDb([]), [A])
    expect(rows.get(A)).toEqual({ pending: 0, oldest_days: null, created_7d: 0, pending_derived: 0, concepts: 0 })
  })

  test('oldest_days is null exactly when pending is 0, even if the pool says otherwise', async () => {
    // A stubbed pool hands back whatever it was told to — the same guard
    // spaceHealth applies to its own review query.
    const rows = await reviewOverview(
      stubDb([{ space_id: A, pending: 0, oldest_days: 3, created_7d: 5, pending_derived: 0 }]),
      [A],
    )
    expect(rows.get(A)).toEqual({ pending: 0, oldest_days: null, created_7d: 5, pending_derived: 0, concepts: 0 })
  })
})

describe('spacesOverview', () => {
  test('composes items in the given order and sums totals server-side', async () => {
    const db = stubDb(
      [
        { space_id: A, pending: 3, oldest_days: 21, created_7d: 2, pending_derived: 1 },
        { space_id: B, pending: 1, oldest_days: 2, created_7d: 4, pending_derived: 0 },
      ],
      [{ space_id: A, concepts: 9 }],
    )
    const overview = await spacesOverview(db, [
      { id: A, slug: 'alpha', name: 'Alpha', settings: { purpose: 'first' } },
      { id: B, slug: 'beta', name: 'Beta', settings: { description: 'second' } },
    ])
    expect(overview.items).toEqual([
      {
        space: 'alpha',
        name: 'Alpha',
        purpose: 'first',
        review_queue: { pending: 3, oldest_days: 21, pending_derived: 1 },
        created_7d: 2,
        concepts: 9,
      },
      {
        space: 'beta',
        name: 'Beta',
        purpose: 'second',
        review_queue: { pending: 1, oldest_days: 2, pending_derived: 0 },
        created_7d: 4,
        concepts: 0,
      },
    ])
    expect(overview.totals).toEqual({ pending: 4, pending_derived: 1, created_7d: 6, oldest_days: 21 })
  })

  test('a wiki that states no purpose answers null, and empty totals carry a null age', async () => {
    const overview = await spacesOverview(stubDb([]), [{ id: A, slug: 'quiet', name: 'Quiet', settings: {} }])
    expect(overview.items[0]!.purpose).toBeNull()
    expect(overview.totals).toEqual({ pending: 0, pending_derived: 0, created_7d: 0, oldest_days: null })
  })
})
