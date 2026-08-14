import { describe, expect, test } from 'bun:test'
import type { Db } from '../../src/db/postgres.ts'
import { buildAgentBriefing } from '../../src/agent/briefing.ts'

/**
 * Dispatches on the SQL, because the briefing issues two different reads: the
 * pinned-concepts lookup (per space) and reviewOverview's grouped proposal
 * count. `backlogs` maps space id → {pending, oldest_days}; spaces absent from
 * it answer no row, which is how a space with no proposals answers in Postgres.
 */
function stubDb(backlogs: Record<string, { pending: number; oldest_days: number | null }> = {}, summaryLength = 0): Db {
  return {
    query: async (text: string, params: unknown[] = []) => {
      if (text.includes('FROM wk_change_proposals')) {
        const ids = params[0] as string[]
        const rows = ids
          .filter((id) => backlogs[id])
          .map((id) => ({
            space_id: id,
            pending: backlogs[id]!.pending,
            oldest_days: backlogs[id]!.oldest_days,
            created_7d: 0,
            pending_derived: 0,
          }))
        return { rows, rowCount: rows.length }
      }
      if (text.includes('FROM wk_concepts c')) {
        const rows = (params[1] as string[]).map((slug) => ({
          slug,
          title: `Title ${slug}`,
          summary: summaryLength > 0 ? 'x'.repeat(summaryLength) : `Summary ${slug}`,
        }))
        return { rows, rowCount: rows.length }
      }
      return { rows: [], rowCount: 0 }
    },
  } as unknown as Db
}

describe('agent briefing', () => {
  test('uses only pinned concepts and preserves primary-to-secondary space order', async () => {
    const result = await buildAgentBriefing(
      stubDb(),
      [
        {
          id: '1',
          slug: 'contentkit',
          name: 'ContentKit',
          settings: { agent_briefing: { concept_slugs: ['build', 'templates'] } },
        },
        {
          id: '2',
          slug: 'blog-de',
          name: 'German blog',
          settings: { agent_briefing: { concept_slugs: ['house-style'] } },
        },
      ],
      800,
    )
    expect(result.spaces).toEqual(['contentkit', 'blog-de'])
    expect(result.concepts_included).toEqual(['contentkit:build', 'contentkit:templates', 'blog-de:house-style'])
    expect(result.markdown).toContain('search and read reviewed WikiKit knowledge')
    expect(result.used_tokens).toBeLessThanOrEqual(800)
  })

  test('does not turn an unconfigured space into a full concept catalogue', async () => {
    const result = await buildAgentBriefing(stubDb(), [{ id: '1', slug: 'empty', name: 'Empty', settings: {} }])
    expect(result.concepts_included).toEqual([])
    expect(result.markdown).toContain('No pinned briefing concepts')
  })

  test('a space with nothing pending gets no backlog line, and null age, never 0', async () => {
    const result = await buildAgentBriefing(stubDb(), [{ id: '1', slug: 'quiet', name: 'Quiet', settings: {} }])
    expect(result.markdown).not.toContain('pending review')
    expect(result.pending_changes).toEqual({
      total: 0,
      oldest_days: null,
      spaces: [{ space: 'quiet', pending: 0, oldest_days: null }],
    })
  })

  test('renders per-space backlog lines and a sum line across more than one space', async () => {
    const result = await buildAgentBriefing(
      stubDb({ '1': { pending: 3, oldest_days: 21 }, '2': { pending: 1, oldest_days: 2 } }),
      [
        { id: '1', slug: 'alpha', name: 'Alpha', settings: {} },
        { id: '2', slug: 'beta', name: 'Beta', settings: {} },
      ],
    )
    expect(result.markdown).toContain('- 3 change(s) pending review.')
    expect(result.markdown).toContain('- Oldest: 21 day(s) old.')
    expect(result.markdown).toContain('Across these spaces: 4 change(s) pending review; oldest 21 day(s) old.')
    expect(result.pending_changes).toEqual({
      total: 4,
      oldest_days: 21,
      spaces: [
        { space: 'alpha', pending: 3, oldest_days: 21 },
        { space: 'beta', pending: 1, oldest_days: 2 },
      ],
    })
  })

  test('the budget trim removes concepts, never the backlog fact lines', async () => {
    const result = await buildAgentBriefing(
      stubDb({ '1': { pending: 7, oldest_days: 14 } }, 320),
      [
        {
          id: '1',
          slug: 'contentkit',
          name: 'ContentKit',
          settings: { agent_briefing: { concept_slugs: ['a', 'b', 'c', 'd', 'e'] } },
        },
      ],
      // The floor: tight enough that every trimmable concept goes.
      500,
    )
    expect(result.concepts_omitted).toBeGreaterThan(0)
    expect(result.markdown).toContain('- 7 change(s) pending review.')
    expect(result.markdown).toContain('- Oldest: 14 day(s) old.')
  })
})
