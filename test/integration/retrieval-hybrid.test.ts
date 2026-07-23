// Hybrid retrieval against real Postgres + pgvector: the embedder worker
// fills wk_embeddings from the deterministic FakeProvider, the hybrid RPCs
// fuse lexical + vector arms via RRF, and — the invariant that matters —
// proposed content stays invisible in the VECTOR arm too, by construction.
// Gated behind RUN_INTEGRATION=1; skips gracefully on a non-pgvector server.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createEmbedder, probeVectorSupport } from '../../src/ingest/embedder.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { persistSourceChunks } from '../../src/domain/sources.ts'
import { search } from '../../src/query/search.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db
let spaceId = ''
let vectorAvailable = false
const llm = createFakeProvider()
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as never

async function seed(): Promise<void> {
  await db.tx(async (tx) => {
    const [space] = await tx.insert<{ id: string }>('wk_spaces', { slug: 'hybrid-space', name: 'Hybrid' })
    spaceId = space!.id
    const [proposal] = await tx.insert<{ id: string }>('wk_change_proposals', {
      space_id: spaceId,
      title: 'Approved content',
      input_hash: randomUUID(),
    })
    const [concept] = await tx.insert<{ id: string }>('wk_concepts', {
      space_id: spaceId,
      slug: 'delivery-pipeline',
      title: 'Delivery Pipeline',
    })
    await tx.insert(
      'wk_concept_revisions',
      {
        space_id: spaceId,
        concept_id: concept!.id,
        rev: 1,
        status: 'proposed',
        title: 'Delivery Pipeline',
        summary: 'Stages, retries and rollbacks of the delivery pipeline.',
        markdown: '# Delivery Pipeline\n\nDeployments run in stages with automated rollback.',
        base_revision_id: null,
        proposal_id: proposal!.id,
      },
      { returning: false },
    )
    await tx.insert(
      'wk_claims',
      {
        space_id: spaceId,
        concept_id: concept!.id,
        subject: 'delivery-pipeline',
        predicate: 'supports',
        object: 'automated rollback',
        status: 'proposed',
        proposal_id: proposal!.id,
      },
      { returning: false },
    )
    await tx.call('wk_apply_proposal', [proposal!.id, 'hybrid-test'])

    // A second, never-approved proposal: must stay invisible in EVERY arm.
    const [ghostProposal] = await tx.insert<{ id: string }>('wk_change_proposals', {
      space_id: spaceId,
      title: 'Proposed only',
      input_hash: randomUUID(),
    })
    const [ghost] = await tx.insert<{ id: string }>('wk_concepts', {
      space_id: spaceId,
      slug: 'ghost-topic',
      title: 'Ghost Topic',
    })
    await tx.insert(
      'wk_concept_revisions',
      {
        space_id: spaceId,
        concept_id: ghost!.id,
        rev: 1,
        status: 'proposed',
        title: 'Ghost Topic',
        summary: 'Unapproved wormhole content.',
        markdown: '# Ghost\n\nWormhole shortcuts for deliveries.',
        base_revision_id: null,
        proposal_id: ghostProposal!.id,
      },
      { returning: false },
    )
  })

  const [source] = await db.insert<{ id: string; markdown: string }>('wk_sources', {
    space_id: spaceId,
    content_hash: randomUUID().replaceAll('-', ''),
    kind: 'markdown',
    title: 'Ops notes',
    raw_content: '# Ops\n\nThe rollout was postponed to the third quarter.',
    markdown: '# Ops\n\nThe rollout was postponed to the third quarter.',
  })
  await persistSourceChunks(db, spaceId, source!)
}

describe('hybrid retrieval (integration, pgvector)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_hybrid')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
    vectorAvailable = await probeVectorSupport(db)
    if (!vectorAvailable) return
    await seed()
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('the embedder fills wk_embeddings for current revisions, visible claims and chunks — and audits per batch', async () => {
    if (!vectorAvailable) return
    const embedder = createEmbedder(db, llm, { modelEmbedding: 'fake-embed' } as Config, silentLogger)
    const seen = await embedder.runOnce()
    expect(seen).toBeGreaterThanOrEqual(3)
    // A second pass is a no-op: presence of the rows is the done-marker.
    expect(await embedder.runOnce()).toBe(0)

    const { rows: kinds } = await db.query<{ object_kind: string; n: string }>(
      `SELECT object_kind, count(*) AS n FROM wk_embeddings WHERE space_id = $1 GROUP BY object_kind`,
      [spaceId],
    )
    const byKind = Object.fromEntries(kinds.map((row) => [row.object_kind, Number(row.n)]))
    expect(byKind.revision).toBe(1) // ONLY the current revision — the ghost stays unembedded
    expect(byKind.claim).toBe(1)
    expect(byKind.source_chunk).toBeGreaterThanOrEqual(1)

    const { rows: runs } = await db.query(
      `SELECT 1 FROM wk_agent_runs WHERE space_id = $1 AND kind = 'embed' AND prompt_version = 'embed.v1'`,
      [spaceId],
    )
    expect(runs.length).toBeGreaterThanOrEqual(1)
  })

  it('hybrid search fuses both arms, labels matched_via, and never surfaces proposed content', async () => {
    if (!vectorAvailable) return
    const deps = { llm, vector: { available: true } }
    const hits = await search(db, spaceId, { q: 'delivery rollback', mode: 'approved_then_sources' }, deps)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.slug).toBe('delivery-pipeline')
    expect(['lexical', 'vector', 'both']).toContain(hits[0]!.matched_via!)
    // Tier order survives fusion.
    const tiers = hits.map((hit) => hit.tier)
    expect(tiers.indexOf('source_evidence')).toBeGreaterThanOrEqual(tiers.lastIndexOf('approved'))
    // The proposed-only concept is invisible in every arm — even for a query
    // that matches it lexically and has a (ghost) embedding candidate.
    const ghost = await search(db, spaceId, { q: 'wormhole shortcuts' }, deps)
    expect(ghost.filter((hit) => hit.slug === 'ghost-topic')).toEqual([])
  })

  it('a vector-only match surfaces through the vector arm (no lexical overlap required)', async () => {
    if (!vectorAvailable) return
    // The fake embedder is content-hash-based, so a semantically 'related'
    // query has no special similarity — instead prove the arm works by
    // querying with a term absent from every document; lexical arm returns
    // nothing, vector arm still ranks SOMETHING (nearest neighbors exist).
    const deps = { llm, vector: { available: true } }
    const hits = await search(db, spaceId, { q: 'zzz-no-lexical-match-zzz' }, deps)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.every((hit) => hit.matched_via === 'vector')).toBe(true)
  })
})
