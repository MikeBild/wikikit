import { describe, expect, test } from 'bun:test'
import type { Db } from '../../src/db/postgres.ts'
import { buildAgentBriefing } from '../../src/agent/briefing.ts'

function dbWithConcepts(): Db {
  return {
    query: async (_text: string, params: unknown[] = []) => ({
      rows: (params[1] as string[]).map((slug) => ({ slug, title: `Title ${slug}`, summary: `Summary ${slug}` })),
      rowCount: (params[1] as string[]).length,
    }),
  } as unknown as Db
}

describe('agent briefing', () => {
  test('uses only pinned concepts and preserves primary-to-secondary space order', async () => {
    const result = await buildAgentBriefing(
      dbWithConcepts(),
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
    const result = await buildAgentBriefing(dbWithConcepts(), [{ id: '1', slug: 'empty', name: 'Empty', settings: {} }])
    expect(result.concepts_included).toEqual([])
    expect(result.markdown).toContain('No pinned briefing concepts')
  })
})
