// Lint rules against real Postgres, all of which are claims about what a
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
//   3. The `stub-concepts` rule — a readable page with no body, no visible
//      claim and no active relation in either direction. Three conditions and
//      two relation directions is exactly the shape a stubbed pool cannot
//      falsify: every case below turns on whether real SQL joined a real row.
//
//   4. The `scaffolded-claims` rule — a page marked as a reference target that
//      nevertheless holds visible claims. It is the inverse of the marker test
//      the three fault rules apply, over the same aggregate the concept list
//      renders, and both halves are things only a real database settles: which
//      rows a negated `NOT IN` over a coalesced marker actually selects, and
//      which claim statuses the shared lateral counts.
//
// RUN_INTEGRATION=1 gated.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { loadConfig, type Config } from '../../src/config.ts'
import { createPostgres, type Database, type Db } from '../../src/db/postgres.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { BUILT_IN_SCAFFOLDING_KINDS, listConcepts, type ScaffoldingOptions } from '../../src/domain/concepts.ts'
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

/**
 * Approve one page with explicit control over everything `stub-concepts`
 * looks at — body, claims, relations — plus the revision's agent_meta `kind`,
 * which is what marks a page as structural scaffolding.
 *
 * `markdown: ''` is written straight onto the revision afterwards because the
 * proposal schema forbids it (min(1)), and a zero-length body is precisely
 * what the pages that motivated this rule have: they were not proposed, a
 * bookkeeping pass created them so an imported edge had somewhere to land.
 */
async function approvePage(page: {
  spaceId: string
  slug: string
  markdown?: string
  claims?: Claim[]
  relations?: { to_slug: string; kind: 'related' }[]
  kind?: string
}) {
  const { proposal_id } = await createProposal(db, page.spaceId, {
    title: `Stage ${page.slug}`,
    input_hash: hex64(),
    agent_meta: page.kind ? { ...AGENT_META, kind: page.kind } : AGENT_META,
    concepts: [
      {
        slug: page.slug,
        title: page.slug,
        markdown: page.markdown === '' ? 'placeholder' : (page.markdown ?? `# ${page.slug}\n\nProse.`),
        claims: page.claims ?? [],
        relations: page.relations ?? [],
      },
    ],
  })
  await db.call('wk_apply_proposal', [proposal_id, 'lint-rules-test'])
  if (page.markdown === '') {
    await db.query(
      `UPDATE wk_concept_revisions r SET markdown = ''
         FROM wk_concepts c
        WHERE c.id = r.concept_id AND c.current_revision_id = r.id
          AND c.space_id = $1 AND c.slug = $2`,
      [page.spaceId, page.slug],
    )
  }
}

/**
 * WikiKit's own marker and nothing else — the case this file used to write as
 * an OMITTED argument. There is no omitted case any more (ScaffoldingOptions
 * requires the field), so the tests that mean "this installation declared
 * nothing" now say so, and say it with the exported constant rather than a
 * retyped literal: a second copy of the marker string in a test file is a
 * second place for it to drift away from the product's.
 */
const BUILT_IN_ONLY: ScaffoldingOptions = { scaffoldingKinds: BUILT_IN_SCAFFOLDING_KINDS }

// `options` is a PARAMETER and not a default inside this helper, for the reason
// the domain makes it one: a helper that answers for its callers is exactly the
// hole being closed, and half the tests below turn on which markers were in
// scope.
const slugsFor = async (spaceId: string, rule: string, options: ScaffoldingOptions): Promise<string[]> =>
  (await lintSpace(db, spaceId, options)).findings
    .filter((finding) => finding.rule === rule)
    .map((f) => f.concept_slug!)

/**
 * The scaffolding markers a build resolves to — read out of loadConfig()
 * rather than assumed, driving WIKIKIT_SCAFFOLDING_KINDS from here so a
 * developer's own .env can neither make the unconfigured case pass nor the
 * configured one.
 *
 * `declared` unset is the shipped build: the variable is deleted, which is
 * exactly what an operator who configured nothing has.
 *
 * process.env is snapshotted and restored around the call because loadConfig()
 * writes to it by design (it layers .env.defaults over anything still
 * undefined, and downstream libraries read the result), and this file shares
 * one process with twenty other integration tests that are entitled to the
 * environment they were started in.
 */
