// 0021/0022 claim semantics against real Postgres: disjoint validity is
// succession (no dispute), overlapping validity disputes, context partitions
// the frame, normalized objects compare canonically, explicit supersession
// deprecates deterministically (flip 5c + supersedes relation), and the
// adjudication stamp exempts complementary claims — plus the pending proposal
// diff, which must predict the same outcome BEFORE the reviewer decides.
// RUN_INTEGRATION=1 gated.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createProposal, getProposal, type ApplyResult } from '../../src/domain/proposals.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db
let spaceId = ''

const hex64 = () => randomUUID().replaceAll('-', '').padEnd(64, '0')

interface StagedClaim {
  subject: string
  predicate: string
  object: string
  valid_from?: string | null
  valid_until?: string | null
  context?: string | null
  supersedes_claim_id?: string | null
  adjudication?: 'contradictory' | 'temporal' | 'complementary'
}

async function propose(slug: string, claims: StagedClaim[]): Promise<string> {
  const { proposal_id } = await createProposal(db, spaceId, {
    title: `Stage ${slug}`,
    input_hash: hex64(),
    agent_meta: { model: 'manual', prompt_version: 'manual' },
    concepts: [{ slug, title: slug, markdown: `# ${slug}`, claims }],
  })
  return proposal_id
}

async function proposeAndApprove(slug: string, claims: StagedClaim[]): Promise<ApplyResult> {
  const [result] = await db.call<ApplyResult>('wk_apply_proposal', [await propose(slug, claims), 'semantics-test'])
  return result!
}

