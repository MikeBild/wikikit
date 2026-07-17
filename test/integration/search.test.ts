// wk_search visibility contract against a real Docker Postgres: proposed
// content is invisible BY CONSTRUCTION (the join goes through
// wk_concepts.current_revision_id and visible claim statuses only).
// Gated behind RUN_INTEGRATION=1; scripts/start-local.ts provisions the container.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

interface SearchHit {
  kind: string
  concept_slug: string
  claim_id: string | null
  title: string
  headline: string
  rank: number
}

let database: Database
let db: Db
let spaceId = ''
let proposalId = ''

// One staged proposal: a concept revision about "quantum teleportation
// protocols" plus a claim — distinctive tokens that cannot collide with
// anything else in the fixture.
async function stageFixture(): Promise<void> {
  await db.tx(async (tx) => {
    const [space] = await tx.insert<{ id: string }>('wk_spaces', { slug: 'search-space', name: 'Search' })
    spaceId = space!.id
    const [proposal] = await tx.insert<{ id: string }>('wk_change_proposals', {
      space_id: spaceId,
      title: 'Add teleportation concept',
      input_hash: randomUUID(),
    })
    proposalId = proposal!.id
    const [concept] = await tx.insert<{ id: string }>('wk_concepts', {
      space_id: spaceId,
      slug: 'quantum-teleportation',
      title: 'Teleportation',
    })
    await tx.insert(
      'wk_concept_revisions',
      {
        space_id: spaceId,
        concept_id: concept!.id,
        rev: 1,
        status: 'proposed',
        title: 'Quantum Teleportation',
        summary: 'Protocols for quantum state transfer.',
        markdown: '---\ninternal: frontmatter-secret\n---\n# Quantum Teleportation\n\nEntanglement-based protocols.',
        base_revision_id: null,
        proposal_id: proposalId,
      },
      { returning: false },
    )
    await tx.insert(
      'wk_claims',
      {
        space_id: spaceId,
        concept_id: concept!.id,
        subject: 'teleportation',
        predicate: 'requires',
        object: 'entanglement fidelity',
        status: 'proposed',
        proposal_id: proposalId,
      },
      { returning: false },
    )
  })
}

async function search(query: string, kind: string | null = null, limit = 20): Promise<SearchHit[]> {
  return db.call<SearchHit>('wk_search', [spaceId, query, kind, limit])
}

describe('wk_search (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_search')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
    await stageFixture()
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('proposed content is invisible — revisions AND claims', async () => {
    expect(await search('teleportation')).toEqual([])
    expect(await search('entanglement')).toEqual([])
  })

  it('approval makes the current revision and verified claim searchable', async () => {
    await db.call('wk_apply_proposal', [proposalId, 'mike'])

    const conceptHits = await search('teleportation', 'concept')
    expect(conceptHits.length).toBe(1)
    expect(conceptHits[0]!).toMatchObject({ kind: 'concept', concept_slug: 'quantum-teleportation', claim_id: null })
    expect(conceptHits[0]!.title).toBe('Quantum Teleportation')
    expect(conceptHits[0]!.headline).toContain('<mark>')
    expect(conceptHits[0]!.rank).toBeGreaterThan(0)

    const claimHits = await search('fidelity', 'claim')
    expect(claimHits.length).toBe(1)
    expect(claimHits[0]!.kind).toBe('claim')
    expect(claimHits[0]!.claim_id).toBeTruthy()
    expect(claimHits[0]!.concept_slug).toBe('quantum-teleportation')
  })

  it('kind filter partitions concept vs claim hits; NULL returns both', async () => {
    const both = await search('teleportation entanglement')
    expect(new Set(both.map((hit) => hit.kind))).toEqual(new Set(['concept', 'claim']))
    expect((await search('entanglement', 'concept')).every((hit) => hit.kind === 'concept')).toBe(true)
    expect((await search('entanglement', 'claim')).every((hit) => hit.kind === 'claim')).toBe(true)
  })

  it('finds an exact hyphenated concept slug even when websearch parses hyphens as operators', async () => {
    const hits = await search('quantum-teleportation', 'concept')
    expect(hits[0]).toMatchObject({ concept_slug: 'quantum-teleportation', rank: 10 })
  })

  it('frontmatter is stripped from the index — metadata never matches', async () => {
    expect(await search('frontmatter-secret')).toEqual([])
  })

  it('a follow-up proposed revision stays invisible while the current one still matches', async () => {
    const [concept] = await db.select<{ id: string; current_revision_id: string }>('wk_concepts', {
      space_id: `eq.${spaceId}`,
      slug: 'eq.quantum-teleportation',
    })
    const [proposal] = await db.insert<{ id: string }>('wk_change_proposals', {
      space_id: spaceId,
      title: 'Follow-up',
      input_hash: randomUUID(),
    })
    await db.insert(
      'wk_concept_revisions',
      {
        space_id: spaceId,
        concept_id: concept!.id,
        rev: 2,
        status: 'proposed',
        title: 'Wormhole Shortcuts',
        summary: 'Entirely different proposed text.',
        markdown: '# Wormhole Shortcuts\n\nSuperluminal detours.',
        base_revision_id: concept!.current_revision_id,
        proposal_id: proposal!.id,
      },
      { returning: false },
    )

    expect(await search('wormhole')).toEqual([])
    expect((await search('teleportation', 'concept')).length).toBe(1)
  })

  it('respects the limit parameter', async () => {
    const hits = await search('teleportation entanglement', null, 1)
    expect(hits.length).toBe(1)
  })
})
