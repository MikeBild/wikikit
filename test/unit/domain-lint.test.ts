// lint domain — the fixed severity table and per-rule finding shapes against
// a routing fake pool. Rule SQL correctness (visibility joins) is covered by
// the integration suite; here we pin the contract surface.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { BUILT_IN_SCAFFOLDING_KINDS } from '../../src/domain/concepts.ts'
import { LINT_SEVERITY, lintSpace } from '../../src/domain/lint.ts'

interface Call {
  sql: string
  values: unknown[]
}
type Rows = Record<string, unknown>[]

function fakeDb(routes: { match: RegExp; rows: Rows }[]) {
  const calls: Call[] = []
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    const route = routes.find((entry) => entry.match.test(sql))
    return { rows: route?.rows ?? [], rowCount: route?.rows.length ?? 0 }
  }
  const pool: PoolLike = { query, connect: async () => ({ query, release() {} }), end: async () => {} }
  const { db } = createPostgres({ databaseUrl: 'postgresql://stub' } as Config, { pool })
  return { db, calls }
}

describe('severity mapping (fixed by contract — do not tune)', () => {
  test('matches CONTRACTS §4 exactly', () => {
    expect(LINT_SEVERITY).toEqual({
      contradictions: 'error',
      'missing-citations': 'error',
      'broken-relations': 'error',
      'stale-claims': 'warn',
      'orphan-concepts': 'warn',
      'unsourced-concepts': 'warn',
      'stub-concepts': 'warn',
      'scaffolded-claims': 'warn',
      'empty-concepts': 'info',
      'unreviewed-proposals': 'info',
      'dangling-sources': 'info',
      'tombstoned-sources': 'warn',
      'broken-cross-space-links': 'warn',
    })
  })
})

