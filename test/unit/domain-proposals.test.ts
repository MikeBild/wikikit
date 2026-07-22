// proposals domain — staging writes, input_hash dedup, the structured diff
// (JSON + markdown rendering) and the review-RPC error mapping.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { ConflictError, NotFoundError, ValidationError } from '../../src/domain/errors.ts'
import {
  approveProposal,
  computeInputHash,
  createProposal,
  getProposal,
  listProposals,
  rejectProposal,
  renderProposalMarkdown,
  type ProposalDetail,
} from '../../src/domain/proposals.ts'
import { sha256Hex } from '../../src/domain/sources.ts'

interface Call {
  sql: string
  values: unknown[]
}
type Rows = Record<string, unknown>[]
interface Route {
  match: RegExp
  rows?: Rows | ((values: unknown[], call: number) => Rows)
  error?: unknown
}

function fakeDb(routes: Route[]) {
  const calls: Call[] = []
  const counts = new Map<Route, number>()
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    const route = routes.find((entry) => entry.match.test(sql))
    if (!route) return { rows: [], rowCount: 0 }
    const count = (counts.get(route) ?? 0) + 1
    counts.set(route, count)
    if (route.error) throw route.error
    const rows = typeof route.rows === 'function' ? route.rows(values, count) : (route.rows ?? [])
    return { rows, rowCount: rows.length }
  }
  const pool: PoolLike = { query, connect: async () => ({ query, release() {} }), end: async () => {} }
  const { db } = createPostgres({ databaseUrl: 'postgresql://stub' } as Config, { pool })
  return { db, calls }
}

const INPUT_HASH = sha256Hex('input')

const stagingArgs = {
  title: 'Update okf',
  input_hash: INPUT_HASH,
  source_ids: ['6f1e0dcb-5f0e-4b1a-9c1c-000000000001'],
  agent_meta: { model: 'claude-sonnet-5', prompt_version: 'synthesize.v1' },
  concepts: [
    {
      slug: 'okf',
      title: 'OKF',
      summary: 'Open Knowledge Format',
      markdown: '# OKF\n\nBody.',
      claims: [
        {
          subject: 'okf',
          predicate: 'has_status',
          object: 'draft-v0.1',
          confidence: 0.9,
          citations: [{ source_id: '6f1e0dcb-5f0e-4b1a-9c1c-000000000001', quote: 'OKF is a draft' }],
        },
      ],
      relations: [{ to_slug: 'graph-store', kind: 'related' as const }],
    },
  ],
  relations_removed: [{ from_slug: 'okf', to_slug: 'legacy-store', kind: 'depends_on' as const }],
}

describe('computeInputHash', () => {
  test('is order-insensitive over source hashes (set semantics)', () => {
    expect(computeInputHash(['b', 'a'], 'synthesize.v1')).toBe(computeInputHash(['a', 'b'], 'synthesize.v1'))
  })

  test('is sensitive to the prompt version (prompt regression = new proposal)', () => {
    expect(computeInputHash(['a'], 'synthesize.v1')).not.toBe(computeInputHash(['a'], 'classify.v1'))
  })
})

