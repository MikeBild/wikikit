// concepts domain — read-model assembly and the visibility-by-construction
// rule (reads join over current_revision_id, never over a status filter).
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Db, type PoolLike } from '../../src/db/postgres.ts'
import { VISIBLE_CLAIM_STATUSES } from '../../src/domain/claims.ts'
import {
  BUILT_IN_SCAFFOLDING_KINDS,
  getConcept,
  getConceptHistory,
  getConceptIndex,
  listConcepts,
} from '../../src/domain/concepts.ts'
import { NotFoundError } from '../../src/domain/errors.ts'
import { lintSpace } from '../../src/domain/lint.ts'
import { encodeCursor } from '../../src/domain/sources.ts'
import { answerQuestion } from '../../src/query/answer.ts'
import { search, searchAcrossImports } from '../../src/query/search.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'

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

const summaryRow = (slug: string) => ({
  slug,
  title: `Title ${slug}`,
  summary: 'S',
  rev: 1,
  updated_at: new Date('2026-07-01T10:00:00Z'),
  // The evidence lateral rides in the SAME statement — its counts are columns
  // of this row, not a second query, and `measurable` is the marker test
  // evaluated beside them: a knowledge page, so the counts are what it reports.
  measurable: true,
  claims: 2,
  uncited_claims: 1,
  sources: 1,
})

