import { describe, expect, test } from 'bun:test'
import type { Db } from '../../src/db/postgres.ts'
import { getAttention, getAttentionItem } from '../../src/domain/attention.ts'

describe('the attention queue contains decisions, not check observations', () => {
  test('does not query lint findings or turn an unused source into open work', async () => {
    const queries: string[] = []
    const db = {
      query: async (sql: string) => {
        queries.push(sql)
        return { rows: [] }
      },
      select: async () => [],
    } as unknown as Db

    const page = await getAttention(db, 'space-1', { state: 'open', limit: 200 })

    expect(page.counts).toEqual({
      open: 0,
      overdue: 0,
      oldest_days: null,
      by_kind: { proposal: 0, triage: 0, output: 0 },
    })
    expect(page.items).toEqual([])
    expect(queries.some((sql) => sql.includes('NOT EXISTS (SELECT 1 FROM wk_citations'))).toBe(false)
  })

  test('refreshes trace fields on a deferred item instead of serving its old snapshot', async () => {
    const proposalId = '11111111-1111-4111-8111-111111111111'
    const sourceId = '22222222-2222-4222-8222-222222222222'
    const db = {
      query: async (sql: string) => {
        if (sql.includes('FROM wk_change_proposals p')) {
          return {
            rows: [
              {
                id: proposalId,
                title: 'Current title',
                summary: 'Current summary',
                created_at: '2026-08-18T00:00:00.000Z',
                previous_id: null,
                previous_at: null,
                previous_note: null,
                source_ids: [sourceId],
              },
            ],
          }
        }
        if (sql.includes('FROM wk_sources')) {
          return { rows: [{ id: sourceId, title: 'Briefing', metadata: {} }] }
        }
        if (sql.includes('FROM wk_concept_revisions')) {
          return {
            rows: [
              {
                proposal_id: proposalId,
                slug: 'new-page',
                title: 'New page',
                base_revision_id: null,
              },
            ],
          }
        }
        return { rows: [] }
      },
      select: async () => [
        {
          item_key: `proposal:${proposalId}`,
          kind: 'proposal',
          state: 'deferred',
          remind_at: '2026-08-21T00:00:00.000Z',
          note: 'Later',
          updated_at: '2026-08-18T00:00:00.000Z',
          snapshot: {
            key: `proposal:${proposalId}`,
            kind: 'proposal',
            state: 'open',
            title: 'Old title',
            summary: 'Old summary',
            effect: 'Old effect',
            created_at: '2026-08-17T00:00:00.000Z',
            remind_at: null,
            note: null,
            origins: [],
            targets: [],
            available_actions: [],
            previous_rejection: null,
          },
        },
      ],
    } as unknown as Db

    const item = await getAttentionItem(db, 'space-1', `proposal:${proposalId}`)

    expect(item?.title).toBe('Current title')
    expect(item?.state).toBe('deferred')
    expect(item?.note).toBe('Later')
    expect(item?.origins).toEqual([
      { kind: 'source', label: 'Briefing', href: `/sources/${sourceId}`, provenance: 'external' },
    ])
    expect(item?.targets).toEqual([{ kind: 'page', label: 'New page', href: null, change: 'create' }])
  })
})
