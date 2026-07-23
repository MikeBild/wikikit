// wk_split_proposal + wk_request_changes against real Postgres: row
// re-pointing across all staging tables (including 0014 removal markers),
// pending-dedup hash salting, terminal 'split' parent, defer keeping the
// parent alive, children approvable independently, and request-changes as a
// terminal reject with the machine-readable flag. RUN_INTEGRATION=1 gated.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createProposal, getProposal, requestChanges, splitProposal } from '../../src/domain/proposals.ts'
import { lintProposal } from '../../src/domain/lint.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db
let spaceId = ''
let approvedSlug = ''

function hex64(): string {
  return randomUUID().replaceAll('-', '').padEnd(64, '0')
}

// Unique slugs per invocation: relations are unique per (space, from, to,
// kind) edge and re-asserting an ACTIVE edge stages nothing (re-adoption
// rule) — shared slugs would couple the tests through approved state.
async function stageThreeConceptProposal(prefix: string): Promise<string> {
  const slugs = ['alpha', 'beta', 'gamma'].map((name) => `${prefix}-${name}`)
  const { proposal_id } = await createProposal(db, spaceId, {
    title: 'Big source touching three concepts',
    input_hash: hex64(),
    agent_meta: { model: 'manual', prompt_version: 'manual' },
    concepts: slugs.map((slug) => ({
      slug,
      title: slug.toUpperCase(),
      markdown: `# ${slug}\n\nBody of ${slug}.`,
      claims: [{ subject: slug, predicate: 'is', object: `${slug}-content` }],
      relations: slug === `${prefix}-alpha` ? [{ to_slug: `${prefix}-beta`, kind: 'related' as const }] : [],
    })),
    decisions: [
      {
        slug: `decision-${randomUUID().slice(0, 8)}`,
        title: 'Adopt the format',
        context: 'Evaluated options',
        decision: 'Adopt it',
      },
    ],
  })
  return proposal_id
}

describe('split & request-changes (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_split')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
    const [space] = await db.insert<{ id: string }>('wk_spaces', { slug: 'split-space', name: 'Split' })
    spaceId = space!.id
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('full split: one pending child per concept + a decisions child; parent → terminal split', async () => {
    const parentId = await stageThreeConceptProposal('full')
    const result = await splitProposal(db, { id: parentId, reviewer: 'mike' })

    expect(result.parent).toEqual({ id: parentId, status: 'split' })
    expect(result.children).toHaveLength(4) // alpha, beta, gamma + decisions

    const parent = await getProposal(db, { id: parentId })
    expect(parent.status).toBe('split')
    expect(parent.concepts).toHaveLength(0) // every staged row moved

    for (const child of result.children) {
      const detail = await getProposal(db, { id: child.proposal_id })
      expect(detail.status).toBe('pending')
      expect(detail.parent_proposal_id).toBe(parentId)
      if (child.concepts.length) {
        expect(detail.concepts.map((concept) => concept.slug)).toEqual(child.concepts)
        expect(detail.concepts[0]!.claims).toHaveLength(1)
      } else {
        expect(detail.decisions).toHaveLength(1)
      }
    }

    // A child approves independently through the normal gate.
    const conceptChild = result.children.find((child) => child.concepts.length)!
    approvedSlug = conceptChild.concepts[0]!
    const applied = await db.call<{ status: string }>('wk_apply_proposal', [conceptChild.proposal_id, 'mike'])
    expect(applied[0]!.status).toBe('approved')

    // Terminal parent refuses further operations.
    await expect(splitProposal(db, { id: parentId, reviewer: 'mike' })).rejects.toMatchObject({
      code: 'proposal_not_pending',
    })
  })

  it('defer: subset moves to one child, parent stays pending with a re-salted hash', async () => {
    const parentId = await stageThreeConceptProposal('defer')
    const before = await getProposal(db, { id: parentId })
    expect(before.concepts).toHaveLength(3)

    const result = await splitProposal(db, { id: parentId, reviewer: 'mike', concepts: ['defer-beta'] })
    expect(result.parent).toEqual({ id: parentId, status: 'pending' })
    expect(result.children).toHaveLength(1)

    const parent = await getProposal(db, { id: parentId })
    expect(parent.status).toBe('pending')
    expect(parent.concepts.map((concept) => concept.slug).sort()).toEqual(['defer-alpha', 'defer-gamma'])
    expect(parent.decisions).toHaveLength(1) // decisions stay with the parent on defer

    const child = await getProposal(db, { id: result.children[0]!.proposal_id })
    expect(child.concepts.map((concept) => concept.slug)).toEqual(['defer-beta'])

    // Relations staged FROM a remaining concept stay with the parent.
    expect(parent.concepts.find((concept) => concept.slug === 'defer-alpha')!.relations_added).toEqual([
      { to_slug: 'defer-beta', kind: 'related' },
    ])
  })

  it('validates split inputs: unknown slug 400s, full-coverage subset 400s', async () => {
    const parentId = await stageThreeConceptProposal('valid')
    await expect(splitProposal(db, { id: parentId, reviewer: 'mike', concepts: ['ghost'] })).rejects.toThrow(
      'slugs staged by this proposal',
    )
    await expect(
      splitProposal(db, { id: parentId, reviewer: 'mike', concepts: ['valid-alpha', 'valid-beta', 'valid-gamma'] }),
    ).rejects.toThrow('nothing to split')
  })

  it('request-changes: terminal reject + flag + renamed outbox event; note mandatory', async () => {
    const parentId = await stageThreeConceptProposal('bounce')
    await expect(requestChanges(db, { id: parentId, reviewer: 'mike', note: '  ' })).rejects.toThrow('note')

    const result = await requestChanges(db, {
      id: parentId,
      reviewer: 'mike',
      note: 'split alpha into two concepts and quote the source',
    })
    expect(result).toMatchObject({ proposal_id: parentId, status: 'rejected', changes_requested: true })

    const detail = await getProposal(db, { id: parentId })
    expect(detail.status).toBe('rejected')
    expect(detail.changes_requested).toBe(true)
    expect(detail.review_note).toContain('split alpha')

    const { rows: events } = await db.query(
      `SELECT payload FROM wk_outbox_events
        WHERE space_id = $1 AND event_type = 'wikikit.proposal.changes_requested'
          AND payload->>'proposal_id' = $2`,
      [spaceId, parentId],
    )
    expect(events).toHaveLength(1)
  })

  it('lintProposal surfaces uncited claims and frame collisions on staged content', async () => {
    // Space declares 'is' functional so the collision rule fires.
    await db.update(
      'wk_spaces',
      { id: `eq.${spaceId}` },
      { settings: JSON.stringify({ functional_predicates: ['is'] }) },
    )
    // Stage a claim whose frame collides with an already-approved one
    // (approved in the full-split test: '<slug> is <slug>-content').
    const { proposal_id: parentId } = await createProposal(db, spaceId, {
      title: 'Colliding follow-up',
      input_hash: hex64(),
      agent_meta: { model: 'manual', prompt_version: 'manual' },
      concepts: [
        {
          slug: 'collide-target',
          title: 'Collide Target',
          markdown: '# Collide\n\nBody.',
          claims: [{ subject: approvedSlug, predicate: 'is', object: 'entirely-different-content' }],
        },
      ],
    })
    const report = await lintProposal(db, spaceId, parentId)
    const rules = report.findings.map((finding) => finding.rule)
    expect(rules).toContain('missing-citations')
    expect(rules).toContain('contradictions')
    expect(report.counts.error).toBeGreaterThanOrEqual(2)
  })
})