describe('createProposal — staging in one transaction', () => {
  function stagingRoutes(): Route[] {
    return [
      { match: /SELECT \* FROM "public"\."wk_spaces"/, rows: [{ slug: 'dev' }] },
      { match: /SELECT \* FROM "public"\."wk_change_proposals"/, rows: [] }, // dedup miss
      // Source-ownership check: every referenced source id resolves in-space.
      { match: /id = ANY\(\$2::uuid\[\]\)/, rows: (values) => (values[1] as string[]).map((id) => ({ id })) },
      { match: /INSERT INTO "public"\."wk_change_proposals"/, rows: [{ id: 'prop-1' }] },
      {
        match: /SELECT id, current_revision_id FROM wk_concepts .* FOR UPDATE/,
        rows: (values) => [
          { id: `con-${values[1] as string}`, current_revision_id: values[1] === 'okf' ? 'rev-base' : null },
        ],
      },
      { match: /COALESCE\(MAX\(rev\), 0\)/, rows: [{ next: 4 }] },
      { match: /INSERT INTO "public"\."wk_claims"/, rows: [{ id: 'claim-1' }] },
      // Removal staging: the marker UPDATE must hit an ACTIVE row.
      { match: /SET removal_proposal_id/, rows: [{ id: 'rel-legacy' }] },
      { match: /unnest/, rows: [] },
    ]
  }

  test('stages proposal + revision + claims + citations + relations + outbox event', async () => {
    const { db, calls } = fakeDb(stagingRoutes())
    const result = await createProposal(db, 'space-1', stagingArgs)
    expect(result).toEqual({ proposal_id: 'prop-1', status: 'pending' })

    const sqls = calls.map((call) => call.sql)
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls.at(-1)).toBe('COMMIT')

    // Revision staged as proposed rev 4 against the CURRENT revision (the
    // stale-base anchor).
    const revisionInsert = calls.find((call) => call.sql.includes('"wk_concept_revisions"'))!
    expect(revisionInsert.values).toContain('proposed')
    expect(revisionInsert.values).toContain(4)
    expect(revisionInsert.values).toContain('rev-base')
    expect(revisionInsert.values).toContain('prop-1')

    const claimInsert = calls.find((call) => call.sql.includes('"wk_claims"'))!
    expect(claimInsert.values).toContain('proposed')
    expect(claimInsert.values).toContain('has_status')

    const citationInsert = calls.find((call) => call.sql.includes('"wk_citations"'))!
    expect(citationInsert.values).toContain('OKF is a draft')

    // Relation upsert re-adopts non-active rows for THIS proposal but never
    // downgrades an existing ACTIVE relation (guarded DO UPDATE).
    const relationInsert = calls.find((call) => call.sql.includes('INSERT INTO wk_relations'))!
    expect(relationInsert.sql).toContain("DO UPDATE SET status = 'proposed', proposal_id = EXCLUDED.proposal_id")
    expect(relationInsert.sql).toContain("WHERE wk_relations.status <> 'active'")
    expect(relationInsert.values).toEqual(['space-1', 'con-okf', 'con-graph-store', 'related', 'prop-1'])

    // Removal staging is a MARKER on the still-active row — pinned to the
    // exact SQL so it can never silently regress into a status flip, and
    // guarded on status='active' so staging cannot invent work for apply.
    const removalMark = calls.find((call) => call.sql.includes('SET removal_proposal_id'))!
    expect(removalMark.sql).toContain("status = 'active'")
    expect(removalMark.sql).toContain('RETURNING id')
    expect(removalMark.sql).not.toContain('SET status')
    expect(removalMark.values).toEqual(['space-1', 'con-okf', 'con-legacy-store', 'depends_on', 'prop-1'])

    // Outbox event inside the SAME transaction, §6.3 payload shape.
    const outbox = calls.find((call) => call.sql.includes('wk_outbox_events'))!
    const payload = JSON.parse(outbox.values[2] as string)
    expect(outbox.values[1]).toBe('wikikit.proposal.created')
    expect(payload).toMatchObject({
      proposal_id: 'prop-1',
      space: 'dev',
      concepts: ['okf'],
      claims_count: 1,
      contradictions_count: 0,
      relations_removed_count: 1,
    })
    // And the payload parses against the §6.3 wire contract (loose ids in the
    // fixture aside, the KEY SET and types must hold — swap in uuid-shaped
    // fixtures if this ever needs strictness).
    expect(Object.keys(payload).sort()).toEqual([
      'claims_count',
      'concepts',
      'contradictions_count',
      'proposal_id',
      'relations_removed_count',
      'source_ids',
      'space',
      'title',
    ])
    const outboxIndex = calls.indexOf(outbox)
    expect(calls.slice(outboxIndex).some((call) => call.sql === 'COMMIT')).toBe(true)
  })

  test('removal of a nonexistent or inactive relation is a 400, never silent', async () => {
    const routes = stagingRoutes().map((route) =>
      route.match.test('UPDATE x SET removal_proposal_id') ? { ...route, rows: [] } : route,
    )
    const { db } = fakeDb(routes)
    await expect(createProposal(db, 'space-1', stagingArgs)).rejects.toThrow(ValidationError)
    await expect(createProposal(db, 'space-1', stagingArgs)).rejects.toThrow(
      'no active depends_on relation from okf to legacy-store',
    )
  })

  test('removal endpoints are locked, never auto-created — a typo slug is a 400', async () => {
    const routes = stagingRoutes().map((route) =>
      route.match.test('SELECT id, current_revision_id FROM wk_concepts WHERE space_id = $1 AND slug = $2 FOR UPDATE')
        ? {
            ...route,
            rows: (values: unknown[]) =>
              values[1] === 'legacy-store'
                ? []
                : [{ id: `con-${values[1] as string}`, current_revision_id: values[1] === 'okf' ? 'rev-base' : null }],
          }
        : route,
    )
    const { db, calls } = fakeDb(routes)
    await expect(createProposal(db, 'space-1', stagingArgs)).rejects.toThrow('concept not found: legacy-store')
    expect(calls.some((call) => call.sql.includes('INSERT INTO "public"."wk_concepts"'))).toBe(false)
  })

  test('pending input_hash hit converges without staging anything', async () => {
    const { db, calls } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_spaces"/, rows: [{ slug: 'dev' }] },
      { match: /SELECT \* FROM "public"\."wk_change_proposals"/, rows: [{ id: 'prop-existing' }] },
    ])
    const result = await createProposal(db, 'space-1', stagingArgs)
    expect(result).toEqual({ proposal_id: 'prop-existing', status: 'pending' })
    expect(calls.some((call) => call.sql.startsWith('INSERT'))).toBe(false)
    // The dedup lookup pins space + hash + pending. stagingArgs carries a
    // relations_removed entry, so the EFFECTIVE hash is the documented salted
    // form: sha256(input_hash + canonical removal set) — a sourceless
    // removal-only proposal would otherwise collide with EVERY other one.
    const saltedHash = sha256Hex(`${INPUT_HASH}\nokf\tlegacy-store\tdepends_on`)
    const dedup = calls.find((call) => call.sql.includes('wk_change_proposals'))!
    expect(dedup.values).toEqual(['space-1', saltedHash, 'pending', 1])
  })

  test('dedup index race converges on the winner (23505 on the partial unique index)', async () => {
    const { db } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_spaces"/, rows: [{ slug: 'dev' }] },
      {
        // First lookup (inside tx) misses, post-rollback lookup finds the winner.
        match: /SELECT \* FROM "public"\."wk_change_proposals"/,
        rows: (_values, call) => (call === 1 ? [] : [{ id: 'prop-winner' }]),
      },
      { match: /id = ANY\(\$2::uuid\[\]\)/, rows: (values) => (values[1] as string[]).map((id) => ({ id })) },
      {
        match: /INSERT INTO "public"\."wk_change_proposals"/,
        error: Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'wk_change_proposals_pending_dedup',
        }),
      },
    ])
    const result = await createProposal(db, 'space-1', stagingArgs)
    expect(result).toEqual({ proposal_id: 'prop-winner', status: 'pending' })
  })

  test('unrelated 23505 is rethrown, not swallowed as dedup', async () => {
    const { db } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_spaces"/, rows: [{ slug: 'dev' }] },
      { match: /SELECT \* FROM "public"\."wk_change_proposals"/, rows: [] },
      { match: /id = ANY\(\$2::uuid\[\]\)/, rows: (values) => (values[1] as string[]).map((id) => ({ id })) },
      {
        match: /INSERT INTO "public"\."wk_change_proposals"/,
        error: Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'somewhere_else' }),
      },
    ])
    await expect(createProposal(db, 'space-1', stagingArgs)).rejects.toThrow('duplicate key')
  })

  test('rejects duplicate concept slugs at the boundary (one-current-revision invariant)', async () => {
    const { db, calls } = fakeDb([])
    const concept = stagingArgs.concepts[0]!
    await expect(
      createProposal(db, 'space-1', { ...stagingArgs, concepts: [concept, { ...concept }] }),
    ).rejects.toThrow(/unique within a proposal/)
    expect(calls.length).toBe(0)
  })

  test('rejects source ids that do not belong to the space (cross-tenant citation guard)', async () => {
    const { db, calls } = fakeDb([
      { match: /SELECT \* FROM "public"\."wk_spaces"/, rows: [{ slug: 'dev' }] },
      { match: /SELECT \* FROM "public"\."wk_change_proposals"/, rows: [] },
      // Ownership check finds NONE of the referenced ids in this space.
      { match: /id = ANY\(\$2::uuid\[\]\)/, rows: [] },
    ])
    const attempt = createProposal(db, 'space-1', stagingArgs)
    await expect(attempt).rejects.toThrow(/source id\(s\) not found in this space/)
    // Nothing staged, transaction rolled back.
    expect(calls.some((call) => call.sql.startsWith('INSERT'))).toBe(false)
    expect(calls.at(-1)!.sql).toBe('ROLLBACK')
  })

  test('an explicit base_revision_id wins over the staging-time pointer (synthesis-time anchor)', async () => {
    const BASE = '9d1e0dcb-5f0e-4b1a-9c1c-0000000000aa'
    const { db, calls } = fakeDb(stagingRoutes())
    await createProposal(db, 'space-1', {
      ...stagingArgs,
      concepts: [{ ...stagingArgs.concepts[0]!, base_revision_id: BASE }],
    })
    const revisionInsert = calls.find((call) => call.sql.includes('"wk_concept_revisions"'))!
    // The lock returns current_revision_id 'rev-base'; the caller-supplied
    // synthesis-time anchor must be staged instead.
    expect(revisionInsert.values).toContain(BASE)
    expect(revisionInsert.values).not.toContain('rev-base')
  })

  test('locks all involved concepts in sorted slug order (deadlock discipline)', async () => {
    const { db, calls } = fakeDb(stagingRoutes())
    await createProposal(db, 'space-1', {
      ...stagingArgs,
      concepts: [{ ...stagingArgs.concepts[0]!, slug: 'zeta', relations: [{ to_slug: 'alpha', kind: 'related' }] }],
    })
    const lockSlugs = calls
      .filter((call) => /FROM wk_concepts WHERE space_id = \$1 AND slug = \$2 FOR UPDATE/.test(call.sql))
      .map((call) => call.values[1])
    // Removal endpoints (okf, legacy-store from stagingArgs.relations_removed)
    // join the SAME sorted pass — one global lock order, no second discipline.
    expect(lockSlugs).toEqual([...lockSlugs].sort())
    expect(lockSlugs).toEqual(['alpha', 'legacy-store', 'okf', 'zeta'])
  })

  test('rejects an empty proposal (no concepts, no decisions) before SQL', async () => {
    const { db, calls } = fakeDb([])
    await expect(
      createProposal(db, 'space-1', {
        title: 'x',
        input_hash: INPUT_HASH,
        concepts: [],
        agent_meta: {},
        source_ids: [],
      }),
    ).rejects.toThrow()
    expect(calls.length).toBe(0)
  })

  test('unknown space aborts the transaction with NotFoundError', async () => {
    const { db, calls } = fakeDb([{ match: /SELECT \* FROM "public"\."wk_spaces"/, rows: [] }])
    await expect(createProposal(db, 'space-1', stagingArgs)).rejects.toBeInstanceOf(NotFoundError)
    expect(calls.at(-1)!.sql).toBe('ROLLBACK')
  })
})

