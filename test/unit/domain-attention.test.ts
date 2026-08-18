import { describe, expect, test } from 'bun:test'
import type { Db } from '../../src/db/postgres.ts'
import { getAttention } from '../../src/domain/attention.ts'

function dbWithOneUnusedSource(): Db {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM wk_sources s') && sql.includes('NOT EXISTS (SELECT 1 FROM wk_citations')) {
        return { rows: [{ id: 'source-1', title: 'Deployment handbook', kind: 'markdown' }] }
      }
      if (sql.includes('FROM wk_charter_revisions')) return { rows: [{ found: 1 }] }
      return { rows: [] }
    },
    select: async () => [],
  } as unknown as Db
}

describe('the attention queue presents live check findings honestly', () => {
  test('carries structured finding data, a precise target and no invented age', async () => {
    const page = await getAttention(
      dbWithOneUnusedSource(),
      'space-1',
      { state: 'open', limit: 200 },
      { scaffoldingKinds: [] },
    )

    expect(page.counts).toEqual({
      open: 1,
      overdue: 0,
      oldest_days: null,
      by_kind: { proposal: 0, triage: 0, output: 0, care: 1 },
      care_by_severity: { error: 0, warn: 0, info: 1 },
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      kind: 'care',
      summary: '',
      source: { href: '/sources/source-1' },
      finding: {
        rule: 'dangling-sources',
        severity: 'info',
        message: {
          key: 'dangling-sources',
          args: { source_id: 'source-1', source_title: 'Deployment handbook', source_kind: 'markdown' },
        },
      },
    })
    expect(new Date(page.generated_at).getTime() - new Date(page.items[0]!.created_at).getTime()).toBeLessThan(100)
  })
})
