// Domain modules end-to-end against a real Docker Postgres: the full
// stage → review → read loop plus lint, exactly as REST/MCP will drive it.
// Gated behind RUN_INTEGRATION=1; scripts/start-local.ts provisions the container.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { getConcept, getConceptHistory, getConceptIndex, listConcepts } from '../../src/domain/concepts.ts'
import { getDecision, listDecisions } from '../../src/domain/decisions.ts'
import { ConflictError, NotFoundError } from '../../src/domain/errors.ts'
import { lintSpace } from '../../src/domain/lint.ts'
import {
  approveProposal,
  computeInputHash,
  createProposal,
  getProposal,
  rejectProposal,
  renderProposalMarkdown,
} from '../../src/domain/proposals.ts'
import { listRelations } from '../../src/domain/relations.ts'
import { createSource, getSource, listSources, sha256Hex } from '../../src/domain/sources.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db

async function seedSpace(slug: string, settings: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
  const rows = await db.insert<{ id: string; slug: string }>('wk_spaces', {
    slug,
    name: `Space ${slug}`,
    settings,
  })
  return rows[0]!
}

const AGENT_META = { model: 'manual', prompt_version: 'manual' }

describe('domain modules (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_domain')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('sources: sha256 idempotency, keyset paging and space isolation', async () => {
    const space = await seedSpace('src-space')
    const other = await seedSpace('src-other')

    const first = await createSource(db, space.id, { kind: 'markdown', raw: '# One', markdown: '# One' })
    expect(first.created).toBe(true)
    expect(first.source.content_hash).toBe(sha256Hex('# One'))

    // Same content, same space → the SAME row, no duplicate.
    const again = await createSource(db, space.id, { kind: 'markdown', raw: '# One', markdown: '# One' })
    expect(again.created).toBe(false)
    expect(again.source.id).toBe(first.source.id)

    // Same content in ANOTHER space is a fresh archive (hash is space-scoped).
    const elsewhere = await createSource(db, other.id, { kind: 'markdown', raw: '# One', markdown: '# One' })
    expect(elsewhere.created).toBe(true)
    expect(elsewhere.source.id).not.toBe(first.source.id)

    await createSource(db, space.id, { kind: 'text', raw: 'Two', markdown: 'Two' })
    await createSource(db, space.id, { kind: 'text', raw: 'Three', markdown: 'Three' })

    const page1 = await listSources(db, space.id, { limit: 2 })
    expect(page1.items.length).toBe(2)
    expect(page1.next_before).not.toBeNull()
    const page2 = await listSources(db, space.id, { limit: 2, before: page1.next_before! })
    expect(page2.items.length).toBe(1)
    expect(page2.next_before).toBeNull()
    const ids = [...page1.items, ...page2.items].map((item) => item.id)
    expect(new Set(ids).size).toBe(3)

    // Cross-space reads 404 even with a valid id.
    await expect(getSource(db, other.id, { id: first.source.id })).rejects.toBeInstanceOf(NotFoundError)
    expect((await getSource(db, space.id, { id: first.source.id })).raw_content).toBe('# One')
  })

  it('proposal loop: staged content is invisible, approval makes it readable with full provenance', async () => {
    const space = await seedSpace('loop-space')
    const { source } = await createSource(db, space.id, {
      kind: 'markdown',
      raw: '# OKF notes',
      markdown: '# OKF notes',
      title: 'OKF notes',
    })

    const created = await createProposal(db, space.id, {
      title: 'Introduce okf',
      summary: 'First knowledge about OKF',
      input_hash: computeInputHash([source.content_hash], 'synthesize.v1'),
      source_ids: [source.id],
      agent_meta: AGENT_META,
      concepts: [
        {
          slug: 'okf',
          title: 'Open Knowledge Format',
          summary: 'A knowledge bundle spec',
          markdown: '# Open Knowledge Format\n\nA spec.',
          claims: [
            {
              subject: 'okf',
              predicate: 'has_status',
              object: 'draft-v0.1',
              confidence: 0.9,
              citations: [{ source_id: source.id, quote: 'OKF notes', locator: 'heading: 1' }],
            },
          ],
          relations: [{ to_slug: 'graph-store', kind: 'related' }],
        },
      ],
    })
    expect(created.status).toBe('pending')

    // Staged = invisible: no readable concepts, reads 404, index empty.
    expect((await listConcepts(db, space.id, {})).items).toEqual([])
    await expect(getConcept(db, space.id, { slug: 'okf' })).rejects.toBeInstanceOf(NotFoundError)
    expect(await getConceptIndex(db, space.id)).toEqual([])

    // ...but the diff shows everything the reviewer needs.
    const detail = await getProposal(db, { id: created.proposal_id })
    expect(detail.space).toBe('loop-space')
    expect(detail.space_id).toBe(space.id)
    // Only 'okf' carries a revision — the relation target 'graph-store' exists as
    // an identity row but is not part of the diff.
    expect(detail.concepts.map((concept) => concept.slug)).toEqual(['okf'])
    const okfDiff = detail.concepts.find((concept) => concept.slug === 'okf')!
    expect(okfDiff.is_new).toBe(true)
    expect(okfDiff.old_markdown).toBeNull()
    expect(okfDiff.claims_added.length).toBe(1)
    expect(okfDiff.relations_added).toEqual([{ to_slug: 'graph-store', kind: 'related' }])
    expect(renderProposalMarkdown(detail)).toContain('## Concept `okf` — new')

    // Idempotent convergence on input_hash while pending.
    const duplicate = await createProposal(db, space.id, {
      title: 'Introduce okf again',
      input_hash: computeInputHash([source.content_hash], 'synthesize.v1'),
      source_ids: [source.id],
      agent_meta: AGENT_META,
      concepts: [{ slug: 'okf', title: 'x', summary: '', markdown: '# x', claims: [], relations: [] }],
    })
    expect(duplicate.proposal_id).toBe(created.proposal_id)

    const applied = await approveProposal(db, { id: created.proposal_id, reviewer: 'mike', note: 'first knowledge' })
    expect(applied.status).toBe('approved')
    expect(applied.concepts).toEqual(['okf'])
    expect(applied.claims_verified).toBe(1)

    // Now readable, claims + citations + relations assembled.
    const concept = await getConcept(db, space.id, { slug: 'okf' })
    expect(concept.rev).toBe(1)
    expect(concept.claims.length).toBe(1)
    expect(concept.claims[0]).toMatchObject({ status: 'verified', object: 'draft-v0.1' })
    expect(concept.claims[0]!.citations[0]).toMatchObject({ source_id: source.id, locator: 'heading: 1' })
    expect(concept.relations).toEqual([{ to_slug: 'graph-store', kind: 'related' }])

    // The relation target 'graph-store' has NO revision — it stays unreadable
    // (identity row only) and shows up in lint as a broken relation.
    await expect(getConcept(db, space.id, { slug: 'graph-store' })).rejects.toBeInstanceOf(NotFoundError)

    const listed = await listConcepts(db, space.id, {})
    expect(listed.items.map((item) => item.slug)).toEqual(['okf'])
    expect(listed.epoch).toBe(1)

    const history = await getConceptHistory(db, space.id, { slug: 'okf' })
    expect(history.length).toBe(1)
    expect(history[0]).toMatchObject({
      rev: 1,
      status: 'current',
      agent_meta: AGENT_META,
      proposal_id: created.proposal_id,
    })

    // Double review is refused.
    await expect(approveProposal(db, { id: created.proposal_id, reviewer: 'mike' })).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('contradiction flow: prospective dispute in the pending diff, real dispute after approval, lint reports it', async () => {
    const space = await seedSpace('dispute-space', { functional_predicates: ['has_status'] })
    const sourceA = await createSource(db, space.id, { kind: 'text', raw: 'A says ready', markdown: 'A says ready' })
    const first = await createProposal(db, space.id, {
      title: 'A',
      input_hash: computeInputHash([sourceA.source.content_hash], 'synthesize.v1'),
      source_ids: [sourceA.source.id],
      agent_meta: AGENT_META,
      concepts: [
        {
          slug: 'okf',
          title: 'OKF',
          summary: '',
          markdown: '# OKF',
          claims: [
            {
              subject: 'okf',
              predicate: 'has_status',
              object: 'production-ready',
              confidence: 0.8,
              citations: [{ source_id: sourceA.source.id, quote: 'A says ready' }],
            },
          ],
          relations: [],
        },
      ],
    })
    await approveProposal(db, { id: first.proposal_id, reviewer: 'mike' })

    const sourceB = await createSource(db, space.id, { kind: 'text', raw: 'B says draft', markdown: 'B says draft' })
    const second = await createProposal(db, space.id, {
      title: 'B',
      input_hash: computeInputHash([sourceB.source.content_hash], 'synthesize.v1'),
      source_ids: [sourceB.source.id],
      agent_meta: AGENT_META,
      concepts: [
        {
          slug: 'okf-review',
          title: 'OKF Review',
          summary: '',
          markdown: '# OKF Review',
          claims: [
            {
              subject: 'okf',
              predicate: 'has_status',
              object: 'draft-v0.1',
              confidence: 0.9,
              citations: [{ source_id: sourceB.source.id, quote: 'B says draft' }],
            },
          ],
          relations: [],
        },
      ],
    })

    // PENDING: the diff already announces the prospective dispute.
    const pendingDetail = await getProposal(db, { id: second.proposal_id })
    const reviewDiff = pendingDetail.concepts.find((concept) => concept.slug === 'okf-review')!
    expect(reviewDiff.claims_disputed).toEqual([{ subject: 'okf', predicate: 'has_status', object: 'draft-v0.1' }])

    // ...and the proposal.created outbox event counted it.
    const events = await db.select<{ event_type: string; payload: Record<string, unknown> }>('wk_outbox_events', {
      space_id: `eq.${space.id}`,
      event_type: 'eq.wikikit.proposal.created',
    })
    const eventB = events.find((event) => (event.payload as { title?: string }).title === 'B')!
    expect(eventB.payload).toMatchObject({ claims_count: 1, contradictions_count: 1 })

    const applied = await approveProposal(db, { id: second.proposal_id, reviewer: 'mike' })
    expect(applied.claims_disputed).toBe(2)

    // Both concepts now read disputed claims; the contradicts relation is
    // visible from BOTH sides via listRelations.
    const okf = await getConcept(db, space.id, { slug: 'okf' })
    expect(okf.claims[0]!.status).toBe('disputed')
    const okfConceptId = await db.select<{ id: string }>('wk_concepts', {
      space_id: `eq.${space.id}`,
      slug: `eq.okf`,
    })
    const relations = await listRelations(db, space.id, { conceptId: okfConceptId[0]!.id })
    expect(relations).toHaveLength(1)
    expect(relations[0]).toMatchObject({
      kind: 'contradicts',
      direction: 'in',
      from_slug: 'okf-review',
      to_slug: 'okf',
    })

    // Lint: the dispute is an error finding on the frame.
    const report = await lintSpace(db, space.id)
    const contradiction = report.findings.find((finding) => finding.rule === 'contradictions')!
    expect(contradiction.severity).toBe('error')
    expect(contradiction.message).toContain('okf has_status')
    expect(report.counts.error).toBeGreaterThanOrEqual(1)
  })

  it('stale base surfaces as ConflictError(stale_base) through approveProposal', async () => {
    const space = await seedSpace('stale-space')
    const source = await createSource(db, space.id, { kind: 'text', raw: 'v1', markdown: 'v1' })
    const base = { source_ids: [source.source.id], agent_meta: AGENT_META }
    const propose = (title: string, hash: string) =>
      createProposal(db, space.id, {
        title,
        input_hash: sha256Hex(hash),
        ...base,
        concepts: [{ slug: 'gamma', title, summary: '', markdown: `# ${title}`, claims: [], relations: [] }],
      })

    // Both staged against "no current revision" (base NULL)...
    const a = await propose('A', 'a')
    const b = await propose('B', 'b')
    // ...A wins, so B's base moved and its approval must fail atomically.
    await approveProposal(db, { id: a.proposal_id, reviewer: 'mike' })
    const failure = approveProposal(db, { id: b.proposal_id, reviewer: 'mike' })
    await expect(failure).rejects.toBeInstanceOf(ConflictError)
    await failure.catch((error) => expect((error as ConflictError).code).toBe('stale_base'))
    // §9.2: the caller marked B failed (terminal), freeing its
    // (space_id, input_hash) pending-dedup slot for a fresh re-synthesis.
    const detail = await getProposal(db, { id: b.proposal_id })
    expect(detail.status).toBe('failed')
    expect(detail.reviewer).toBe('mike')
    // The dedup slot really is free: re-proposing the same input_hash now
    // creates a NEW pending proposal instead of converging on the failed one.
    const retry = await propose('B', 'b')
    expect(retry.proposal_id).not.toBe(b.proposal_id)
    expect(retry.status).toBe('pending')
  })

  it('rev numbering: sequential proposals on one concept stack rev 1..n with correct bases', async () => {
    const space = await seedSpace('rev-space')
    const source = await createSource(db, space.id, { kind: 'text', raw: 'seed', markdown: 'seed' })
    for (let index = 1; index <= 3; index++) {
      const proposal = await createProposal(db, space.id, {
        title: `v${index}`,
        input_hash: sha256Hex(`rev-${index}`),
        source_ids: [source.source.id],
        agent_meta: AGENT_META,
        concepts: [
          { slug: 'delta', title: `v${index}`, summary: '', markdown: `# v${index}`, claims: [], relations: [] },
        ],
      })
      await approveProposal(db, { id: proposal.proposal_id, reviewer: 'mike' })
    }
    const history = await getConceptHistory(db, space.id, { slug: 'delta' })
    expect(history.map((revision) => [revision.rev, revision.status])).toEqual([
      [3, 'current'],
      [2, 'superseded'],
      [1, 'superseded'],
    ])
    // Each revision was synthesized against its predecessor.
    expect(history[0]!.base_revision_id).toBe(history[1]!.id)
    expect(history[1]!.base_revision_id).toBe(history[2]!.id)
    expect((await getConcept(db, space.id, { slug: 'delta' })).markdown).toBe('# v3')
  })

  it('decisions: rejected stays invisible, approved becomes readable', async () => {
    const space = await seedSpace('decision-space')
    const source = await createSource(db, space.id, { kind: 'text', raw: 'adr', markdown: 'adr' })
    const decision = {
      slug: 'no-direct-mqtt',
      title: 'No direct MQTT integration',
      context: 'Evaluated broker coupling',
      decision: 'Communicate over standard webhooks only',
      rationale: 'Loose coupling wins',
      alternatives: [{ option: 'direct MQTT', reason_rejected: 'tight coupling' }],
    }

    const rejected = await createProposal(db, space.id, {
      title: 'ADR (first try)',
      input_hash: sha256Hex('adr-1'),
      source_ids: [source.source.id],
      agent_meta: AGENT_META,
      concepts: [],
      decisions: [decision],
    })
    await rejectProposal(db, { id: rejected.proposal_id, reviewer: 'mike', note: 'needs discussion' })
    expect(await listDecisions(db, space.id)).toEqual([])
    await expect(getDecision(db, space.id, { slug: 'no-direct-mqtt' })).rejects.toBeInstanceOf(NotFoundError)

    // The rejected proposal keeps its audit trail.
    const rejectedDetail = await getProposal(db, { id: rejected.proposal_id })
    expect(rejectedDetail).toMatchObject({ status: 'rejected', reviewer: 'mike', review_note: 'needs discussion' })

    // Second attempt under a different slug (unique(space_id, slug) keeps the
    // rejected row as audit), approved this time.
    const approved = await createProposal(db, space.id, {
      title: 'ADR (revised)',
      input_hash: sha256Hex('adr-2'),
      source_ids: [source.source.id],
      agent_meta: AGENT_META,
      concepts: [],
      decisions: [{ ...decision, slug: 'no-direct-mqtt-v2' }],
    })
    await approveProposal(db, { id: approved.proposal_id, reviewer: 'mike' })
    const visible = await getDecision(db, space.id, { slug: 'no-direct-mqtt-v2' })
    expect(visible).toMatchObject({ status: 'active', decision: 'Communicate over standard webhooks only' })
    expect(visible.alternatives).toEqual([{ option: 'direct MQTT', reason_rejected: 'tight coupling' }])
    expect((await listDecisions(db, space.id)).map((entry) => entry.slug)).toEqual(['no-direct-mqtt-v2'])
  })

  it('lint: reports missing citations, orphans, empty concepts, pending proposals and dangling sources', async () => {
    const space = await seedSpace('lint-space')
    const source = await createSource(db, space.id, { kind: 'text', raw: 'cited', markdown: 'cited' })
    await createSource(db, space.id, { kind: 'text', raw: 'never cited', markdown: 'never cited' })

    const approvedProposal = await createProposal(db, space.id, {
      title: 'Concept with an uncited claim',
      input_hash: sha256Hex('lint-1'),
      source_ids: [source.source.id],
      agent_meta: AGENT_META,
      concepts: [
        {
          slug: 'alpha',
          title: 'Alpha',
          summary: '',
          markdown: '# Alpha',
          claims: [{ subject: 'alpha', predicate: 'is', object: 'undocumented', confidence: 0.5, citations: [] }],
          relations: [],
        },
        { slug: 'beta', title: 'Beta', summary: '', markdown: '# Beta', claims: [], relations: [] },
      ],
    })
    await approveProposal(db, { id: approvedProposal.proposal_id, reviewer: 'mike' })

    await createProposal(db, space.id, {
      title: 'Still pending',
      input_hash: sha256Hex('lint-2'),
      source_ids: [],
      agent_meta: AGENT_META,
      concepts: [{ slug: 'gamma', title: 'Gamma', summary: '', markdown: '# Gamma', claims: [], relations: [] }],
    })

    const report = await lintSpace(db, space.id)
    const rules = report.findings.map((finding) => finding.rule)
    expect(rules).toContain('missing-citations') // alpha's claim has no citation
    expect(rules).toContain('orphan-concepts') // alpha and beta have no relations
    expect(rules).toContain('empty-concepts') // beta has no claims
    expect(rules).toContain('unreviewed-proposals') // gamma proposal pending
    expect(rules).toContain('dangling-sources') // both sources uncited
    expect(rules).not.toContain('contradictions')
    expect(rules).not.toContain('broken-relations')
    expect(report.counts.error).toBe(1)

    // Findings are grouped by severity: errors first, info last.
    const severities = report.findings.map((finding) => finding.severity)
    expect(severities.indexOf('info')).toBeGreaterThan(severities.lastIndexOf('error'))
  })

  it('concurrent identical proposals converge on one pending row (dedup index race)', async () => {
    const space = await seedSpace('race-space')
    const args = (title: string) => ({
      title,
      input_hash: sha256Hex('same-input'),
      source_ids: [] as string[],
      agent_meta: AGENT_META,
      concepts: [{ slug: 'zeta', title: 'Zeta', summary: '', markdown: '# Zeta', claims: [], relations: [] }],
    })
    const [a, b] = await Promise.all([
      createProposal(db, space.id, args('first')),
      createProposal(db, space.id, args('second')),
    ])
    expect(a.proposal_id).toBe(b.proposal_id)
    const pending = await db.select('wk_change_proposals', { space_id: `eq.${space.id}`, status: 'eq.pending' })
    expect(pending.length).toBe(1)
  })
})
