// The evidence-tier filters against real Postgres (migration 0040).
//
// Two claims a stub cannot make, and one regression a stub cannot see.
//
//   * `evidence_from` and `evidence_source_kind` actually EXCLUDE — the age
//     window against wk_sources.created_at, the kind against the
//     metadata->>'source_kind' a client declared. A source that declared no
//     kind is excluded by a kind filter, which is the honest limit of the
//     feature and is documented as one rather than papered over.
//   * The APPROVED tier answers identically with the filters set and unset.
//     That is the whole design decision: the two tiers share neither a clock
//     nor a kind alphabet, so a filter that reached approved knowledge would
//     be answering a question nobody can put to it.
//   * The HYBRID arm returns a FULL page under a filter. Both arms of the RRF
//     fusion take p_limit * 4 candidates before fusing; filtering after the
//     fusion would fuse over unfiltered candidates and hand back a page far
//     shorter than the limit — with matching rows sitting one rank below the
//     cut, invisible and unreachable. The fixture below is built so that a
//     post-fusion filter returns an EMPTY page and the pushdown returns a full
//     one, which is the only way to tell the two implementations apart from
//     the outside.
//
// RUN_INTEGRATION=1 gated; the hybrid case additionally skips without pgvector.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { BUILT_IN_SCAFFOLDING_KINDS } from '../../src/domain/concepts.ts'
import { persistSourceChunks } from '../../src/domain/sources.ts'
import { createEmbedder, probeVectorSupport } from '../../src/ingest/embedder.ts'
import { search, type SearchHit } from '../../src/query/search.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(180_000)

let database: Database
let db: Db
let spaceId = ''
let vectorAvailable = false
const llm = createFakeProvider()
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as never

/** The one token every fixture matches on. */
const QUERY = 'thermostat'

const DAY_MS = 24 * 60 * 60 * 1000
const HYBRID_LIMIT = 5

/** Archive one source with an explicit age and (optionally) a declared kind. */
async function archive(options: {
  title: string
  ageDays: number
  sourceKind?: 'meeting' | 'article' | 'note'
  /** How often the query token appears — the lexical rank lever. */
  repeats: number
}): Promise<string> {
  const body = `# ${options.title}\n\n${`The ${QUERY} was discussed. `.repeat(options.repeats)}`
  const [source] = await db.insert<{ id: string; markdown: string }>('wk_sources', {
    space_id: spaceId,
    content_hash: randomUUID().replaceAll('-', ''),
    kind: 'markdown',
    title: options.title,
    raw_content: body,
    markdown: body,
    // Written rather than aged: the window is over created_at, and a test that
    // could only observe "now" could not observe a window at all.
    created_at: new Date(Date.now() - options.ageDays * DAY_MS).toISOString(),
    metadata: JSON.stringify(options.sourceKind ? { source_kind: options.sourceKind } : {}),
  })
  await persistSourceChunks(db, spaceId, source!)
  return source!.id
}

function evidence(hits: SearchHit[]): SearchHit[] {
  return hits.filter((hit) => hit.tier === 'source_evidence')
}

function approved(hits: SearchHit[]): SearchHit[] {
  return hits.filter((hit) => hit.tier === 'approved')
}

async function titlesOf(hits: SearchHit[]): Promise<string[]> {
  return evidence(hits)
    .map((hit) => hit.title)
    .sort()
}