describe('listConcepts', () => {
  test('unknown space is a 404 before any concept query', async () => {
    const { db } = fakeDb([{ match: /wk_spaces/, rows: [] }])
    await expect(listConcepts(db, 'nope', {}, { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('joins over current_revision_id, returns numeric epoch and keyset cursor', async () => {
    const { db, calls } = fakeDb([
      { match: /wk_spaces/, rows: [{ epoch: '7' }] }, // bigint arrives as string
      {
        match: /JOIN wk_concept_revisions r ON r\.id = c\.current_revision_id/,
        rows: [summaryRow('a'), summaryRow('b'), summaryRow('c')],
      },
    ])
    const page = await listConcepts(db, 'space-1', { limit: 2 }, { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
    expect(page.epoch).toBe(7)
    expect(page.items.map((item) => item.slug)).toEqual(['a', 'b'])
    expect(page.next_after).toBe(encodeCursor('b'))
    const listCall = calls.find((call) => call.sql.includes('current_revision_id'))!
    expect(listCall.sql).toContain('c.space_id = $1')
    expect(listCall.values).toEqual(['space-1', 3])
  })

  test('evidence is counted in the same statement, over VISIBLE claim statuses only', async () => {
    const { db, calls } = fakeDb([
      { match: /wk_spaces/, rows: [{ epoch: 1 }] },
      { match: /current_revision_id/, rows: [summaryRow('a')] },
    ])
    const page = await listConcepts(db, 'space-1', {}, { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
    expect(page.items[0]!.evidence).toEqual({ claims: 2, uncited_claims: 1, sources: 1 })
    // One statement for the page AND its evidence: N+1 here would be one query
    // per row on a list clamped to 200.
    expect(calls.filter((call) => call.sql.includes('wk_claims')).length).toBe(1)
    const listCall = calls.find((call) => call.sql.includes('current_revision_id'))!
    // The status list is DERIVED from the domain constant (no retyped strings
    // that can drift apart from the detail read)…
    expect(listCall.sql).toContain(`cl.status IN (${VISIBLE_CLAIM_STATUSES.map((s) => `'${s}'`).join(', ')})`)
    // …and staged claims stay out, whatever that constant grows into: an
    // unreviewed proposal must never make a page look evidenced.
    expect(listCall.sql).not.toContain('proposed')
    expect(listCall.sql).not.toContain('draft')
  })

  test('the counts are cast to int in SQL, because a bigint arrives as a string', async () => {
    // pg hands `count()` back as a STRING — bigint does not fit a JS number, so
    // the driver refuses to guess. Nothing downstream coerces: the row's
    // `claims` goes straight into `evidence.claims`. So the cast in the
    // statement is the ONLY thing standing between the console and `'0'`, which
    // is truthy, fails `=== 0`, and renders as a count nobody can compare or
    // sort. The three aggregates each need their own cast; two out of three is
    // a bug that shows up on one column.
    const { db, calls } = fakeDb([
      { match: /wk_spaces/, rows: [{ epoch: 1 }] },
      { match: /current_revision_id/, rows: [summaryRow('a')] },
    ])
    await listConcepts(db, 'space-1', {}, { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
    const listCall = calls.find((call) => call.sql.includes('current_revision_id'))!
    for (const column of ['claims', 'uncited_claims', 'sources']) {
      expect(listCall.sql, column).toMatch(new RegExp(`::int AS ${column}\\b`))
    }
  })

  test('the page is bounded BEFORE the evidence is counted', async () => {
    // The cost property, made structural instead of hoped for. If the LIMIT sat
    // on the outer query, the planner would be free to evaluate the lateral for
    // every concept in the SPACE and only then throw away all but 50 — turning
    // a 5000-page wiki's index into 5000 claim lookups per keystroke of paging.
    // The integration suite's query COUNT cannot catch this: it is one
    // statement either way, just a wildly more expensive one. So the shape is
    // asserted here: a LIMIT that closes before LATERAL is ever mentioned.
    const { db, calls } = fakeDb([
      { match: /wk_spaces/, rows: [{ epoch: 1 }] },
      { match: /current_revision_id/, rows: [summaryRow('a')] },
    ])
    await listConcepts(db, 'space-1', { limit: 50 }, { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS })
    const listCall = calls.find((call) => call.sql.includes('current_revision_id'))!
    const limit = listCall.sql.indexOf('LIMIT')
    const lateral = listCall.sql.indexOf('LATERAL')
    expect(limit).toBeGreaterThan(-1)
    expect(lateral).toBeGreaterThan(-1)
    expect(limit).toBeLessThan(lateral)
    // And the bound really is the page's, not a bound on the claims scan.
    expect(listCall.values.at(-1)).toBe(51)
  })

  test('after cursor becomes the slug keyset parameter', async () => {
    const { db, calls } = fakeDb([
      { match: /wk_spaces/, rows: [{ epoch: 0 }] },
      { match: /current_revision_id/, rows: [] },
    ])
    await listConcepts(
      db,
      'space-1',
      { limit: 10, after: encodeCursor('m') },
      { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS },
    )
    const listCall = calls.find((call) => call.sql.includes('current_revision_id'))!
    expect(listCall.sql).toContain('c.slug > $2')
    expect(listCall.values).toEqual(['space-1', 'm', 11])
  })
})

describe('getConcept', () => {
  test('assembles revision + visible claims with citations + outgoing relations', async () => {
    const { db, calls } = fakeDb([
      {
        match: /SELECT c\.id AS concept_id/,
        rows: [
          {
            concept_id: 'con-1',
            slug: 'okf',
            title: 'OKF',
            summary: 'Sum',
            markdown: '# OKF',
            rev: 3,
            updated_at: new Date('2026-07-01T10:00:00Z'),
            agent_meta: { model: 'claude-sonnet-5' },
          },
        ],
      },
      {
        match: /wk_claims/,
        rows: [
          {
            id: 'cl-1',
            subject: 'okf',
            predicate: 'is',
            object: 'a spec',
            status: 'verified',
            confidence: 0.9,
            valid_from: null,
            valid_until: null,
            created_at: new Date('2026-07-01T10:00:00Z'),
            agent_meta: {},
          },
        ],
      },
      { match: /wk_citations/, rows: [{ claim_id: 'cl-1', source_id: 'src-1', quote: 'q', locator: '' }] },
      { match: /rel\.from_concept_id = \$2/, rows: [{ to_slug: 'graph-store', kind: 'related' }] },
    ])
    const detail = await getConcept(db, 'space-1', { slug: 'okf' })
    expect(detail).toMatchObject({
      slug: 'okf',
      title: 'OKF',
      markdown: '# OKF',
      rev: 3,
      updated_at: '2026-07-01T10:00:00.000Z',
      agent_meta: { model: 'claude-sonnet-5' },
      relations: [{ to_slug: 'graph-store', kind: 'related' }],
    })
    expect(detail.claims[0]!.citations).toEqual([{ source_id: 'src-1', quote: 'q', locator: '' }])
    // The read joins the current pointer AND only active relations.
    expect(calls[0]!.sql).toContain('r.id = c.current_revision_id')
    const relationCall = calls.find((call) => call.sql.includes('from_concept_id'))!
    expect(relationCall.sql).toContain(`rel.status = 'active'`)
  })

  test('concept without a current revision reads as 404 (staged content is invisible)', async () => {
    const { db } = fakeDb([{ match: /SELECT c\.id AS concept_id/, rows: [] }])
    await expect(getConcept(db, 'space-1', { slug: 'staged-only' })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('getConceptHistory', () => {
  test('unknown concept is a 404', async () => {
    const { db } = fakeDb([{ match: /wk_concepts/, rows: [] }])
    await expect(getConceptHistory(db, 'space-1', { slug: 'ghost' })).rejects.toBeInstanceOf(NotFoundError)
  })

  test('returns ALL statuses newest-first with agent_meta (the audit surface)', async () => {
    const { db, calls } = fakeDb([
      { match: /wk_concepts/, rows: [{ id: 'con-1' }] },
      {
        match: /wk_concept_revisions/,
        rows: [
          {
            id: 'rev-2',
            rev: 2,
            status: 'proposed',
            title: 'T2',
            summary: '',
            base_revision_id: 'rev-1',
            proposal_id: 'prop-2',
            agent_meta: { model: 'claude-sonnet-5', prompt_version: 'synthesize.v1' },
            created_at: new Date('2026-07-02T10:00:00Z'),
          },
          {
            id: 'rev-1',
            rev: 1,
            status: 'current',
            title: 'T1',
            summary: '',
            base_revision_id: null,
            proposal_id: 'prop-1',
            agent_meta: { model: 'manual', prompt_version: 'manual' },
            created_at: new Date('2026-07-01T10:00:00Z'),
          },
        ],
      },
    ])
    const history = await getConceptHistory(db, 'space-1', { slug: 'okf' })
    expect(history.map((revision) => revision.status)).toEqual(['proposed', 'current'])
    expect(history[0]!.agent_meta).toEqual({ model: 'claude-sonnet-5', prompt_version: 'synthesize.v1' })
    expect(history[1]!.created_at).toBe('2026-07-01T10:00:00.000Z')
    const revisionsCall = calls.find((call) => call.sql.includes('wk_concept_revisions'))!
    expect(revisionsCall.sql).toContain('ORDER BY "rev" DESC')
  })
})

describe('getConceptIndex', () => {
  test('projects slug/title/summary of readable concepts only', async () => {
    const { db, calls } = fakeDb([{ match: /current_revision_id/, rows: [{ slug: 'a', title: 'A', summary: 's' }] }])
    expect(await getConceptIndex(db, 'space-1')).toEqual([{ slug: 'a', title: 'A', summary: 's' }])
    expect(calls[0]!.sql).toContain('r.id = c.current_revision_id')
    expect(calls[0]!.values).toEqual(['space-1'])
  })
})

/**
 * The hole `ScaffoldingOptions` used to leave open, closed by the compiler and
 * kept closed here.
 *
 * WHAT USED TO BE HERE. A source scan: four hand-listed boundary modules
 * (routes.ts, tools.ts, answer.ts, search.ts) read as text, every call to one of
 * six reads carved out by balanced parentheses, and an assertion that the
 * argument text mentioned `scaffoldingKinds` or a bag carrying it. It existed
 * because the markers rode in as an OPTIONAL trailing option: omitting one was
 * not a type error, it resolved silently to WikiKit's own marker — right for a
 * caller with no installation in scope, wrong for every request.
 *
 * WHY IT IS DELETED RATHER THAN KEPT BESIDE THIS. The option is required now
 * (`ScaffoldingOptions` here, `SearchDeps` in src/query/search.ts, the `deps`
 * bag of `answerQuestion`), so a call that forgets is a type error — in EVERY
 * module, not in the four somebody remembered to list. That is the scan's whole
 * assertion, made by the compiler over a strictly wider domain, and the list was
 * the scan's own weakness: a fifth boundary had to be added by hand, by the same
 * person who had just forgotten the argument.
 *
 * It covered nothing the types do not. The one thing types cannot check —
 * whether the value came from `deps.config` or from a literal — the scan could
 * not check either: it matched the IDENTIFIER, so `{ scaffoldingKinds: [] }`
 * satisfied it exactly as it typechecks today. That half is behaviour, and
 * test/integration/lint-rules.test.ts asserts it by driving both surfaces with a
 * configured marker set and with the built-in one.
 *
 * WHAT REPLACES IT is the block below, which is the compiler made to say so out
 * loud. Each `@ts-expect-error` is itself checked by `tsc --noEmit`: if the
 * error it names ever stops happening, typecheck fails with "Unused
 * '@ts-expect-error' directive". So these lines do not assert that omission
 * fails today — the whole build asserts that. They fail the build on the day
 * somebody makes the field optional again, which is the one regression the type
 * system cannot defend against on its own, and the reason a guarantee this cheap
 * to delete still needs a witness.
 */
// Never called, and never should be: the assertions are the COMPILER'S, and
// every call below is written to be rejected. `_` is the house mark for
// deliberately unused (eslint varsIgnorePattern).
async function _callSitesThatForgetTheMarkers(db: Db) {
  const llm = createFakeProvider()
  // @ts-expect-error the installation's markers are a required 4th argument
  await listConcepts(db, 'space-1', {})
  // @ts-expect-error and an EMPTY bag is not a forwarded configuration either
  await listConcepts(db, 'space-1', {}, {})
  // @ts-expect-error lintSpace requires the bag its fault rules thread down
  await lintSpace(db, 'space-1')
  // @ts-expect-error which has to carry the field, not merely be an object
  await lintSpace(db, 'space-1', {})
  // @ts-expect-error SearchDeps leaves llm and vector optional; not this
  await search(db, 'space-1', { q: 'okf' }, { vector: { available: false } })
  // @ts-expect-error the federated wrapper hands the same bag on, so it asks too
  await searchAcrossImports(db, { id: 'space-1', slug: 'home', settings: {} }, { q: 'okf' })
  // @ts-expect-error and so does the answer path, whose retrieval half is search
  await answerQuestion(db, 'space-1', llm, { question: 'okf?' })
}
