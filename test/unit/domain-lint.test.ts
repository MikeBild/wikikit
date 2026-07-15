// lint domain — the fixed severity table and per-rule finding shapes against
// a routing fake pool. Rule SQL correctness (visibility joins) is covered by
// the integration suite; here we pin the contract surface.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
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
      'empty-concepts': 'info',
      'unreviewed-proposals': 'info',
      'dangling-sources': 'info',
    })
  })
})

describe('lintSpace', () => {
  // Route disambiguation uses each rule's distinctive SQL fragment.
  const routes = [
    {
      match: /GROUP BY cl\.subject, cl\.predicate/,
      rows: [
        {
          subject: 'okf',
          predicate: 'has_status',
          objects: ['draft', 'final'],
          claim_ids: ['cl-1', 'cl-2'],
          slugs: ['okf'],
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
    { match: /SELECT 1 FROM wk_relations rel/, rows: [{ slug: 'lonely' }] },
    { match: /SELECT 1 FROM wk_claims cl/, rows: [{ slug: 'stub' }] },
    {
      match: /FROM wk_change_proposals/,
      rows: [{ id: 'prop-1', title: 'Pending one', created_at: new Date('2026-07-01T00:00:00Z') }],
    },
    {
      match: /FROM wk_sources s/,
      rows: [{ id: 'src-1', title: null, kind: 'url' }],
    },
  ]

  test('collects every rule, orders error → warn → info and counts correctly', async () => {
    const { db, calls } = fakeDb(routes)
    const report = await lintSpace(db, 'space-1')

    expect(report.findings.map((finding) => finding.rule)).toEqual([
      'contradictions',
      'missing-citations',
      'broken-relations',
      'stale-claims',
      'orphan-concepts',
      'empty-concepts',
      'unreviewed-proposals',
      'dangling-sources',
    ])
    expect(report.counts).toEqual({ error: 3, warn: 2, info: 3 })

    // Every rule query is space-scoped with the SAME parameter.
    expect(calls.length).toBe(8)
    for (const call of calls) {
      expect(call.sql).toContain('space_id = $1')
      expect(call.values).toEqual(['space-1'])
    }
  })

  test('finding shapes carry the contract fields', async () => {
    const { db } = fakeDb(routes)
    const { findings } = await lintSpace(db, 'space-1')
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
    expect(byRule.get('unreviewed-proposals')!.details).toMatchObject({ proposal_id: 'prop-1' })
    expect(byRule.get('dangling-sources')!.details).toEqual({ source_id: 'src-1' })
  })

  test('a clean space reports zero findings and zero counts', async () => {
    const { db } = fakeDb([])
    expect(await lintSpace(db, 'space-1')).toEqual({ findings: [], counts: { error: 0, warn: 0, info: 0 } })
  })

  test('contradictions groups ALL visible claims by frame, not only disputed ones', async () => {
    // Two colliding claims approved inside one proposal both stay 'verified'
    // (the apply-time dispute flip only joins across proposals) — lint must
    // still see the frame, so the rule groups verified+disputed with more
    // than one distinct object instead of filtering on status='disputed'.
    const { db, calls } = fakeDb(routes)
    await lintSpace(db, 'space-1')
    const sql = calls[0]!.sql
    expect(sql).toContain("cl.status IN ('verified', 'disputed')")
    expect(sql).toContain('HAVING count(DISTINCT cl.object) > 1')
    expect(sql).not.toContain("cl.status = 'disputed'")
  })
})