describe('evidence-tier filters (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_evidence_filters')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
    vectorAvailable = await probeVectorSupport(db)

    const [space] = await db.insert<{ id: string }>('wk_spaces', { slug: 'evidence-filters', name: 'Evidence' })
    spaceId = space!.id

    // One approved page matching the same token: the control for the claim
    // that filtering the evidence tier leaves approved knowledge alone.
    const [proposal] = await db.insert<{ id: string }>('wk_change_proposals', {
      space_id: spaceId,
      title: 'Thermostat page',
      input_hash: randomUUID(),
    })
    const [concept] = await db.insert<{ id: string }>('wk_concepts', {
      space_id: spaceId,
      slug: 'thermostat',
      title: 'Thermostat',
    })
    await db.insert(
      'wk_concept_revisions',
      {
        space_id: spaceId,
        concept_id: concept!.id,
        rev: 1,
        status: 'proposed',
        title: 'Thermostat',
        summary: `What this wiki knows about the ${QUERY}.`,
        markdown: `# Thermostat\n\nThe ${QUERY} reports its firmware on boot.`,
        base_revision_id: null,
        proposal_id: proposal!.id,
      },
      { returning: false },
    )
    await db.call('wk_apply_proposal', [proposal!.id, 'evidence-filters-test'])

    // Four named sources for the exclusion cases: two ages × declared kind,
    // plus one that never declared a kind at all.
    await archive({ title: 'Fresh meeting', ageDays: 1, sourceKind: 'meeting', repeats: 3 })
    await archive({ title: 'Old meeting', ageDays: 400, sourceKind: 'meeting', repeats: 3 })
    await archive({ title: 'Fresh article', ageDays: 1, sourceKind: 'article', repeats: 3 })
    await archive({ title: 'Fresh unlabelled', ageDays: 1, repeats: 3 })

    // The starvation fixture, first half: twenty-four notes that shout the
    // token forty times each, so they outrank every meeting lexically and fill
    // all twenty pre-fusion candidate slots at HYBRID_LIMIT = 5.
    for (let index = 0; index < 24; index++) {
      await archive({ title: `Loud note ${index}`, ageDays: 2, sourceKind: 'note', repeats: 40 })
    }

    // The embedder runs HERE, between the two halves, and that is what makes
    // the regression deterministic rather than statistical: the six meetings
    // below stay unembedded, so the vector arm cannot reach them either. A
    // post-fusion filter therefore has NO meeting to keep and returns an empty
    // page; the pushdown filters each arm first and returns a full one. (A
    // partly-embedded corpus is a supported state — 0018 fuses with coalesce
    // precisely so a backfill in progress still ranks correctly.)
    if (vectorAvailable) {
      await createEmbedder(db, llm, { modelEmbedding: 'fake-embed' } as Config, silentLogger).runOnce()
    }

    for (let index = 0; index < 6; index++) {
      await archive({ title: `Quiet meeting ${index}`, ageDays: 2, sourceKind: 'meeting', repeats: 1 })
    }
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  const lexical = { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS }

  it('the age window excludes what arrived before it', async () => {
    const since = new Date(Date.now() - 30 * DAY_MS).toISOString()
    const hits = await search(
      db,
      spaceId,
      { q: QUERY, mode: 'approved_then_sources', limit: 50, evidence_source_kind: 'meeting' },
      lexical,
    )
    expect(await titlesOf(hits)).toContain('Old meeting')

    const windowed = await search(
      db,
      spaceId,
      { q: QUERY, mode: 'approved_then_sources', limit: 50, evidence_source_kind: 'meeting', evidence_from: since },
      lexical,
    )
    const titles = await titlesOf(windowed)
    expect(titles).toContain('Fresh meeting')
    expect(titles).not.toContain('Old meeting')
  })

  it('the kind filter excludes other kinds AND everything that declared none', async () => {
    const hits = await search(
      db,
      spaceId,
      { q: QUERY, mode: 'approved_then_sources', limit: 50, evidence_source_kind: 'article' },
      lexical,
    )
    const titles = await titlesOf(hits)
    expect(titles).toContain('Fresh article')
    expect(titles).not.toContain('Fresh meeting')
    // The honest limit, held as a fact rather than a footnote: source_kind is
    // present only where a client supplied it, so a kind filter is an
    // exclusion and not a classification.
    expect(titles).not.toContain('Fresh unlabelled')
  })

  it('leaves the approved tier untouched — same hits, filtered or not', async () => {
    const plain = await search(db, spaceId, { q: QUERY, mode: 'approved_then_sources', limit: 50 }, lexical)
    const filtered = await search(
      db,
      spaceId,
      {
        q: QUERY,
        mode: 'approved_then_sources',
        limit: 50,
        evidence_from: new Date(Date.now() - 1 * DAY_MS).toISOString(),
        evidence_source_kind: 'meeting',
      },
      lexical,
    )
    expect(approved(filtered)).toEqual(approved(plain))
    expect(approved(filtered).length).toBeGreaterThan(0)
    // …while the evidence tier genuinely moved, so the equality above is a
    // statement about the tiers and not about a filter that did nothing.
    expect(evidence(filtered).length).toBeLessThan(evidence(plain).length)
  })

  it('the hybrid arm returns a FULL page under a filter (CTE pushdown regression)', async () => {
    if (!vectorAvailable) return
    const deps = { llm, vector: { available: true }, scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS }
    const hits = await search(
      db,
      spaceId,
      { q: QUERY, mode: 'approved_then_sources', limit: HYBRID_LIMIT, evidence_source_kind: 'meeting' },
      deps,
    )
    const found = evidence(hits)
    // Six meetings exist and five were asked for. A page shorter than this is
    // the fusion-then-filter defect, which is invisible to any stub.
    expect(found.length).toBe(HYBRID_LIMIT)
    for (const hit of found) expect(hit.title).toMatch(/meeting/i)
  })
})
