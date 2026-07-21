// wk_apply_proposal / wk_reject_proposal against a real Docker Postgres —
// the review gate's atomicity contract (CONTRACTS §1.15, §9).
// Gated behind RUN_INTEGRATION=1; scripts/start-local.ts provisions the container.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { zWebhookPayloads } from '../../src/webhooks.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

/**
 * Parse a REAL emitted outbox payload through its §6.3 zod contract. The SQL
 * functions build these with jsonb_build_object — outside the zod schemas'
 * reach — so a renamed key in the migration must fail an integration run, not
 * ship silently to webhook consumers.
 */
function expectContractPayload(event: { event_type: string; payload: Record<string, unknown> }): void {
  const schema = zWebhookPayloads[event.event_type as keyof typeof zWebhookPayloads]
  expect(schema, `unknown event type ${event.event_type}`).toBeDefined()
  const parsed = schema.safeParse(event.payload)
  expect(
    parsed.success,
    `${event.event_type} payload violates its contract: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
  ).toBe(true)
}

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

interface StagedProposal {
  proposalId: string
  conceptId: string
  revisionId: string
  claimIds: string[]
}

// Stages a proposal exactly the way createProposal (domain layer) will:
// real proposed-status rows in the target tables, all in one transaction.
async function stageProposal(args: {
  spaceId: string
  conceptSlug: string
  markdown: string
  rev: number
  baseRevisionId?: string | null
  claims?: { subject: string; predicate: string; object: string }[]
  relationToConceptId?: string
}): Promise<StagedProposal> {
  return db.tx(async (tx) => {
    const [proposal] = await tx.insert<{ id: string }>('wk_change_proposals', {
      space_id: args.spaceId,
      title: `Update ${args.conceptSlug}`,
      input_hash: randomUUID(),
      agent_meta: { model: 'manual', prompt_version: 'manual' },
    })
    const [existing] = await tx.select<{ id: string }>('wk_concepts', {
      space_id: `eq.${args.spaceId}`,
      slug: `eq.${args.conceptSlug}`,
    })
    const conceptId =
      existing?.id ??
      (
        await tx.insert<{ id: string }>('wk_concepts', {
          space_id: args.spaceId,
          slug: args.conceptSlug,
          title: `Concept ${args.conceptSlug}`,
        })
      )[0]!.id
    const [revision] = await tx.insert<{ id: string }>('wk_concept_revisions', {
      space_id: args.spaceId,
      concept_id: conceptId,
      rev: args.rev,
      status: 'proposed',
      title: `Concept ${args.conceptSlug} r${args.rev}`,
      summary: `Summary of ${args.conceptSlug}`,
      markdown: args.markdown,
      base_revision_id: args.baseRevisionId ?? null,
      proposal_id: proposal!.id,
    })
    const claimIds: string[] = []
    for (const claim of args.claims ?? []) {
      const [row] = await tx.insert<{ id: string }>('wk_claims', {
        space_id: args.spaceId,
        concept_id: conceptId,
        subject: claim.subject,
        predicate: claim.predicate,
        object: claim.object,
        status: 'proposed',
        confidence: 0.9,
        proposal_id: proposal!.id,
      })
      claimIds.push(row!.id)
    }
    if (args.relationToConceptId) {
      await tx.insert(
        'wk_relations',
        {
          space_id: args.spaceId,
          from_concept_id: conceptId,
          to_concept_id: args.relationToConceptId,
          kind: 'related',
          status: 'proposed',
          proposal_id: proposal!.id,
        },
        { returning: false },
      )
    }
    return { proposalId: proposal!.id, conceptId, revisionId: revision!.id, claimIds }
  })
}

describe('wk_apply_proposal / wk_reject_proposal (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_proposals')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('approve flips revision/claims/relations atomically, bumps the epoch and writes outbox events', async () => {
    const space = await seedSpace('approve-happy')
    const other = await stageProposal({ spaceId: space.id, conceptSlug: 'other', markdown: '# other', rev: 1 })
    const staged = await stageProposal({
      spaceId: space.id,
      conceptSlug: 'alpha',
      markdown: '# Alpha\n\nBody text.',
      rev: 1,
      claims: [{ subject: 'alpha', predicate: 'is', object: 'stable' }],
      relationToConceptId: other.conceptId,
    })

    const [result] = await db.call('wk_apply_proposal', [staged.proposalId, 'mike'])
    expect(result).toMatchObject({ proposal_id: staged.proposalId, status: 'approved', claims_verified: 1 })
    expect(result!.concepts as string[]).toContain('alpha')

    const [revision] = await db.select<{ status: string }>('wk_concept_revisions', { id: `eq.${staged.revisionId}` })
    expect(revision!.status).toBe('current')
    const [concept] = await db.select<{ current_revision_id: string; title: string }>('wk_concepts', {
      id: `eq.${staged.conceptId}`,
    })
    expect(concept!.current_revision_id).toBe(staged.revisionId)
    expect(concept!.title).toBe('Concept alpha r1')
    const [claim] = await db.select<{ status: string }>('wk_claims', { id: `eq.${staged.claimIds[0]}` })
    expect(claim!.status).toBe('verified')
    const relations = await db.select<{ status: string }>('wk_relations', {
      from_concept_id: `eq.${staged.conceptId}`,
    })
    expect(relations[0]!.status).toBe('active')
    const [proposal] = await db.select<{ status: string; reviewer: string; reviewed_at: string }>(
      'wk_change_proposals',
      { id: `eq.${staged.proposalId}` },
    )
    expect(proposal!.status).toBe('approved')
    expect(proposal!.reviewer).toBe('mike')
    expect(proposal!.reviewed_at).toBeTruthy()
    const [spaceRow] = await db.select<{ epoch: string | number }>('wk_spaces', { id: `eq.${space.id}` })
    expect(Number(spaceRow!.epoch)).toBe(1)

    const events = await db.select<{ event_type: string; payload: Record<string, unknown> }>('wk_outbox_events', {
      space_id: `eq.${space.id}`,
    })
    const types = events.map((event) => event.event_type)
    expect(types).toContain('wikikit.proposal.approved')
    expect(types).toContain('wikikit.concept.updated')
    const updated = events.find((event) => event.event_type === 'wikikit.concept.updated')!
    expect(updated.payload).toMatchObject({ space: 'approve-happy', slug: 'alpha', rev: 1 })
    // EVERY emitted payload must parse against its §6.3 contract schema — the
    // SQL-built jsonb is the wire truth webhook consumers receive.
    for (const event of events) expectContractPayload(event)
  })

  it('double-apply is rejected with proposal_not_pending', async () => {
    const space = await seedSpace('double-apply')
    const staged = await stageProposal({ spaceId: space.id, conceptSlug: 'beta', markdown: '# Beta', rev: 1 })
    await db.call('wk_apply_proposal', [staged.proposalId, 'mike'])
    await expect(db.call('wk_apply_proposal', [staged.proposalId, 'mike'])).rejects.toThrow('proposal_not_pending')
  })

  it('unknown proposal raises proposal_not_found', async () => {
    await expect(db.call('wk_apply_proposal', [randomUUID(), 'mike'])).rejects.toThrow('proposal_not_found')
  })

  it('two concurrent approvals on the same concept serialize — exactly one wins, the loser gets stale_base', async () => {
    const space = await seedSpace('concurrent')
    const first = await stageProposal({ spaceId: space.id, conceptSlug: 'gamma', markdown: '# v1', rev: 1 })
    await db.call('wk_apply_proposal', [first.proposalId, 'mike'])

    // Two competing follow-ups, both synthesized against revision 1.
    const p2 = await stageProposal({
      spaceId: space.id,
      conceptSlug: 'gamma',
      markdown: '# v2 (a)',
      rev: 2,
      baseRevisionId: first.revisionId,
    })
    const p3 = await stageProposal({
      spaceId: space.id,
      conceptSlug: 'gamma',
      markdown: '# v2 (b)',
      rev: 3,
      baseRevisionId: first.revisionId,
    })

    const results = await Promise.allSettled([
      db.call('wk_apply_proposal', [p2.proposalId, 'reviewer-a']),
      db.call('wk_apply_proposal', [p3.proposalId, 'reviewer-b']),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('stale_base')

    // The concept points at exactly the winner's revision; the loser's stays proposed.
    const [concept] = await db.select<{ current_revision_id: string }>('wk_concepts', { id: `eq.${first.conceptId}` })
    const winner = fulfilled[0]!.status === 'fulfilled' ? fulfilled[0]!.value : []
    expect(winner.length).toBe(1)
    const revisions = await db.select<{ id: string; status: string }>('wk_concept_revisions', {
      concept_id: `eq.${first.conceptId}`,
    })
    const current = revisions.filter((revision) => revision.status === 'current')
    expect(current.length).toBe(1)
    expect(concept!.current_revision_id).toBe(current[0]!.id)
    expect(revisions.filter((revision) => revision.status === 'proposed').length).toBe(1)
    expect(revisions.filter((revision) => revision.status === 'superseded').length).toBe(1)
  })

  it('stale base is detected even without concurrency (base moved before review)', async () => {
    const space = await seedSpace('stale-base')
    const first = await stageProposal({ spaceId: space.id, conceptSlug: 'delta', markdown: '# v1', rev: 1 })
    // Staged as a NEW concept (base NULL) — but the concept gains a current
    // revision before this proposal is reviewed.
    const stale = await stageProposal({
      spaceId: space.id,
      conceptSlug: 'delta',
      markdown: '# also new',
      rev: 2,
      baseRevisionId: null,
    })
    await db.call('wk_apply_proposal', [first.proposalId, 'mike'])
    await expect(db.call('wk_apply_proposal', [stale.proposalId, 'mike'])).rejects.toThrow('stale_base')
    // And the failed apply left no partial state behind (atomicity).
    const [revision] = await db.select<{ status: string }>('wk_concept_revisions', { id: `eq.${stale.revisionId}` })
    expect(revision!.status).toBe('proposed')
    const [proposal] = await db.select<{ status: string }>('wk_change_proposals', { id: `eq.${stale.proposalId}` })
    expect(proposal!.status).toBe('pending')
  })

  it('exact-frame contradictions dispute both claims and ensure a contradicts relation', async () => {
    const space = await seedSpace('contradiction', { functional_predicates: ['has_status'] })
    const a = await stageProposal({
      spaceId: space.id,
      conceptSlug: 'okf',
      markdown: '# OKF',
      rev: 1,
      claims: [{ subject: 'okf', predicate: 'has_status', object: 'production-ready' }],
    })
    await db.call('wk_apply_proposal', [a.proposalId, 'mike'])

    const b = await stageProposal({
      spaceId: space.id,
      conceptSlug: 'okf-review',
      markdown: '# OKF Review',
      rev: 1,
      claims: [{ subject: 'okf', predicate: 'has_status', object: 'draft-v0.1' }],
    })
    const [result] = await db.call('wk_apply_proposal', [b.proposalId, 'mike'])
    expect(result).toMatchObject({ claims_verified: 1, claims_disputed: 2 })

    const claims = await db.select<{ id: string; status: string }>('wk_claims', {
      space_id: `eq.${space.id}`,
      subject: 'eq.okf',
      predicate: 'eq.has_status',
    })
    expect(claims.length).toBe(2)
    for (const claim of claims) expect(claim.status).toBe('disputed')

    const relations = await db.select<{ kind: string; status: string; from_concept_id: string; to_concept_id: string }>(
      'wk_relations',
      { space_id: `eq.${space.id}`, kind: 'eq.contradicts' },
    )
    expect(relations.length).toBe(1)
    expect(relations[0]!).toMatchObject({ status: 'active', from_concept_id: b.conceptId, to_concept_id: a.conceptId })
  })

  it('different objects on an undeclared multi-valued predicate remain verified and complementary', async () => {
    const space = await seedSpace('multi-valued')
    const first = await stageProposal({
      spaceId: space.id,
      conceptSlug: 'one',
      markdown: '# One',
      rev: 1,
      claims: [{ subject: 'service', predicate: 'uses', object: 'postgres' }],
    })
    const second = await stageProposal({
      spaceId: space.id,
      conceptSlug: 'two',
      markdown: '# Two',
      rev: 1,
      claims: [{ subject: 'service', predicate: 'uses', object: 'redis' }],
    })
    await db.call('wk_apply_proposal', [first.proposalId, 'mike'])
    const [result] = await db.call('wk_apply_proposal', [second.proposalId, 'mike'])
    expect(result).toMatchObject({ claims_verified: 1, claims_disputed: 0 })

    const claims = await db.select<{ status: string }>('wk_claims', { space_id: `eq.${space.id}` })
    expect(claims.map((claim) => claim.status)).toEqual(['verified', 'verified'])
    expect((await db.select('wk_relations', { space_id: `eq.${space.id}`, kind: 'eq.contradicts' })).length).toBe(0)
  })

  it('reject keeps rows for audit: revisions rejected, relations removed, claims stay proposed', async () => {
    const space = await seedSpace('reject')
    const anchor = await stageProposal({ spaceId: space.id, conceptSlug: 'anchor', markdown: '# a', rev: 1 })
    const staged = await stageProposal({
      spaceId: space.id,
      conceptSlug: 'epsilon',
      markdown: '# Epsilon',
      rev: 1,
      claims: [{ subject: 'epsilon', predicate: 'is', object: 'rejected-content' }],
      relationToConceptId: anchor.conceptId,
    })

    const [result] = await db.call('wk_reject_proposal', [staged.proposalId, 'mike', 'not convincing'])
    expect(result).toEqual({ proposal_id: staged.proposalId, status: 'rejected', review_channel: 'rest' })

    const [revision] = await db.select<{ status: string }>('wk_concept_revisions', { id: `eq.${staged.revisionId}` })
    expect(revision!.status).toBe('rejected')
    const [claim] = await db.select<{ status: string }>('wk_claims', { id: `eq.${staged.claimIds[0]}` })
    expect(claim!.status).toBe('proposed')
    const [relation] = await db.select<{ status: string }>('wk_relations', {
      from_concept_id: `eq.${staged.conceptId}`,
    })
    expect(relation!.status).toBe('removed')
    const [concept] = await db.select<{ current_revision_id: string | null }>('wk_concepts', {
      id: `eq.${staged.conceptId}`,
    })
    expect(concept!.current_revision_id).toBeNull()
    const [proposal] = await db.select<{ status: string; review_note: string; review_channel: string }>(
      'wk_change_proposals',
      {
        id: `eq.${staged.proposalId}`,
      },
    )
    expect(proposal!.status).toBe('rejected')
    expect(proposal!.review_note).toBe('not convincing')
    expect(proposal!.review_channel).toBe('rest')

    // No epoch bump, but a rejected outbox event in the same tx.
    const [spaceRow] = await db.select<{ epoch: string | number }>('wk_spaces', { id: `eq.${space.id}` })
    expect(Number(spaceRow!.epoch)).toBe(0)
    const events = await db.select<{ event_type: string; payload: Record<string, unknown> }>('wk_outbox_events', {
      space_id: `eq.${space.id}`,
    })
    expect(events.map((event) => event.event_type)).toContain('wikikit.proposal.rejected')
    for (const event of events) expectContractPayload(event)
    expect(events.find((event) => event.event_type === 'wikikit.proposal.rejected')!.payload.review_channel).toBe(
      'rest',
    )

    // Terminal: a rejected proposal cannot be approved afterwards.
    await expect(db.call('wk_apply_proposal', [staged.proposalId, 'mike'])).rejects.toThrow('proposal_not_pending')
  })
})
