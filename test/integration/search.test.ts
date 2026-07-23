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

// File-level setup: both describes below share the database; the pool closes
// once after ALL suites (a describe-scoped afterAll would close it before the
// second describe runs).
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

describe('wk_search (integration)', () => {
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

  it('trigram fallback finds a typo’d concept slug (no tsquery match required)', async () => {
    const hits = await search('quantum-telepotation', 'concept')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.concept_slug).toBe('quantum-teleportation')
  })
})

describe('per-space language + wk_reindex_space (integration)', () => {
  let germanSpaceId = ''

  beforeAll(async () => {
    if (!integration) return
    // Created WITHOUT a language — vectors are built under wk_english first,
    // so the reindex test below proves the language flip re-stems in place.
    await db.tx(async (tx) => {
      const [space] = await tx.insert<{ id: string }>('wk_spaces', { slug: 'search-space-de', name: 'Suche' })
      germanSpaceId = space!.id
      const [proposal] = await tx.insert<{ id: string }>('wk_change_proposals', {
        space_id: germanSpaceId,
        title: 'Deutsche Inhalte',
        input_hash: randomUUID(),
      })
      const [concept] = await tx.insert<{ id: string }>('wk_concepts', {
        space_id: germanSpaceId,
        slug: 'zugriffsverwaltung',
        title: 'Zugriffsverwaltung',
      })
      await tx.insert(
        'wk_concept_revisions',
        {
          space_id: germanSpaceId,
          concept_id: concept!.id,
          rev: 1,
          status: 'proposed',
          title: 'Zugriffsverwaltung',
          summary: 'Verwaltung der Zugriffsschlüssel in der Lieferstraße.',
          markdown: '# Zugriffsverwaltung\n\nDie Häuser der Verwaltung liegen in der Lieferstraße.',
          base_revision_id: null,
          proposal_id: proposal!.id,
        },
        { returning: false },
      )
      await tx.call('wk_apply_proposal', [proposal!.id, 'mike'])
    })
  })

  async function searchDe(query: string): Promise<SearchHit[]> {
    return db.call<SearchHit>('wk_search', [germanSpaceId, query, 'concept', 20])
  }

  it('umlaut-plural queries miss under the english default, hit after the language flip + reindex', async () => {
    // english config: 'Häusern' does not stem to the indexed 'Häuser'.
    expect(await searchDe('Verwaltung der Häusern')).toEqual([])

    await db.update('wk_spaces', { id: `eq.${germanSpaceId}` }, { settings: JSON.stringify({ language: 'de' }) })
    const [result] = await db.call<{ revisions: number; claims: number }>('wk_reindex_space', [germanSpaceId])
    expect(Number(result!.revisions)).toBe(1)

    const hits = await searchDe('Verwaltung der Häusern')
    expect(hits.length).toBe(1)
    expect(hits[0]!.concept_slug).toBe('zugriffsverwaltung')
  })

  it('unaccent matches a query typed without the sharp s', async () => {
    const hits = await searchDe('lieferstrasse')
    expect(hits.length).toBe(1)
  })

  it('german umlaut stopwords are stripped from the query (für ≠ content term)', async () => {
    // 'für' appears nowhere in the fixture; without the wk_search_tsquery
    // repair the surviving 'fur' lexeme would AND-fail this query.
    const hits = await searchDe('Verwaltung für Häuser')
    expect(hits.length).toBe(1)
  })

  it('source chunks: persisted, searchable via wk_search_sources, citable into a proposal', async () => {
    const markdown = '# Rollout-Plan\n\n## Termine\n\nDer Rollout wurde auf das dritte Quartal verschoben.'
    const { createSource, persistSourceChunks } = await import('../../src/domain/sources.ts')
    const { createProposal } = await import('../../src/domain/proposals.ts')
    const { source } = await createSource(db, germanSpaceId, {
      kind: 'markdown',
      title: 'Rollout-Notizen',
      raw: markdown,
      markdown,
      language: 'de',
    })
    expect(await persistSourceChunks(db, germanSpaceId, source)).toBeGreaterThan(0)
    // Idempotent on re-run (reuse/backfill path).
    expect(await persistSourceChunks(db, germanSpaceId, source)).toBe(0)

    // German stemming applies to chunk vectors (verschoben ↔ verschoben; plural Termine ↔ Termin).
    const chunkHits = await db.call<{ chunk_id: string; source_id: string; headline: string }>('wk_search_sources', [
      germanSpaceId,
      'Rollout verschoben',
    ])
    expect(chunkHits.length).toBeGreaterThanOrEqual(1)
    expect(chunkHits[0]!.source_id).toBe(source.id)
    expect(chunkHits[0]!.headline).toContain('<mark>')

    // Chunk → ChangeProposal: the chunk id resolves to {source_id, verbatim quote}.
    const { proposal_id } = await createProposal(db, germanSpaceId, {
      title: 'Rollout-Termin festhalten',
      input_hash: 'a'.repeat(64),
      concepts: [
        {
          slug: 'rollout-plan',
          title: 'Rollout-Plan',
          markdown: '# Rollout-Plan\n\nVerschoben auf Q3.',
          claims: [
            {
              subject: 'rollout-plan',
              predicate: 'verschoben auf',
              object: 'Q3',
              citations: [{ chunk_id: chunkHits[0]!.chunk_id }],
            },
          ],
        },
      ],
    })
    const { rows: citations } = await db.query<{ source_id: string; quote: string; locator: string }>(
      `SELECT c.source_id, c.quote, c.locator
         FROM wk_citations c
         JOIN wk_claims cl ON cl.id = c.claim_id
        WHERE cl.proposal_id = $1`,
      [proposal_id],
    )
    expect(citations).toHaveLength(1)
    expect(citations[0]!.source_id).toBe(source.id)
    // Verbatim slice of the archived markdown — the citation contract.
    expect(markdown).toContain(citations[0]!.quote.split('\n').at(-1)!)
    expect(citations[0]!.locator).toBe(`chunk:${chunkHits[0]!.chunk_id}`)
  })

  it('wk_sources.language accepts the allowed values and rejects others', async () => {
    const [source] = await db.insert<{ id: string; language: string }>('wk_sources', {
      space_id: germanSpaceId,
      content_hash: randomUUID().replaceAll('-', ''),
      kind: 'markdown',
      raw_content: '# Quelle',
      markdown: '# Quelle',
      language: 'de',
    })
    expect(source!.language).toBe('de')
    await expect(
      db.insert('wk_sources', {
        space_id: germanSpaceId,
        content_hash: randomUUID().replaceAll('-', ''),
        kind: 'markdown',
        raw_content: '# Quelle 2',
        markdown: '# Quelle 2',
        language: 'fr',
      }),
    ).rejects.toThrow()
  })
})