function shippedScaffoldingKinds(declared?: string): readonly string[] {
  const saved = { ...process.env }
  try {
    if (declared === undefined) delete process.env.WIKIKIT_SCAFFOLDING_KINDS
    else process.env.WIKIKIT_SCAFFOLDING_KINDS = declared
    return loadConfig().scaffoldingKinds
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  }
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

    const findings = (await lintSpace(db, spaceId, BUILT_IN_ONLY)).findings.filter(
      (f) => f.rule === 'unsourced-concepts',
    )
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
    const listed = (await listConcepts(db, spaceId, {}, BUILT_IN_ONLY)).items
    const reported = new Set(findings.map((finding) => finding.concept_slug))
    expect(listed.map((item) => item.slug)).toEqual(['blank', 'retired', 'sourced', 'unquoted'])
    for (const item of listed) {
      // Every page in this space is knowledge, so every row carries a
      // measurement — the two surfaces suppress the SAME pages, and a
      // reference target would be absent here and reported by neither.
      expect(item.evidence, item.slug).toBeDefined()
      expect(reported.has(item.slug)).toBe(item.evidence!.sources === 0)
    }
  })

  it('unsourced-concepts: overlaps empty-concepts on a claimless page, deliberately', async () => {
    // Both rules fire on 'blank' above. `counts` is a census of findings, not
    // of pages, and suppressing either would make a page's reported severity
    // depend on which rule reached it first.
    const spaceId = await seedSpace('overlap-space', {})
    await stageAndApprove(spaceId, 'stub', [])

    const byRule = new Map(
      (await lintSpace(db, spaceId, BUILT_IN_ONLY)).findings
        .filter((finding) => finding.concept_slug === 'stub')
        .map((finding) => [finding.rule, finding.severity]),
    )
    expect(byRule.get('empty-concepts')).toBe('info')
    expect(byRule.get('unsourced-concepts')).toBe('warn')
  })

  it('stub-concepts: reports pages empty in all three senses, and only those', async () => {
    const spaceId = await seedSpace('stub-space', {})

    // Each neighbour fails exactly ONE of the three conditions, so dropping
    // any one condition from the rule makes that neighbour a finding.
    await approvePage({ spaceId, slug: 'has-body' })
    await approvePage({
      spaceId,
      slug: 'has-claim',
      markdown: ' ',
      claims: [{ subject: 'has-claim', predicate: 'is', object: 'stated' }],
    })
    await approvePage({ spaceId, slug: 'inbound-only', markdown: ' ' })
    await approvePage({ spaceId, slug: 'pointer', relations: [{ to_slug: 'inbound-only', kind: 'related' }] })
    await approvePage({ spaceId, slug: 'anchor' })
    await approvePage({
      spaceId,
      slug: 'outbound-only',
      markdown: ' ',
      relations: [{ to_slug: 'anchor', kind: 'related' }],
    })

    // The two shapes an empty body comes in: whitespace somebody typed, and
    // the zero-length column a bookkeeping pass wrote.
    await approvePage({ spaceId, slug: 'whitespace-stub', markdown: '   \n\t ' })
    await approvePage({ spaceId, slug: 'zero-body', markdown: '' })

    const findings = (await lintSpace(db, spaceId, BUILT_IN_ONLY)).findings.filter((f) => f.rule === 'stub-concepts')
    expect(findings.map((finding) => finding.concept_slug)).toEqual(['whitespace-stub', 'zero-body'])
    expect(findings.map((finding) => finding.severity)).toEqual(['warn', 'warn'])
    expect(findings.map((finding) => finding.message)).toEqual([
      'concept "whitespace-stub" is an empty stub: no text, no claims, and nothing links to or from it — delete it, or give it content',
      'concept "zero-body" is an empty stub: no text, no claims, and nothing links to or from it — delete it, or give it content',
    ])
  })

  it('stub-concepts: one relation in EITHER direction is enough to spare a page', async () => {
    // Split out from the case above because a rule that checks only one
    // direction still passes a test that only points relations one way. Both
    // spared pages are otherwise identical to the reported one.
    const spaceId = await seedSpace('stub-direction-space', {})
    await approvePage({ spaceId, slug: 'hub' })
    await approvePage({
      spaceId,
      slug: 'points-at-hub',
      markdown: ' ',
      relations: [{ to_slug: 'hub', kind: 'related' }],
    })
    await approvePage({ spaceId, slug: 'pointed-at', markdown: ' ' })
    await approvePage({ spaceId, slug: 'referrer', relations: [{ to_slug: 'pointed-at', kind: 'related' }] })
    await approvePage({ spaceId, slug: 'untouched', markdown: ' ' })

    expect(await slugsFor(spaceId, 'stub-concepts', BUILT_IN_ONLY)).toEqual(['untouched'])
  })

  it('stub-concepts: reports a scaffolding-marked page that orphan-concepts still skips', async () => {
    // The regression this rule exists for. A structural-reference page whose
    // imported relations have since gone away is, to a reader, a title with
    // nothing behind it — and before this rule the whole linter was silent
    // about it while the concept index showed it with zero of everything.
    const spaceId = await seedSpace('scaffolding-space', {})
    await approvePage({ spaceId, slug: 'left-behind', markdown: '', kind: 'structural-reference' })

    const { findings } = await lintSpace(db, spaceId, BUILT_IN_ONLY)
    const byRule = (rule: string) => findings.filter((f) => f.rule === rule).map((f) => f.concept_slug)
    expect(byRule('stub-concepts')).toEqual(['left-behind'])
    // Suppressing furniture from the rules that describe a FAULT stays
    // correct — the point was never that those rules were wrong, only that
    // nothing covered the page at all.
    expect(byRule('orphan-concepts')).toEqual([])
    expect(byRule('unsourced-concepts')).toEqual([])
    expect(byRule('empty-concepts')).toEqual([])
  })

  it('a CONFIGURED scaffolding kind is a reference target; an unknown one is an ordinary page', async () => {
    // The marker set is no longer a hardcoded pair in the domain: WikiKit owns
    // 'structural-reference' and the installation declares the rest
    // (WIKIKIT_SCAFFOLDING_KINDS → config.scaffoldingKinds → these options).
    // What has to hold is that the DECLARATION is what does the work — both
    // surfaces treat a declared kind exactly as they treat the built-in one,
    // and treat an undeclared kind as knowledge, because a marker that worked
    // without being declared would mean the product still knows one
    // deployment's private history.
    const spaceId = await seedSpace('configured-scaffolding-space', {})
    const configured = { scaffoldingKinds: ['structural-reference', 'acme-relation-import'] }

    await approvePage({ spaceId, slug: 'acme-target', kind: 'acme-relation-import' })
    await approvePage({ spaceId, slug: 'built-in-target', kind: 'structural-reference' })
    await approvePage({ spaceId, slug: 'unknown-kind', kind: 'some-other-pipeline' })
    await approvePage({ spaceId, slug: 'plain' })

    // The index declines to MEASURE a reference target — absent, never zero.
    const listed = new Map((await listConcepts(db, spaceId, {}, configured)).items.map((i) => [i.slug, i.evidence]))
    expect(listed.get('acme-target')).toBeUndefined()
    expect(listed.get('built-in-target')).toBeUndefined()
    // Both of these hold no knowledge either, and both are measured and say so
    // with three honest zeros: the difference is not what the page contains, it
    // is whether the installation declared it as structure.
    expect(listed.get('unknown-kind')).toEqual({ claims: 0, uncited_claims: 0, sources: 0 })
    expect(listed.get('plain')).toEqual({ claims: 0, uncited_claims: 0, sources: 0 })

    // The linter suppresses FAULT reports about the same two pages and only
    // those. Asserted per rule rather than as a total, because a rule that
    // stopped consulting the marker set would still leave the count plausible.
    const { findings } = await lintSpace(db, spaceId, configured)
    for (const rule of ['orphan-concepts', 'unsourced-concepts', 'empty-concepts']) {
      expect(
        findings.filter((f) => f.rule === rule).map((f) => f.concept_slug),
        rule,
      ).toEqual(['plain', 'unknown-kind'])
    }

    // And the control: with NO configuration in scope the declared marker means
    // nothing, so the same page is measured and reported like any other. This
    // is the assertion that fails if a future edit makes an arbitrary kind
    // count as scaffolding on its own.
    const unconfigured = new Map(
      (await listConcepts(db, spaceId, {}, BUILT_IN_ONLY)).items.map((i) => [i.slug, i.evidence]),
    )
    expect(unconfigured.get('acme-target')).toEqual({ claims: 0, uncited_claims: 0, sources: 0 })
    expect(unconfigured.get('built-in-target')).toBeUndefined()
    expect(
      (await lintSpace(db, spaceId, BUILT_IN_ONLY)).findings
        .filter((f) => f.rule === 'orphan-concepts')
        .map((f) => f.concept_slug),
    ).toEqual(['acme-target', 'plain', 'unknown-kind'])
  })

  it('the SHIPPED BUILD honours its own marker alone, and a declared one alongside it', async () => {
    // WHAT THIS TEST USED TO ASSERT, AND WHY IT NO LONGER CAN.
    //
    // Until this release it asserted the opposite of its first half: that a
    // build with NOTHING configured still treated one deployment's historical
    // import marker as a reference target. That default was real and it was
    // right. 0.29.0 moved the marker set from a frozen pair in the domain into
    // configuration, and an operator upgrading a running deployment sets
    // nothing — so 49 pages across 5 wikis, whose evidence reads as ABSENT
    // because the marker is recognised, would have come back as `{claims: 0,
    // uncited_claims: 0, sources: 0}` on upgrade: "this page rests on
    // nothing", printed about pages that hold nothing by design. Carrying the
    // marker as a shipped default was the only thing standing between the
    // upgrade and that regression, and this test was the only thing standing
    // between a refactor and the default.
    //
    // That installation now declares the marker itself — its running instance
    // reports it with origin 'configured', not 'fallback' — so the default
    // protects nobody, and it was the last place the product named a
    // particular deployment. The old assertion is now FALSE BY DESIGN, and the
    // literal it carried (the one value this repository deliberately wrote
    // down twice, because a guarantee about a VALUE cannot be made by a test
    // about shape) is deleted with it.
    //
    // What replaces it is the invariant that holds from here, and it is the
    // one a future reader should defend: with nothing configured the built-in
    // marker is the WHOLE set — no deployment's history rides along — and a
    // declared marker is honoured beside it rather than instead of it. Read
    // through loadConfig() rather than from an import, because the thing under
    // test is not the constant, it is the boot path a deployment takes.
    const shipped = { scaffoldingKinds: shippedScaffoldingKinds() }
    expect(shipped.scaffoldingKinds, 'a shipped build carries WikiKit’s own marker and nothing else').toEqual([
      'structural-reference',
    ])

    const spaceId = await seedSpace('shipped-default-scaffolding-space', {})
    await approvePage({ spaceId, slug: 'built-in-target', kind: 'structural-reference' })
    await approvePage({ spaceId, slug: 'declared-target', kind: 'acme-relation-import' })
    await approvePage({ spaceId, slug: 'plain' })

    // Nothing configured: the index declines to measure WikiKit's own marker —
    // absent, never zero — and measures everything else, including the marker
    // this installation has not declared. A passing assertion therefore cannot
    // be the whole column having gone silent.
    const shippedListed = new Map((await listConcepts(db, spaceId, {}, shipped)).items.map((i) => [i.slug, i.evidence]))
    expect(shippedListed.get('built-in-target')).toBeUndefined()
    expect(shippedListed.get('declared-target')).toEqual({ claims: 0, uncited_claims: 0, sources: 0 })
    expect(shippedListed.get('plain')).toEqual({ claims: 0, uncited_claims: 0, sources: 0 })

    // And the linter agrees, per rule rather than as a total: a rule that
    // stopped consulting the marker set would still leave a count plausible.
    // This is the breaking change stated as an assertion — an installation
    // that used to get this treatment for free now gets fault findings until
    // it declares its marker.
    const shippedReport = await lintSpace(db, spaceId, shipped)
    for (const rule of ['orphan-concepts', 'unsourced-concepts', 'empty-concepts']) {
      expect(
        shippedReport.findings.filter((f) => f.rule === rule).map((f) => f.concept_slug),
        rule,
      ).toEqual(['declared-target', 'plain'])
    }

    // Declare it, and the same rows change treatment — the repair for the
    // breaking change above, exercised rather than described. The built-in
    // marker survives the declaration, which is the property that keeps
    // 'structural-reference' non-configurable.
    const declared = { scaffoldingKinds: shippedScaffoldingKinds('acme-relation-import') }
    expect(declared.scaffoldingKinds).toEqual(['structural-reference', 'acme-relation-import'])

    const declaredListed = new Map(
      (await listConcepts(db, spaceId, {}, declared)).items.map((i) => [i.slug, i.evidence]),
    )
    expect(declaredListed.get('built-in-target')).toBeUndefined()
    expect(declaredListed.get('declared-target')).toBeUndefined()
    expect(declaredListed.get('plain')).toEqual({ claims: 0, uncited_claims: 0, sources: 0 })

    const declaredReport = await lintSpace(db, spaceId, declared)
    for (const rule of ['orphan-concepts', 'unsourced-concepts', 'empty-concepts']) {
      expect(
        declaredReport.findings.filter((f) => f.rule === rule).map((f) => f.concept_slug),
        rule,
      ).toEqual(['plain'])
    }
  })

  // ------------------------------------------------- scaffolded-claims
  //
  // The marker decides whether a page is a reference target and the counts do
  // not, deliberately — so the one page the whole marker machinery goes quiet
  // about is the one where the two disagree. These are the tests that say it
  // out loud.

  it('scaffolded-claims: reports a marked page holding visible claims, built-in marker included', async () => {
    const spaceId = await seedSpace('scaffolded-claims-space', {})
    const configured = { scaffoldingKinds: ['structural-reference', 'acme-relation-import'] }

    // Reported: both markers, both counts. The built-in one is NOT exempt —
    // a claim on a page WikiKit itself created as structure means the
    // product's own statement about that row has stopped being true, which is
    // the more alarming of the two cases and not the excusable one.
    await approvePage({
      spaceId,
      slug: 'import-target-with-claims',
      kind: 'acme-relation-import',
      claims: [
        { subject: 'okf', predicate: 'is', object: 'archived' },
        { subject: 'okf', predicate: 'mentions', object: 'citations' },
      ],
    })
    await approvePage({
      spaceId,
      slug: 'built-in-target-with-claims',
      kind: 'structural-reference',
      claims: [{ subject: 'okf', predicate: 'has_status', object: 'draft' }],
    })
    // Not reported: the ordinary, correct reference target — marked and
    // claimless, which is what a reference target is supposed to look like.
    await approvePage({ spaceId, slug: 'import-target-empty', kind: 'acme-relation-import' })
    await approvePage({ spaceId, slug: 'built-in-target-empty', kind: 'structural-reference' })
    // Not reported: claims on a page nobody marked. Claims are not the fault
    // here, the contradiction is.
    await approvePage({
      spaceId,
      slug: 'plain-with-claims',
      claims: [{ subject: 'okf', predicate: 'is', object: 'knowledge' }],
    })

    const findings = (await lintSpace(db, spaceId, configured)).findings.filter((f) => f.rule === 'scaffolded-claims')
    expect(findings.map((f) => f.concept_slug)).toEqual(['built-in-target-with-claims', 'import-target-with-claims'])
    expect(findings.map((f) => f.severity)).toEqual(['warn', 'warn'])
    expect(findings.map((f) => f.message)).toEqual([
      'concept "built-in-target-with-claims" is marked as a reference target but holds 1 visible claim: either the marker is wrong for this page, or those claims belong on the page it points at — until one of the two is fixed its evidence is withheld from the index',
      'concept "import-target-with-claims" is marked as a reference target but holds 2 visible claims: either the marker is wrong for this page, or those claims belong on the page it points at — until one of the two is fixed its evidence is withheld from the index',
    ])
    expect(findings.map((f) => f.details)).toEqual([{ claims: 1 }, { claims: 2 }])
    // The marker literal is never in the finding: lint is served to agents
    // through wikikit_lint, and a string that makes a page exempt from the
    // evidence measurement and from three fault rules is not handed to them.
    for (const finding of findings) {
      expect(JSON.stringify(finding)).not.toContain('acme-relation-import')
      expect(JSON.stringify(finding)).not.toContain('structural-reference')
    }

    // The reason the finding has to exist at all: the index is silent about
    // exactly these two pages while their claims are real and readable, so
    // nothing but this rule reports that a measurement was withheld.
    const listed = new Map((await listConcepts(db, spaceId, {}, configured)).items.map((i) => [i.slug, i.evidence]))
    expect(listed.get('import-target-with-claims')).toBeUndefined()
    expect(listed.get('built-in-target-with-claims')).toBeUndefined()
    expect(listed.get('plain-with-claims')).toEqual({ claims: 1, uncited_claims: 1, sources: 0 })

    // And the threading control, as everywhere else in this file: with NO
    // configuration in scope the operator's marker means nothing, so that page
    // is an ordinary one — measured, and not a contradiction. WikiKit's own
    // marker still is one, because it is never configurable away.
    const unconfigured = (await lintSpace(db, spaceId, BUILT_IN_ONLY)).findings
      .filter((f) => f.rule === 'scaffolded-claims')
      .map((f) => f.concept_slug)
    expect(unconfigured).toEqual(['built-in-target-with-claims'])
  })

  it('scaffolded-claims: staged claims are not claims — only what a reader can see trips it', async () => {
    // The rule counts through the same aggregate the concept list renders, so
    // it inherits the visible-status set rather than restating it. A pending
    // proposal is not knowledge and withholds nothing from anybody: the page
    // is still a correct, claimless reference target until somebody approves.
    const spaceId = await seedSpace('scaffolded-claims-staging-space', {})
    await approvePage({ spaceId, slug: 'target', kind: 'structural-reference' })

    const { proposal_id } = await createProposal(db, spaceId, {
      title: 'Stage claims onto the target',
      input_hash: hex64(),
      // The SAME kind: approving this must leave the page marked, or the test
      // would be measuring a page that stopped being a reference target.
      agent_meta: { ...AGENT_META, kind: 'structural-reference' },
      concepts: [
        {
          slug: 'target',
          title: 'target',
          markdown: '# target\n\nProse.',
          claims: [{ subject: 'okf', predicate: 'is', object: 'staged' }],
        },
      ],
    })
    expect(await slugsFor(spaceId, 'scaffolded-claims', BUILT_IN_ONLY)).toEqual([])

    // Approval makes the identical claim visible, and now the page's evidence
    // is being withheld — same row, same claim, different answer.
    await db.call('wk_apply_proposal', [proposal_id, 'lint-rules-test'])
    expect(await slugsFor(spaceId, 'scaffolded-claims', BUILT_IN_ONLY)).toEqual(['target'])
  })

  it('scaffolded-claims: warn in the counts census, beside the per-claim error the marker never suppressed', async () => {
    // One marked page with one uncited claim is exactly two findings: this
    // rule's warn about the contradiction, and missing-citations' error about
    // the claim itself — which is per-CLAIM and marker-blind, and always was.
    // The three page-level fault rules stay silent, as they should: the page
    // is not orphaned, unsourced or empty in any sense they describe.
    const spaceId = await seedSpace('scaffolded-claims-census-space', {})
    await approvePage({
      spaceId,
      slug: 'target',
      kind: 'structural-reference',
      claims: [{ subject: 'okf', predicate: 'is', object: 'asserted' }],
    })

    const report = await lintSpace(db, spaceId, BUILT_IN_ONLY)
    const byRule = new Map(report.findings.map((f) => [f.rule, f.severity]))
    expect(byRule.get('scaffolded-claims')).toBe('warn')
    expect(byRule.get('missing-citations')).toBe('error')
    for (const rule of ['orphan-concepts', 'unsourced-concepts', 'empty-concepts', 'stub-concepts']) {
      expect(byRule.has(rule as never), rule).toBe(false)
    }
    expect(report.counts).toEqual({ error: 1, warn: 1, info: 0 })
  })

  it('stub-concepts: warn in the counts census, overlapping empty-concepts on purpose', async () => {
    // A non-scaffolding stub is legitimately three findings and one info line:
    // unreachable, unsourced, blank, claimless. `counts` is a census of what
    // the linter found, never a headcount of pages, so none of them is
    // suppressed in favour of another.
    const spaceId = await seedSpace('stub-census-space', {})
    await approvePage({ spaceId, slug: 'blank', markdown: '' })

    const report = await lintSpace(db, spaceId, BUILT_IN_ONLY)
    const byRule = new Map(
      report.findings.filter((finding) => finding.concept_slug === 'blank').map((f) => [f.rule, f.severity]),
    )
    expect(byRule.get('stub-concepts')).toBe('warn')
    expect(byRule.get('orphan-concepts')).toBe('warn')
    expect(byRule.get('unsourced-concepts')).toBe('warn')
    expect(byRule.get('empty-concepts')).toBe('info')
    expect(report.counts).toEqual({ error: 0, warn: 3, info: 1 })
  })
})
