// Two lint rules against real Postgres, both of which are claims about what a
// REPORT SAYS rather than about the shape of a statement — which is why they
// live here and not beside the fake-pool unit tests. A stub answers whatever
// rows it was handed; only a real database can tell you whether a space that
// declares its predicates one way gets the same findings as a space that
// declares them the other, or whether a page the concept list calls sourced is
// the same page the linter calls sourced.
//
//   1. lintProposal's `contradictions` rule. Its message promises "approval
//      disputes both", so the set it reports must be the set
//      wk_apply_proposal flip 5 (0022) would actually dispute: the declared
//      functional predicates from BOTH representations (the typed 0021
//      `predicate_defs` registry and the legacy `functional_predicates`
//      array), refined by context, normalized object and validity overlap.
//      Each space below declares its predicates a different way and gets the
//      same treatment.
//
//   2. The `unsourced-concepts` rule — a readable page across whose visible
//      claims there is not one citation. The load-bearing property is that it
//      agrees with the evidence summary the concept list renders, because the
//      two are read by the same person minutes apart.
//
// RUN_INTEGRATION=1 gated.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { listConcepts } from '../../src/domain/concepts.ts'
import { lintProposal, lintSpace } from '../../src/domain/lint.ts'
import { createProposal } from '../../src/domain/proposals.ts'
import { createSource } from '../../src/domain/sources.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

let database: Database
let db: Db

const hex64 = () => randomUUID().replaceAll('-', '').padEnd(64, '0')
const AGENT_META = { model: 'manual', prompt_version: 'manual' }

interface Claim {
  subject: string
  predicate: string
  object: string
  context?: string | null
  citations?: { source_id: string; quote: string; locator: string }[]
}

async function seedSpace(slug: string, settings: Record<string, unknown>): Promise<string> {
  const [space] = await db.insert<{ id: string }>('wk_spaces', {
    slug,
    name: slug,
    settings: JSON.stringify(settings),
  })
  return space!.id
}

/** Stage one concept carrying `claims`; returns the pending proposal id. */
async function stage(spaceId: string, slug: string, claims: Claim[], sourceIds: string[] = []): Promise<string> {
  const { proposal_id } = await createProposal(db, spaceId, {
    title: `Stage ${slug}`,
    input_hash: hex64(),
    source_ids: sourceIds,
    agent_meta: AGENT_META,
    concepts: [{ slug, title: slug, markdown: `# ${slug}`, claims }],
  })
  return proposal_id
}

async function stageAndApprove(spaceId: string, slug: string, claims: Claim[], sourceIds: string[] = []) {
  await db.call('wk_apply_proposal', [await stage(spaceId, slug, claims, sourceIds), 'lint-rules-test'])
}

const contradictionsOf = async (spaceId: string, proposalId: string): Promise<string[]> =>
  (await lintProposal(db, spaceId, proposalId)).findings
    .filter((finding) => finding.rule === 'contradictions')
    .map((finding) => finding.message)