describe('getProposal — structured diff', () => {
  const proposalRow = (status: string) => ({
    id: 'prop-1',
    space_id: 'space-1',
    status,
    title: 'Update okf',
    summary: 'S',
    input_hash: INPUT_HASH,
    source_ids: ['src-1'],
    agent_meta: { model: 'claude-sonnet-5', prompt_version: 'synthesize.v1' },
    reviewer: null,
    review_note: null,
    review_channel: null,
    reviewed_at: null,
    created_at: new Date('2026-07-01T10:00:00Z'),
  })

  function diffRoutes(status: string, claimRows: Rows): Route[] {
    return [
      { match: /SELECT \* FROM "public"\."wk_change_proposals"/, rows: [proposalRow(status)] },
      { match: /SELECT \* FROM "public"\."wk_spaces"/, rows: [{ slug: 'dev' }] },
      {
        match: /LEFT JOIN wk_concept_revisions base/,
        rows: [
          { concept_id: 'con-1', slug: 'okf', markdown: '# new', base_revision_id: 'rev-0', old_markdown: '# old' },
        ],
      },
      { match: /AS collides/, rows: claimRows },
      { match: /AS to_slug/, rows: [{ from_concept_id: 'con-1', to_slug: 'graph-store', kind: 'related' }] },
      {
        match: /FROM wk_decisions/,
        rows: [
          {
            slug: 'standard-webhooks',
            title: 'Use standard webhooks',
            context: 'Choose an integration boundary.',
            decision: 'Integrate through standard webhooks.',
            rationale: 'Keep consumers loosely coupled.',
            alternatives: [{ option: 'direct database access', reason_rejected: 'tight coupling' }],
          },
        ],
      },
    ]
  }

  const claim = (object: string, status: string, collides: boolean) => ({
    concept_id: 'con-1',
    subject: 'okf',
    predicate: 'has_status',
    object,
    status,
    collides,
  })

  test('pending: disputed group is the PROSPECTIVE collision set', async () => {
    const { db } = fakeDb(diffRoutes('pending', [claim('draft', 'proposed', true), claim('open', 'proposed', false)]))
    const detail = await getProposal(db, { id: 'prop-1' })
    expect(detail.space).toBe('dev')
    expect(detail.space_id).toBe('space-1')
    const concept = detail.concepts[0]!
    expect(concept.is_new).toBe(false)
    expect(concept.old_markdown).toBe('# old')
    expect(concept.claims_added.length).toBe(2)
    expect(concept.claims_disputed).toEqual([{ subject: 'okf', predicate: 'has_status', object: 'draft' }])
    expect(concept.claims_deprecated).toEqual([])
    expect(concept.relations_added).toEqual([{ to_slug: 'graph-store', kind: 'related' }])
    expect(detail.decisions).toEqual([
      {
        slug: 'standard-webhooks',
        title: 'Use standard webhooks',
        context: 'Choose an integration boundary.',
        decision: 'Integrate through standard webhooks.',
        rationale: 'Keep consumers loosely coupled.',
        alternatives: [{ option: 'direct database access', reason_rejected: 'tight coupling' }],
      },
    ])
  })

  test('approved: disputed group is the PERSISTED status, not the collision flag', async () => {
    const { db } = fakeDb(diffRoutes('approved', [claim('draft', 'disputed', false), claim('open', 'verified', true)]))
    const detail = await getProposal(db, { id: 'prop-1' })
    expect(detail.concepts[0]!.claims_disputed).toEqual([{ subject: 'okf', predicate: 'has_status', object: 'draft' }])
  })

  test('unknown proposal is a 404', async () => {
    const { db } = fakeDb([{ match: /wk_change_proposals/, rows: [] }])
    await expect(getProposal(db, { id: 'ghost' })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('renderProposalMarkdown', () => {
  const detail: ProposalDetail = {
    id: 'prop-1',
    space: 'dev',
    space_id: 'space-1',
    status: 'pending',
    title: 'Update okf',
    summary: 'New source contradicts readiness.',
    created_at: '2026-07-01T10:00:00.000Z',
    reviewer: null,
    review_note: null,
    review_channel: null,
    reviewed_at: null,
    source_ids: ['src-1'],
    agent_meta: { model: 'claude-sonnet-5', prompt_version: 'synthesize.v1' },
    concepts: [
      {
        slug: 'okf',
        is_new: false,
        old_markdown: '# old body',
        new_markdown: '# new body',
        claims_added: [{ subject: 'okf', predicate: 'has_status', object: 'draft-v0.1' }],
        claims_disputed: [{ subject: 'okf', predicate: 'has_status', object: 'draft-v0.1' }],
        claims_deprecated: [],
        relations_added: [{ to_slug: 'graph-store', kind: 'related' }],
      },
    ],
    decisions: [
      {
        slug: 'standard-webhooks',
        title: 'Use standard webhooks',
        context: 'Choose an integration boundary.',
        decision: 'Integrate through standard webhooks.',
        rationale: 'Keep consumers loosely coupled.',
        alternatives: [{ option: 'direct database access', reason_rejected: 'tight coupling' }],
      },
      {
        slug: 'no-rationale',
        title: 'No recorded rationale',
        context: 'A decision was recorded without supporting rationale.',
        decision: 'Keep the recorded choice.',
        rationale: '',
        alternatives: [],
      },
    ],
    relations_removed: [{ from_slug: 'okf', to_slug: 'legacy-store', kind: 'depends_on' }],
  }

  test('carries the whole review decision as readable markdown', () => {
    const markdown = renderProposalMarkdown(detail)
    expect(markdown).toContain('# Proposal: Update okf')
    expect(markdown).toContain('- **status:** pending')
    expect(markdown).toContain('- **agent:** claude-sonnet-5 (synthesize.v1)')
    expect(markdown).toContain('## Concept `okf` — update')
    expect(markdown).toContain('### Old revision')
    expect(markdown).toContain('# old body')
    expect(markdown).toContain('### New revision')
    expect(markdown).toContain('# new body')
    expect(markdown).toContain('### Claims added (1)')
    expect(markdown).toContain('### Claims disputed (1) ⚠')
    expect(markdown).toContain('- okf **has_status** draft-v0.1')
    expect(markdown).toContain('- related → [[graph-store]]')
    expect(markdown).toContain('## Relations removed (1) ⚠')
    expect(markdown).toContain('- [[okf]] depends_on → [[legacy-store]] — will be deactivated on approval')
    expect(markdown).toContain('## Decision `standard-webhooks` — Use standard webhooks')
    expect(markdown).toContain('### Context\n\nChoose an integration boundary.')
    expect(markdown).toContain('### Decision\n\nIntegrate through standard webhooks.')
    expect(markdown).toContain('### Rationale\n\nKeep consumers loosely coupled.')
    expect(markdown).toContain('"reason_rejected": "tight coupling"')
    expect(markdown).toContain('## Decision `no-rationale` — No recorded rationale')
    expect(markdown).toContain('_None provided._')
    expect(markdown).toContain('```json\n[]\n```')
    // Deterministic: same input, same output (it is served with an ETag-able body).
    expect(renderProposalMarkdown(detail)).toBe(markdown)
  })

  test('a new concept renders without an Old revision section', () => {
    const created = renderProposalMarkdown({
      ...detail,
      concepts: [{ ...detail.concepts[0]!, is_new: true, old_markdown: null, claims_disputed: [] }],
    })
    expect(created).toContain('## Concept `okf` — new')
    expect(created).not.toContain('### Old revision')
    expect(created).not.toContain('Claims disputed')
  })
})

describe('approve/reject — whitelisted RPC wrappers with error mapping', () => {
  test('approve unwraps the jsonb result', async () => {
    const { db, calls } = fakeDb([
      {
        match: /wk_apply_proposal/,
        rows: [
          {
            result: {
              proposal_id: 'prop-1',
              status: 'approved',
              concepts: ['okf'],
              claims_verified: 2,
              claims_disputed: 0,
            },
          },
        ],
      },
    ])
    const result = await approveProposal(db, { id: 'prop-1', reviewer: 'mike', note: 'lgtm' })
    expect(result).toMatchObject({ status: 'approved', claims_verified: 2 })
    expect(calls[0]!.values).toEqual(['prop-1', 'mike', 'lgtm', 'rest'])
  })

  test('maps the SQL error codes onto typed domain errors', async () => {
    const withError = (message: string) =>
      fakeDb([{ match: /wk_apply_proposal|wk_reject_proposal/, error: new Error(message) }]).db

    await expect(approveProposal(withError('proposal_not_found'), { id: 'x', reviewer: 'm' })).rejects.toBeInstanceOf(
      NotFoundError,
    )
    const notPending = approveProposal(withError('proposal_not_pending'), { id: 'x', reviewer: 'm' })
    await expect(notPending).rejects.toBeInstanceOf(ConflictError)
    await notPending.catch((error) => expect(error.code).toBe('proposal_not_pending'))
    const stale = approveProposal(withError('stale_base'), { id: 'x', reviewer: 'm' })
    await expect(stale).rejects.toBeInstanceOf(ConflictError)
    await stale.catch((error) => {
      expect(error.code).toBe('stale_base')
      expect(error.nextBestActions.length).toBeGreaterThan(0)
    })
    // Unknown errors pass through untouched (500 internal_error at the edge).
    await expect(approveProposal(withError('connection reset'), { id: 'x', reviewer: 'm' })).rejects.toThrow(
      'connection reset',
    )
  })

  test('stale_base marks the proposal failed (terminal, §9.2) before the 409 surfaces', async () => {
    const { db, calls } = fakeDb([
      { match: /wk_apply_proposal/, error: new Error('stale_base') },
      { match: /UPDATE "public"\."wk_change_proposals"/, rows: [] },
    ])
    const attempt = approveProposal(db, { id: 'prop-1', reviewer: 'mike' })
    await expect(attempt).rejects.toBeInstanceOf(ConflictError)
    const flip = calls.find((call) => call.sql.includes('UPDATE "public"."wk_change_proposals"'))!
    // Guarded flip: only a still-pending proposal is failed; the failed
    // status frees the (space_id, input_hash) pending-dedup slot.
    expect(flip.values).toContain('failed')
    expect(flip.values).toContain('pending')
    expect(flip.values).toContain('prop-1')
    expect(flip.values).toContain('mike')
  })

  test('proposal_not_pending does NOT touch the proposal row', async () => {
    const { db, calls } = fakeDb([{ match: /wk_apply_proposal/, error: new Error('proposal_not_pending') }])
    await expect(approveProposal(db, { id: 'prop-1', reviewer: 'mike' })).rejects.toBeInstanceOf(ConflictError)
    expect(calls.some((call) => call.sql.startsWith('UPDATE'))).toBe(false)
  })

  test('reject wraps wk_reject_proposal', async () => {
    const { db, calls } = fakeDb([
      {
        match: /wk_reject_proposal/,
        rows: [{ result: { proposal_id: 'prop-1', status: 'rejected', review_channel: 'rest' } }],
      },
    ])
    const result = await rejectProposal(db, { id: 'prop-1', reviewer: 'mike' })
    expect(result).toEqual({ proposal_id: 'prop-1', status: 'rejected', review_channel: 'rest' })
    expect(calls[0]!.sql).toContain('wk_reject_proposal')
  })
})

describe('listProposals', () => {
  test('filters by space and optional status', async () => {
    const { db, calls } = fakeDb([
      {
        match: /wk_change_proposals/,
        rows: [
          {
            id: 'prop-1',
            status: 'pending',
            title: 'T',
            summary: '',
            created_at: new Date('2026-07-01T10:00:00Z'),
            reviewer: null,
            reviewed_at: null,
          },
        ],
      },
    ])
    const items = await listProposals(db, 'space-1', { status: 'pending', limit: 10 })
    expect(items[0]).toMatchObject({ id: 'prop-1', status: 'pending', created_at: '2026-07-01T10:00:00.000Z' })
    expect(calls[0]!.sql).toContain('"space_id" = $1')
    expect(calls[0]!.sql).toContain('"status" = $2')
  })
})
