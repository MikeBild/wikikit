// Cross-space federation (0023) against real Postgres: declared imports gate
// staging, qualified targets must exist as readable concepts (never
// placeholders in foreign spaces), approval activates cross-space relations
// with to_space_id, the read side labels provenance, multi-space search tags
// hits and the lint rule flags dangling [[space:slug]] links. No knowledge is
// ever copied between spaces. RUN_INTEGRATION=1 gated.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createProposal } from '../../src/domain/proposals.ts'
import { getConcept } from '../../src/domain/concepts.ts'
import { lintSpace } from '../../src/domain/lint.ts'
import { searchAcrossImports } from '../../src/query/search.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db
let platformId = ''
let blogId = ''

const hex64 = () => randomUUID().replaceAll('-', '').padEnd(64, '0')

async function approveConcept(
  spaceId: string,
  slug: string,
  markdown: string,
  relations: { to_slug: string; kind: 'related' }[] = [],
) {
  const { proposal_id } = await createProposal(db, spaceId, {
    title: `Add ${slug}`,
    input_hash: hex64(),
    agent_meta: { model: 'manual', prompt_version: 'manual' },
    concepts: [{ slug, title: slug, markdown, relations }],
  })
  await db.call('wk_apply_proposal', [proposal_id, 'federation-test'])
  return proposal_id
}

describe('cross-space federation (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_federation')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
    const [platform] = await db.insert<{ id: string }>('wk_spaces', {
      slug: 'platform',
      name: 'Platform',
      settings: JSON.stringify({ imports: ['blog-de'] }),
    })
    platformId = platform!.id
    const [blog] = await db.insert<{ id: string }>('wk_spaces', { slug: 'blog-de', name: 'Blog DE' })
    blogId = blog!.id
    await approveConcept(blogId, 'house-style', '# House Style\n\nDie Stilregeln für Blogartikel.')
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('a qualified relation stages, approves, and reads back with provenance', async () => {
    await approveConcept(platformId, 'publishing', '# Publishing\n\nVerweist auf [[blog-de:house-style]].', [
      { to_slug: 'blog-de:house-style', kind: 'related' },
    ])
    const concept = await getConcept(db, platformId, { slug: 'publishing' })
    expect(concept.relations).toEqual([{ to_slug: 'house-style', kind: 'related', space: 'blog-de' }])

    const { rows } = await db.query(
      `SELECT 1 FROM wk_relations WHERE space_id = $1 AND to_space_id = $2 AND status = 'active'`,
      [platformId, blogId],
    )
    expect(rows.length).toBe(1)
  })

  it('an undeclared target space 400s; a missing foreign concept 400s; nothing is created abroad', async () => {
    await expect(
      createProposal(db, platformId, {
        title: 'Bad import',
        input_hash: hex64(),
        agent_meta: { model: 'manual', prompt_version: 'manual' },
        concepts: [
          {
            slug: 'bad-a',
            title: 'A',
            markdown: '# a',
            relations: [{ to_slug: 'ghost-space:anything', kind: 'related' }],
          },
        ],
      }),
    ).rejects.toThrow('not declared in settings.imports')

    await expect(
      createProposal(db, platformId, {
        title: 'Missing target',
        input_hash: hex64(),
        agent_meta: { model: 'manual', prompt_version: 'manual' },
        concepts: [
          {
            slug: 'bad-b',
            title: 'B',
            markdown: '# b',
            relations: [{ to_slug: 'blog-de:never-written', kind: 'related' }],
          },
        ],
      }),
    ).rejects.toThrow('does not exist as a readable concept')

    // No placeholder concept was invented in the foreign space.
    const { rows } = await db.query(`SELECT 1 FROM wk_concepts WHERE space_id = $1 AND slug = 'never-written'`, [
      blogId,
    ])
    expect(rows.length).toBe(0)
  })

  it('multi-space search tags every hit with its origin space, approved tier first', async () => {
    const [platform] = await db.select<{ id: string; slug: string; settings: Record<string, unknown> }>('wk_spaces', {
      id: `eq.${platformId}`,
    })
    const result = await searchAcrossImports(db, platform!, { q: 'Stilregeln' })
    expect(result.searched_spaces).toEqual(['platform', 'blog-de'])
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
    expect(result.hits[0]!.space).toBe('blog-de')
    expect(result.hits[0]!.slug).toBe('house-style')
  })

  it('the lint rule flags dangling and undeclared [[space:slug]] links', async () => {
    await approveConcept(platformId, 'linked-notes', '# Notes\n\nSee [[blog-de:missing-page]] and [[nowhere:thing]].')
    const report = await lintSpace(db, platformId)
    const findings = report.findings.filter((finding) => finding.rule === 'broken-cross-space-links')
    const messages = findings.map((finding) => finding.message).join('\n')
    expect(messages).toContain('blog-de:missing-page')
    expect(messages).toContain('not declared in settings.imports')
    // The VALID link from the first test produces no finding.
    expect(messages).not.toContain('blog-de:house-style')
  })

  it('no knowledge is copied: the foreign space holds exactly its own concepts', async () => {
    const { rows } = await db.query<{ slug: string }>(`SELECT slug FROM wk_concepts WHERE space_id = $1`, [blogId])
    expect(rows.map((row) => row.slug)).toEqual(['house-style'])
  })
})