describe('lint rules (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_lint_rules')
    await runMigrations({ databaseUrl: url })
    database = createPostgres({ databaseUrl: url } as Config)
    db = database.db
  })

  afterAll(async () => {
    if (integration) await database?.close()
  })

  // -------------------------------------------------------------- proposal
  //
  // The review screen's "will this approval hurt?" panel. Before this was
  // fixed the rule read only settings.functional_predicates, so the first
  // test below reported NOTHING for a space that had declared its predicates
  // properly, and the second reported a dispute that approval would not
  // create.

  it('proposal contradictions: a space declaring predicates through the typed registry gets findings', async () => {
    const spaceId = await seedSpace('registry-space', {
      predicate_defs: [
        { name: 'has_status', type: 'string', functional: true },
        {
          name: 'max_upload',
          type: 'quantity',
          functional: true,
          unit: { canonical: 'MiB', accept: { GiB: 1024, MiB: 1 } },
        },
        // Declared but NOT functional: different objects are complementary
        // facts, and approval disputes nothing.
        { name: 'mentions', type: 'string', functional: false },
      ],
    })
    await stageAndApprove(spaceId, 'reg-base', [
      { subject: 'okf', predicate: 'has_status', object: 'draft' },
      { subject: 'okf', predicate: 'max_upload', object: '1 GiB' },
      { subject: 'okf', predicate: 'mentions', object: 'archives' },
    ])
    const proposalId = await stage(spaceId, 'reg-change', [
      { subject: 'okf', predicate: 'has_status', object: 'final' },
      // Canonically the SAME quantity — the registry's own unit factors say
      // so, and flip 5 compares normalized objects.
      { subject: 'okf', predicate: 'max_upload', object: '1024 MiB' },
      { subject: 'okf', predicate: 'mentions', object: 'citations' },
    ])

    const messages = await contradictionsOf(spaceId, proposalId)
    expect(messages).toEqual([
      'staged claim "okf has_status final" collides with existing "draft" — approval disputes both',
    ])
  })

  it('proposal contradictions: the legacy array gets the refined set, not the coarse one', async () => {
    const spaceId = await seedSpace('legacy-space', { functional_predicates: ['has_status'] })
    await stageAndApprove(spaceId, 'legacy-base', [
      { subject: 'okf', predicate: 'has_status', object: 'draft', context: 'region:eu' },
    ])

    // Different context partition: 'draft in the EU' and 'final in the US' are
    // two facts, and approval leaves both verified.
    const partitioned = await stage(spaceId, 'legacy-us', [
      { subject: 'okf', predicate: 'has_status', object: 'final', context: 'region:us' },
    ])
    expect(await contradictionsOf(spaceId, partitioned)).toEqual([])

    // Same partition: a real collision, and it is still reported.
    const colliding = await stage(spaceId, 'legacy-eu', [
      { subject: 'okf', predicate: 'has_status', object: 'final', context: 'region:eu' },
    ])
    expect(await contradictionsOf(spaceId, colliding)).toEqual([
      'staged claim "okf has_status final" collides with existing "draft" — approval disputes both',
    ])
  })

  it('proposal contradictions: a space declaring no functional predicates gets none', async () => {
    // Empty by default, and deliberately so: `is`, `has_status` and `part_of`
    // are multi-valued until a space says otherwise.
    const spaceId = await seedSpace('undeclared-space', {})
    await stageAndApprove(spaceId, 'plain-base', [{ subject: 'okf', predicate: 'has_status', object: 'draft' }])
    const proposalId = await stage(spaceId, 'plain-change', [
      { subject: 'okf', predicate: 'has_status', object: 'final' },
    ])

    const report = await lintProposal(db, spaceId, proposalId)
    expect(report.findings.filter((finding) => finding.rule === 'contradictions')).toEqual([])
    // The rest of the proposal lint still ran — the space's silence about
    // predicates is not silence about uncited claims.
    expect(report.findings.map((finding) => finding.rule)).toContain('missing-citations')
  })

  // ------------------------------------------------------------------ space

  it('unsourced-concepts: reports the pages no archived source stands behind, and only those', async () => {
    const spaceId = await seedSpace('evidence-space', {})
    const { source } = await createSource(db, spaceId, {
      kind: 'markdown',
      raw: '# Archived',
      markdown: '# Archived',
      title: 'Archived',
    })
    const cite = [{ source_id: source.id, quote: 'Archived', locator: '' }]

    await stageAndApprove(
      spaceId,
      'sourced',
      [{ subject: 'sourced', predicate: 'is', object: 'quoted', citations: cite }],
      [source.id],
    )
    await stageAndApprove(spaceId, 'unquoted', [{ subject: 'unquoted', predicate: 'is', object: 'asserted' }])
    await stageAndApprove(spaceId, 'blank', [])
    await stageAndApprove(
      spaceId,
      'retired',
      [{ subject: 'retired', predicate: 'is', object: 'historical', citations: cite }],
      [source.id],
    )
    // A deprecated claim is still VISIBLE knowledge (CONTRACTS §9.3) and its
    // quote is still on the page, so the archive does stand behind 'retired'.
    // This is the case where a second hand-written count would drift from the
    // concept list's evidence summary.
    await db.update('wk_claims', { space_id: `eq.${spaceId}`, subject: 'eq.retired' }, { status: 'deprecated' })

    const findings = (await lintSpace(db, spaceId)).findings.filter((f) => f.rule === 'unsourced-concepts')
    expect(findings.map((finding) => finding.concept_slug)).toEqual(['blank', 'unquoted'])
    expect(findings.map((finding) => finding.severity)).toEqual(['warn', 'warn'])
    expect(findings.map((finding) => finding.message)).toEqual([
      'concept "blank" rests on no archived source: it makes no claims at all — ingest a source and let synthesis quote it',
      'concept "unquoted" rests on no archived source: 1 claim, none of them quoting one — ingest a source and let synthesis quote it',
    ])
    expect(findings.map((finding) => finding.details)).toEqual([{ claims: 0 }, { claims: 1 }])

    // The property that matters more than any single row: the rule and the
    // concept list are reading ONE aggregate. A page the index says draws on
    // an archived document, and a report that says nothing stands behind it,
    // is a pair a user cannot act on.
    const listed = (await listConcepts(db, spaceId, {})).items
    const reported = new Set(findings.map((finding) => finding.concept_slug))
    expect(listed.map((item) => item.slug)).toEqual(['blank', 'retired', 'sourced', 'unquoted'])
    for (const item of listed) expect(reported.has(item.slug)).toBe(item.evidence.sources === 0)
  })

  it('unsourced-concepts: overlaps empty-concepts on a claimless page, deliberately', async () => {
    // Both rules fire on 'blank' above. `counts` is a census of findings, not
    // of pages, and suppressing either would make a page's reported severity
    // depend on which rule reached it first.
    const spaceId = await seedSpace('overlap-space', {})
    await stageAndApprove(spaceId, 'stub', [])

    const byRule = new Map(
      (await lintSpace(db, spaceId)).findings
        .filter((finding) => finding.concept_slug === 'stub')
        .map((finding) => [finding.rule, finding.severity]),
    )
    expect(byRule.get('empty-concepts')).toBe('info')
    expect(byRule.get('unsourced-concepts')).toBe('warn')
  })
})
