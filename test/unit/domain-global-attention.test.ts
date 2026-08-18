import { describe, expect, test } from 'bun:test'
import type { Db } from '../../src/db/postgres.ts'
import { getGlobalAttention } from '../../src/domain/attention.ts'

describe('getGlobalAttention', () => {
  test('returns one stable oldest-first queue with wiki provenance and no recent activity', async () => {
    const calls: unknown[][] = []
    const db = {
      async query(_sql: string, values: unknown[]) {
        calls.push(values)
        return {
          rows: [
            {
              space_id: 'a4b0c9d8-0000-4000-8000-000000000001',
              key: 'proposal:a4b0c9d8-0000-4000-8000-000000000010',
              kind: 'proposal',
              title: 'Review this',
              summary: 'A change',
              created_at: '2026-08-01T00:00:00.000Z',
            },
          ],
          rowCount: 1,
        }
      },
    } as unknown as Db
    const page = await getGlobalAttention(
      db,
      [{ id: 'a4b0c9d8-0000-4000-8000-000000000001', slug: 'alpha', name: 'Alpha' }],
      { limit: 50 },
    )
    expect(calls).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ space: 'alpha', space_name: 'Alpha', kind: 'proposal' })
    expect(page.counts).toMatchObject({ open: 1, by_kind: { proposal: 1, triage: 0 } })
    expect('recent_activity' in page).toBe(false)
  })
})