describe('lintSpace', () => {
  // Route disambiguation uses each rule's distinctive SQL fragment.
  const routes = [
    {
      match: /"wk_spaces"/,
      rows: [{ settings: { functional_predicates: ['has_status'] } }],
    },
    {
      match: /a\.id < b\.id/,
      rows: [
        {
          subject: 'okf',
          predicate: 'has_status',
          context: '',
          a_id: 'cl-1',
          b_id: 'cl-2',
          a_object: 'draft',
          b_object: 'final',
          a_slug: 'okf',
          b_slug: 'okf',
        },
      ],
    },
    {
      match: /NOT EXISTS \(SELECT 1 FROM wk_citations ci WHERE ci\.claim_id = cl\.id\)/,
      rows: [{ id: 'cl-3', subject: 's', predicate: 'p', object: 'o', slug: 'alpha' }],
    },
    {
      match: /f\.current_revision_id IS NULL OR t\.current_revision_id IS NULL/,
      rows: [{ id: 'rel-1', from_slug: 'alpha', to_slug: 'ghost', kind: 'related', broken_side: 'ghost' }],
    },
    {
      match: /cl\.valid_until < now\(\)/,
      rows: [
        {
          id: 'cl-4',
          subject: 's',
          predicate: 'p',
          object: 'o',
          valid_until: new Date('2026-01-01T00:00:00Z'),
          slug: 'beta',
        },
      ],
    },
    // Must precede the two NOT EXISTS routes below: the stub rule's query
    // contains BOTH of their fragments (that is the point of the rule), so
    // without a fragment of its own it would silently answer with whatever
    // orphan-concepts was handed.
    { match: /r\.markdown ~ '\^\[\[:space:\]\]\*\$'/, rows: [{ slug: 'blank' }] },
    { match: /SELECT 1 FROM wk_relations rel/, rows: [{ slug: 'lonely' }] },
    { match: /SELECT 1 FROM wk_claims cl/, rows: [{ slug: 'stub' }] },
    {
      match: /FROM wk_change_proposals/,
      rows: [{ id: 'prop-1', title: 'Pending one', created_at: new Date('2026-07-01T00:00:00Z') }],
    },
    {
      match: /st\.deleted_at IS NOT NULL/,
      rows: [
        {
          id: 'cl-9',
          subject: 'okf',
          predicate: 'hosted_at',
          object: 'drive',
          slug: 'okf',
          external_source_id: 'gdrive:file123',
          source_id: 'src-9',
        },
      ],
    },
    {
      match: /FROM wk_sources s/,
      rows: [{ id: 'src-1', title: null, kind: 'url' }],
    },
    {
      // scaffolded-claims asks the SAME lateral as unsourced-concepts and is
      // told apart by its own predicate: the contradiction is claims > 0 on a
      // marked page, not sources = 0 on an unmarked one.
      match: /ev\.claims > 0/,
      rows: [{ slug: 'marked-but-claiming', claims: 2 }],
    },
    {
      // The two shapes an unsourced page comes in: no claims at all, and
      // claims that quote nothing. Both are one finding with the same fix.
      match: /ev\.sources = 0/,
      rows: [
        { slug: 'handwritten', claims: 0, sources: 0 },
        { slug: 'unquoted', claims: 3, sources: 0 },
      ],
    },
  ]

  test('collects every rule, orders error → warn → info and counts correctly', async () => {
    const { db, calls } = fakeDb(routes)
    const report = await lintSpace(db, 'space-1', { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })

    expect(report.findings.map((finding) => finding.rule)).toEqual([
      'contradictions',
      'missing-citations',
      'broken-relations',
      'stale-claims',
      'orphan-concepts',
      'unsourced-concepts',
      'unsourced-concepts',
      'tombstoned-sources',
      'stub-concepts',
      'scaffolded-claims',
      'empty-concepts',
      'unreviewed-proposals',
      'dangling-sources',
    ])
    expect(report.counts).toEqual({ error: 3, warn: 7, info: 3 })

    // Every rule query is space-scoped with the SAME parameter. (The
    // cross-space-link scan found no [[space:slug]] links, so it issued only
    // its revision scan — no follow-up queries.)
    expect(calls.length).toBe(14)
    for (const call of calls.slice(1)) {
      expect(call.sql).toContain('space_id = $1')
      expect(call.values[0]).toBe('space-1')
    }
  })

  test('finding shapes carry the contract fields', async () => {
    const { db } = fakeDb(routes)
    const { findings } = await lintSpace(db, 'space-1', { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
    const byRule = new Map(findings.map((finding) => [finding.rule, finding]))

    expect(byRule.get('contradictions')).toMatchObject({
      severity: 'error',
      concept_slug: 'okf',
      message: 'contradictory frame "okf has_status": draft vs final',
      details: { objects: ['draft', 'final'], claim_ids: ['cl-1', 'cl-2'] },
    })
    expect(byRule.get('missing-citations')).toMatchObject({ claim_id: 'cl-3', concept_slug: 'alpha' })
    expect(byRule.get('broken-relations')!.message).toContain('unreadable concept "ghost"')
    expect(byRule.get('stale-claims')).toMatchObject({ claim_id: 'cl-4', concept_slug: 'beta' })
    expect(byRule.get('orphan-concepts')).toMatchObject({ concept_slug: 'lonely' })
    expect(byRule.get('empty-concepts')).toMatchObject({ concept_slug: 'stub' })
    expect(byRule.get('stub-concepts')).toEqual({
      rule: 'stub-concepts',
      severity: 'warn',
      message:
        'concept "blank" is an empty stub: no text, no claims, and nothing links to or from it — delete it, or give it content',
      concept_slug: 'blank',
    })
    // Both readings of the contradiction are in the line, because the linter
    // cannot know which one holds, and the count is the measurement the index
    // is not printing for this page.
    expect(byRule.get('scaffolded-claims')).toEqual({
      rule: 'scaffolded-claims',
      severity: 'warn',
      message:
        'concept "marked-but-claiming" is marked as a reference target but holds 2 visible claims: either the marker is wrong for this page, or those claims belong on the page it points at — until one of the two is fixed its evidence is withheld from the index',
      concept_slug: 'marked-but-claiming',
      details: { claims: 2 },
    })
    expect(byRule.get('unreviewed-proposals')!.details).toMatchObject({ proposal_id: 'prop-1' })
    expect(byRule.get('dangling-sources')!.details).toEqual({ source_id: 'src-1' })
    // Both unsourced findings, in order — a finding that only states the fault
    // is a complaint, so each one carries the fix in its message.
    const unsourced = findings.filter((finding) => finding.rule === 'unsourced-concepts')
    expect(unsourced).toEqual([
      {
        rule: 'unsourced-concepts',
        severity: 'warn',
        message:
          'concept "handwritten" rests on no archived source: it makes no claims at all — ingest a source and let synthesis quote it',
        concept_slug: 'handwritten',
        details: { claims: 0 },
      },
      {
        rule: 'unsourced-concepts',
        severity: 'warn',
        message:
          'concept "unquoted" rests on no archived source: 3 claims, none of them quoting one — ingest a source and let synthesis quote it',
        concept_slug: 'unquoted',
        details: { claims: 3 },
      },
    ])

    expect(byRule.get('tombstoned-sources')).toMatchObject({
      severity: 'warn',
      claim_id: 'cl-9',
      concept_slug: 'okf',
      details: { source_id: 'src-9', external_source_id: 'gdrive:file123' },
    })
  })

  test('a clean space reports zero findings and zero counts', async () => {
    const { db } = fakeDb([])
    expect(await lintSpace(db, 'space-1', { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })).toEqual({
      findings: [],
      counts: { error: 0, warn: 0, info: 0 },
    })
  })

  test('contradictions pairs ALL visible claims (0021: context + interval + normalized object)', async () => {
    // Two colliding claims approved inside one proposal both stay 'verified'
    // (the apply-time dispute flip only joins across proposals) — lint must
    // still see the frame; the pairwise join covers verified+disputed on
    // BOTH sides and mirrors the apply-time flip-5 semantics exactly.
    const { db, calls } = fakeDb(routes)
    await lintSpace(db, 'space-1', { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
    const sql = calls.find((call) => call.sql.includes('a.id < b.id'))!.sql
    expect(sql).toContain("a.status IN ('verified', 'disputed')")
    expect(sql).toContain("b.status IN ('verified', 'disputed')")
    expect(sql).toContain('a.predicate = ANY($2::text[])')
    expect(sql).toContain("coalesce(b.context, '') = coalesce(a.context, '')")
    expect(sql).toContain('coalesce(a.object_normalized, a.object) <> coalesce(b.object_normalized, b.object)')
    expect(sql).toContain("coalesce(a.valid_from, '-infinity'::timestamptz)")
  })

  test('a space with no functional predicates reports no frame contradictions', async () => {
    const noFunctions = routes.map((route, index) => (index === 0 ? { ...route, rows: [{ settings: {} }] } : route))
    const { db, calls } = fakeDb(noFunctions)
    const report = await lintSpace(db, 'space-1', { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
    expect(report.findings.some((finding) => finding.rule === 'contradictions')).toBe(false)
    expect(calls.some((call) => call.sql.includes('GROUP BY cl.subject, cl.predicate'))).toBe(false)
  })
})