async function claimStatus(subject: string, object: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM wk_claims WHERE space_id = $1 AND subject = $2 AND object = $3`,
    [spaceId, subject, object],
  )
  return rows[0]!.status
}

describe('claim semantics 0021/0022 (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_claim_semantics')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
    const [space] = await db.insert<{ id: string }>('wk_spaces', {
      slug: 'semantics-space',
      name: 'Semantics',
      settings: JSON.stringify({
        functional_predicates: ['has_status'],
        predicate_defs: [
          {
            name: 'max_upload',
            type: 'quantity',
            functional: true,
            unit: { canonical: 'MiB', accept: { GiB: 1024, KiB: 0.0009765625, MiB: 1 } },
          },
        ],
        aliases: { 'The Device A': 'device-a' },
      }),
    })
    spaceId = space!.id
  })

  afterAll(async () => {
    if (!integration) return
    await database.close()
  })

  it('disjoint validity intervals are succession, not contradiction', async () => {
    await proposeAndApprove('firmware', [
      {
        subject: 'device-a',
        predicate: 'has_status',
        object: 'firmware-1.0',
        valid_from: '2025-01-01T00:00:00.000Z',
        valid_until: '2026-01-01T00:00:00.000Z',
      },
    ])
    const result = await proposeAndApprove('firmware-v2', [
      {
        subject: 'device-a',
        predicate: 'has_status',
        object: 'firmware-2.0',
        valid_from: '2026-01-01T00:00:00.000Z',
      },
    ])
    expect(result.claims_disputed).toBe(0)
    expect(await claimStatus('device-a', 'firmware-1.0')).toBe('verified')
    expect(await claimStatus('device-a', 'firmware-2.0')).toBe('verified')
  })

  it('context partitions the frame: same predicate, different regions coexist', async () => {
    await proposeAndApprove('region-eu', [
      { subject: 'service', predicate: 'has_status', object: 'live', context: 'region:eu' },
    ])
    const result = await proposeAndApprove('region-us', [
      { subject: 'service', predicate: 'has_status', object: 'beta', context: 'region:us' },
    ])
    expect(result.claims_disputed).toBe(0)
  })

  it('normalized quantities collide across unit aliases (1 GiB vs 1024 MiB = same value → no dispute)', async () => {
    await proposeAndApprove('limits', [{ subject: 'uploads', predicate: 'max_upload', object: '1 GiB' }])
    const same = await proposeAndApprove('limits-same', [
      { subject: 'uploads', predicate: 'max_upload', object: '1024 MiB' },
    ])
    expect(same.claims_disputed).toBe(0) // canonically equal — NOT a contradiction

    const different = await proposeAndApprove('limits-diff', [
      { subject: 'uploads', predicate: 'max_upload', object: '20 MiB' },
    ])
    expect(different.claims_disputed).toBeGreaterThanOrEqual(2) // 20 MiB vs 1024 MiB, both sides disputed
  })

  it('explicit supersession deprecates the target and stages a supersedes relation', async () => {
    await proposeAndApprove('policy', [{ subject: 'backups', predicate: 'has_status', object: 'daily' }])
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM wk_claims WHERE space_id = $1 AND subject = 'backups' AND object = 'daily'`,
      [spaceId],
    )
    const oldClaimId = rows[0]!.id

    const result = await proposeAndApprove('policy-v2', [
      { subject: 'backups', predicate: 'has_status', object: 'hourly', supersedes_claim_id: oldClaimId },
    ])
    expect(result.claims_deprecated).toBe(1)
    expect(result.claims_disputed).toBe(0) // supersession pairs are exempt from flip 5
    expect(await claimStatus('backups', 'daily')).toBe('deprecated')
    expect(await claimStatus('backups', 'hourly')).toBe('verified')

    const { rows: relations } = await db.query(
      `SELECT 1 FROM wk_relations rel
        JOIN wk_concepts f ON f.id = rel.from_concept_id AND f.slug = 'policy-v2'
        JOIN wk_concepts t ON t.id = rel.to_concept_id AND t.slug = 'policy'
       WHERE rel.space_id = $1 AND rel.kind = 'supersedes' AND rel.status = 'active'`,
      [spaceId],
    )
    expect(relations.length).toBe(1)
  })

  it('an adjudication=complementary stamp exempts the claim from the dispute flip', async () => {
    await proposeAndApprove('deps', [{ subject: 'app', predicate: 'has_status', object: 'stable' }])
    const result = await proposeAndApprove('deps-extra', [
      { subject: 'app', predicate: 'has_status', object: 'experimental-track', adjudication: 'complementary' },
    ])
    expect(result.claims_disputed).toBe(0)
    expect(await claimStatus('app', 'stable')).toBe('verified')
  })

  it('overlapping validity on the same context still disputes (the classic case)', async () => {
    await proposeAndApprove('classic', [{ subject: 'gateway', predicate: 'has_status', object: 'primary' }])
    const result = await proposeAndApprove('classic-2', [
      { subject: 'gateway', predicate: 'has_status', object: 'decommissioned' },
    ])
    expect(result.claims_disputed).toBe(2)
    expect(await claimStatus('gateway', 'primary')).toBe('disputed')
    expect(await claimStatus('gateway', 'decommissioned')).toBe('disputed')
  })

  // The PENDING side of every rule above. ClaimDiff.collides is what the
  // review surfaces render as "approval disputes BOTH sides", so it has to
  // obey the same 0021 refinements flip 5 does: each staged claim below shares
  // subject+predicate with a visible claim and carries a different literal
  // object, so a bare frame match would flag all seven — and approval disputes
  // exactly one of them.
  it('the pending diff flags only the collisions flip 5 will actually dispute', async () => {
    await proposeAndApprove('edge-baseline', [
      { subject: 'edge-node', predicate: 'has_status', object: 'v1', valid_until: '2026-01-01T00:00:00.000Z' },
      { subject: 'edge-svc', predicate: 'has_status', object: 'live', context: 'region:eu' },
      { subject: 'edge-cap', predicate: 'max_upload', object: '1 GiB' },
      { subject: 'edge-mix', predicate: 'has_status', object: 'stable' },
      { subject: 'edge-free', predicate: 'runs_on', object: 'linux' },
      { subject: 'edge-old', predicate: 'has_status', object: 'legacy' },
      { subject: 'edge-hot', predicate: 'has_status', object: 'primary' },
    ])
    const { rows: legacyRows } = await db.query<{ id: string }>(
      `SELECT id FROM wk_claims WHERE space_id = $1 AND subject = 'edge-old' AND object = 'legacy'`,
      [spaceId],
    )

    const proposalId = await propose('edge-successor', [
      // Disjoint validity — succession, not contradiction.
      { subject: 'edge-node', predicate: 'has_status', object: 'v2', valid_from: '2026-01-01T00:00:00.000Z' },
      // A different context partition of the same frame.
      { subject: 'edge-svc', predicate: 'has_status', object: 'beta', context: 'region:us' },
      // Canonically equal once normalized against the predicate registry.
      { subject: 'edge-cap', predicate: 'max_upload', object: '1024 MiB' },
      // The adjudicator already ruled these complementary.
      { subject: 'edge-mix', predicate: 'has_status', object: 'experimental', adjudication: 'complementary' },
      // Undeclared predicate: multi-valued, so two objects are two facts.
      { subject: 'edge-free', predicate: 'runs_on', object: 'bsd' },
      // Explicit supersession: flip 5c deprecates the target, flip 5 skips it.
      { subject: 'edge-old', predicate: 'has_status', object: 'current', supersedes_claim_id: legacyRows[0]!.id },
      // The one real contradiction.
      { subject: 'edge-hot', predicate: 'has_status', object: 'decommissioned' },
    ])

    const detail = await getProposal(db, { id: proposalId })
    const staged = detail.concepts.find((concept) => concept.slug === 'edge-successor')!
    expect(staged.claims.filter((claim) => claim.collides).map((claim) => claim.object)).toEqual(['decommissioned'])
    expect(staged.claims_disputed).toEqual([{ subject: 'edge-hot', predicate: 'has_status', object: 'decommissioned' }])

    const [applied] = await db.call<ApplyResult>('wk_apply_proposal', [proposalId, 'semantics-test'])
    expect(applied!.claims_disputed).toBe(2) // edge-hot, both sides — and nothing else
    expect(applied!.claims_deprecated).toBe(1) // edge-old, via supersession
    expect(await claimStatus('edge-node', 'v1')).toBe('verified')
    expect(await claimStatus('edge-svc', 'live')).toBe('verified')
    expect(await claimStatus('edge-cap', '1 GiB')).toBe('verified')
    expect(await claimStatus('edge-mix', 'stable')).toBe('verified')
    expect(await claimStatus('edge-free', 'linux')).toBe('verified')
    expect(await claimStatus('edge-hot', 'primary')).toBe('disputed')
  })

  it('subject aliases resolve at staging: stored claims are canonical', async () => {
    await proposeAndApprove('alias-check', [{ subject: 'The Device A', predicate: 'has_status', object: 'aliased' }])
    const { rows } = await db.query<{ subject: string }>(
      `SELECT subject FROM wk_claims WHERE space_id = $1 AND object = 'aliased'`,
      [spaceId],
    )
    expect(rows[0]!.subject).toBe('device-a')
  })
})
