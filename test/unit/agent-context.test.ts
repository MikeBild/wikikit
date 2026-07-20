import { describe, expect, test } from 'bun:test'
import type { Db } from '../../src/db/postgres.ts'
import { buildAgentContext } from '../../src/agent/context.ts'

const db = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Db

const spaces = [
  {
    id: '1',
    slug: 'blog-de',
    name: 'Blog DE',
    settings: {
      description: 'German blog editorial rules, publishing, house style and author voice',
      agent_context: { aliases: ['deutsch', 'Mike Bild'], keywords: ['Blogartikel', 'Autorenstimme'] },
    },
  },
  {
    id: '2',
    slug: 'contentkit',
    name: 'ContentKit',
    settings: { purpose: 'Semantic publishing, narrative and visual composition' },
  },
  {
    id: '3',
    slug: 'ocpp',
    name: 'OCPP',
    settings: { description: 'OCPP charging protocol reference' },
  },
]

describe('agent context selection', () => {
  test('selects stable German blog-authoring knowledge from the task', async () => {
    const result = await buildAgentContext(db, spaces, {
      prompt: 'Schreibe einen deutschen Blogartikel in Mike Bilds Autorenstimme',
    })
    expect(result.spaces[0]).toBe('blog-de')
    expect(result.matches[0]!.reasons).toContain('blogartikel')
  })

  test('does not treat an occasional workflow detail as a permanent activator', async () => {
    const result = await buildAgentContext(db, spaces, { prompt: 'Kannst du das zurückdatieren?' })
    expect(result.spaces).toEqual([])
  })

  test('manual selection can load arbitrary visible spaces in order', async () => {
    const result = await buildAgentContext(db, spaces, {
      prompt: '',
      manual_spaces: ['ocpp', 'blog-de', 'contentkit'],
      max_spaces: 10,
    })
    expect(result.selection_mode).toBe('manual')
    expect(result.spaces).toEqual(['ocpp', 'blog-de', 'contentkit'])
  })
})
