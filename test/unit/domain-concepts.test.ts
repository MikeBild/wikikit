// concepts domain — read-model assembly and the visibility-by-construction
// rule (reads join over current_revision_id, never over a status filter).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../../src/config.ts'
import { createPostgres, type PoolLike } from '../../src/db/postgres.ts'
import { VISIBLE_CLAIM_STATUSES } from '../../src/domain/claims.ts'
import { getConcept, getConceptHistory, getConceptIndex, listConcepts } from '../../src/domain/concepts.ts'
import { NotFoundError } from '../../src/domain/errors.ts'
import { encodeCursor } from '../../src/domain/sources.ts'

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
  // of this row, not a second query.
  claims: 2,
  uncited_claims: 1,
  sources: 1,
})

describe('listConcepts', () => {
  test('unknown space is a 404 before any concept query', async () => {
    const { db } = fakeDb([{ match: /wk_spaces/, rows: [] }])
    await expect(listConcepts(db, 'nope', {})).rejects.toBeInstanceOf(NotFoundError)
  })

  test('joins over current_revision_id, returns numeric epoch and keyset cursor', async () => {
    const { db, calls } = fakeDb([
      { match: /wk_spaces/, rows: [{ epoch: '7' }] }, // bigint arrives as string
      {
        match: /JOIN wk_concept_revisions r ON r\.id = c\.current_revision_id/,
        rows: [summaryRow('a'), summaryRow('b'), summaryRow('c')],
      },
    ])
    const page = await listConcepts(db, 'space-1', { limit: 2 })
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
    const page = await listConcepts(db, 'space-1', {})
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
    await listConcepts(db, 'space-1', {})
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
    await listConcepts(db, 'space-1', { limit: 50 })
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
    await listConcepts(db, 'space-1', { limit: 10, after: encodeCursor('m') })
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
 * The hole `ScaffoldingOptions` leaves open, closed structurally.
 *
 * The installation's scaffolding markers ride in as an OPTIONAL trailing
 * option, and omitting it is not a type error — it silently resolves to
 * BUILT_IN_SCAFFOLDING_KINDS, WikiKit's own marker and nothing else. That
 * default is right for a unit test with no installation in scope and wrong for
 * every request: on a deployment carrying the shipped fallback it turns pages
 * whose evidence is deliberately ABSENT back into a measured `{claims: 0, …}`,
 * the sentence "this page rests on nothing" printed about pages that hold
 * nothing by design. A configuration that is correct in src/config.ts and
 * forgotten at the call site is worse than no configuration, because it is
 * wrong while looking configured.
 *
 * Making the parameter required would close it in the type system and cost
 * about thirty test call sites — but it would not actually buy the guarantee.
 * `{}` satisfies a required options bag exactly as well as omitting an optional
 * one, so the compiler would be enforcing that somebody typed two characters,
 * not that they forwarded the configuration; and it cannot reach `search` and
 * `answerQuestion` at all, whose deps bags are legitimately optional for `llm`
 * and `vector`. So the rule is stated here instead, where it can be about the
 * thing that matters: a call from a module that HOLDS the configuration must
 * pass it.
 *
 * Scanned as source rather than exercised as behaviour because the failure
 * being guarded is a call site that does not exist yet — a handler somebody
 * adds next release, which no behavioural test would cover precisely because
 * they forgot it. The same reason drift.test.ts reads src/config.ts as text.
 */
describe('every composition boundary forwards the installation scaffolding markers', () => {
  // The modules that hold `deps.config` (or a deps bag filled from it) and call
  // a read which acts on the markers. A new entry here is a deliberate act; a
  // new CALL inside one of these files is caught below without any edit.
  const BOUNDARIES = ['src/http/routes.ts', 'src/mcp/tools.ts', 'src/query/answer.ts', 'src/query/search.ts']
  // Every read that takes the markers, directly or through a deps bag.
  const READS = [
    'listConcepts',
    'conceptEvidenceBySlug',
    'lintSpace',
    'search',
    'searchAcrossImports',
    'answerQuestion',
  ]
  // Types that carry the markers as a field, so a parameter annotated with one
  // of them is forwarding rather than dropping. Add a type here only after
  // giving it a `scaffoldingKinds` field.
  const CARRYING_TYPES = ['SearchDeps', 'ScaffoldingOptions']

  /**
   * Argument text of each CALL to `name`, by balanced parentheses. The
   * declaration of the same name is skipped — `src/query/search.ts` both
   * defines `search` and calls `conceptEvidenceBySlug`, and a parameter list is
   * not a call site.
   */
  function callArguments(source: string, name: string): string[] {
    const found: string[] = []
    const call = new RegExp(String.raw`(?<![\w.])(?<!function )${name}\s*\(`, 'g')
    for (const match of source.matchAll(call)) {
      let depth = 1
      let index = match.index + match[0].length
      const start = index
      while (index < source.length && depth > 0) {
        if (source[index] === '(') depth += 1
        else if (source[index] === ')') depth -= 1
        index += 1
      }
      found.push(source.slice(start, index - 1))
    }
    return found
  }

  for (const file of BOUNDARIES) {
    test(`${file} passes scaffoldingKinds to every read that takes it`, () => {
      const source = readFileSync(join(import.meta.dir, '../..', file), 'utf8')
      for (const name of READS) {
        for (const args of callArguments(source, name)) {
          // A call may name the markers inline, or hand over a bag that carries
          // them — resolved one level, because that IS how these modules do it
          // (`const searchDeps = { …, scaffoldingKinds }` in both transports,
          // and `searchAcrossImports` forwarding its own `deps: SearchDeps`
          // straight through). A rule that refused either would only teach the
          // next author to route around the rule.
          const carriers = [...args.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0])
          const forwarded =
            args.includes('scaffoldingKinds') ||
            carriers.some(
              (id) =>
                new RegExp(String.raw`const\s+${id}\s*=\s*\{[^}]*scaffoldingKinds`).test(source) ||
                new RegExp(String.raw`\b${id}\s*:\s*(${CARRYING_TYPES.join('|')})\b`).test(source),
            )
          expect(
            forwarded,
            `${file}: ${name}(${args.replace(/\s+/g, ' ').trim()}) does not forward scaffoldingKinds`,
          ).toBe(true)
        }
      }
    })
  }
})
