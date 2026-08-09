// Knowledge-base hygiene checks (plan §5, CONTRACTS §4) — LLM-free, pure SQL,
// CI-consumable via GET /v1/spaces/{space}/lint.
//
// The severity mapping is FIXED by contract (do not tune it per space):
//   error: contradictions, missing-citations, broken-relations
//   warn:  stale-claims, orphan-concepts, unsourced-concepts, stub-concepts,
//          scaffolded-claims
//   info:  empty-concepts, unreviewed-proposals, dangling-sources
//
// Every rule is one space-scoped query over the READER-VISIBLE state (current
// revisions, verified/disputed/deprecated claims, active relations) — lint
// judges the knowledge base users actually see, never the staging area. The
// one deliberate exception is unreviewed-proposals, whose whole point is to
// surface the staging backlog.
import type { Db } from '../db/postgres.ts'
import { getFunctionalPredicates, VISIBLE_CLAIM_STATUSES } from './claims.ts'
import { EVIDENCE_LATERAL, notScaffolding, type ScaffoldingOptions } from './concepts.ts'

// notScaffolding (and the marker set behind it) is defined beside
// EVIDENCE_LATERAL in concepts.ts, and its full reasoning is there: it now
// serves two callers with two different purposes, the linter suppressing fault
// reports about those pages and the concept index declining to measure them,
// both resting on the one fact that such rows are furniture rather than
// knowledge. It moved rather than being duplicated for the same reason the
// aggregate is shared — this file cannot own a definition the read model also
// needs without concepts.ts importing back from the linter.
//
// It takes the installation's markers as an argument because only part of that
// set is WikiKit's own (concepts.ts explains which part and why), so the rules
// below thread `options.scaffoldingKinds` down from lintSpace rather than
// closing over a module constant.
//
// What holds HERE: every page-level rule that reports a FAULT excludes them —
// orphan-concepts, unsourced-concepts, empty-concepts — because a rule that
// reports a scaffolding page is reporting the linter's own furniture, and once
// a report is mostly furniture nobody reads the rest of it. `stub-concepts` is
// the one rule below that does NOT consult the list, and that is the point of
// it: it reports a page that is blank in every sense at once, which is what a
// structural target has BECOME once nothing points through it any more. Its
// reasoning is at the rule; what matters here is that a new page-level rule
// reaching for notScaffolding is making a claim about faults, not inheriting a
// default.
//
// And one rule now REQUIRES the marker instead of excluding it:
// `scaffolded-claims` reports the page that carries a marker AND holds visible
// claims. That is not a third policy, it is the same one read the other way —
// the marker says this row is furniture, the claims say it is knowledge, and
// exactly one of those can be true. The three rules above are silent about such
// a page by design and the read model withholds its measurement, so without
// this rule the contradiction is the one state in the file that nothing at all
// reports. Its full argument is at the rule.

export type LintRule =
  | 'contradictions'
  | 'missing-citations'
  | 'broken-relations'
  | 'stale-claims'
  | 'orphan-concepts'
  | 'unsourced-concepts'
  | 'stub-concepts'
  | 'scaffolded-claims'
  | 'empty-concepts'
  | 'unreviewed-proposals'
  | 'dangling-sources'
  | 'tombstoned-sources'
  | 'broken-cross-space-links'

export type LintSeverity = 'error' | 'warn' | 'info'

export interface LintFinding {
  rule: LintRule
  severity: LintSeverity
  message: string
  concept_slug?: string
  claim_id?: string
  details?: Record<string, unknown>
}

export interface LintReport {
  findings: LintFinding[]
  counts: { error: number; warn: number; info: number }
}

/** The contract's fixed rule → severity table, exported for the drift tests. */
export const LINT_SEVERITY: Record<LintRule, LintSeverity> = {
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
}

// One finding per contradictory frame (not per claim): the reviewer resolves
// the FRAME (deprecate one side), so that is the unit of work. Grouped over
// VISIBLE claims (verified + disputed) with more than one distinct object —
// not just status='disputed' — because an exact-frame contradiction can hold
// both sides 'verified' (e.g. two colliding claims approved inside ONE
// proposal, which the apply-time dispute flip's cross-proposal join skips);
// lint must see the contradiction regardless of how it was persisted.
async function contradictions(db: Db, spaceId: string): Promise<LintFinding[]> {
  const functionalPredicates = await getFunctionalPredicates(db, spaceId)
  if (!functionalPredicates.length) return []
  // Pairwise self-join (0021): a contradiction needs the same frame AND the
  // same context partition AND overlapping validity AND differing NORMALIZED
  // objects — a GROUP BY over distinct objects cannot express the interval
  // condition. Pairs are folded into one finding per frame+context in TS.
  const { rows } = await db.query<{
    subject: string
    predicate: string
    context: string
    a_id: string
    b_id: string
    a_object: string
    b_object: string
    a_slug: string
    b_slug: string
  }>(
    `SELECT a.subject, a.predicate, coalesce(a.context, '') AS context,
            a.id AS a_id, b.id AS b_id, a.object AS a_object, b.object AS b_object,
            ca.slug AS a_slug, cb.slug AS b_slug
       FROM wk_claims a
       JOIN wk_claims b
         ON b.space_id = a.space_id
        AND b.subject = a.subject
        AND b.predicate = a.predicate
        AND coalesce(b.context, '') = coalesce(a.context, '')
        AND a.id < b.id
        AND coalesce(a.object_normalized, a.object) <> coalesce(b.object_normalized, b.object)
        AND coalesce(a.valid_from, '-infinity'::timestamptz) < coalesce(b.valid_until, 'infinity'::timestamptz)
        AND coalesce(b.valid_from, '-infinity'::timestamptz) < coalesce(a.valid_until, 'infinity'::timestamptz)
       JOIN wk_concepts ca ON ca.id = a.concept_id
       JOIN wk_concepts cb ON cb.id = b.concept_id
      WHERE a.space_id = $1
        AND a.predicate = ANY($2::text[])
        AND a.status IN ('verified', 'disputed')
        AND b.status IN ('verified', 'disputed')
      ORDER BY a.subject, a.predicate`,
    [spaceId, functionalPredicates],
  )
  // One finding per contradictory frame(+context) — the reviewer resolves the
  // FRAME (deprecate one side), so that is the unit of work.
  const byFrame = new Map<
    string,
    {
      subject: string
      predicate: string
      context: string
      objects: Set<string>
      claimIds: Set<string>
      slugs: Set<string>
    }
  >()
  for (const row of rows) {
    const key = `${row.subject}\u0000${row.predicate}\u0000${row.context}`
    const entry =
      byFrame.get(key) ??
      ({
        subject: row.subject,
        predicate: row.predicate,
        context: row.context,
        objects: new Set<string>(),
        claimIds: new Set<string>(),
        slugs: new Set<string>(),
      } as const)
    entry.objects.add(row.a_object)
    entry.objects.add(row.b_object)
    entry.claimIds.add(row.a_id)
    entry.claimIds.add(row.b_id)
    entry.slugs.add(row.a_slug)
    entry.slugs.add(row.b_slug)
    byFrame.set(key, entry)
  }
  return [...byFrame.values()].map((frame) => ({
    rule: 'contradictions' as const,
    severity: LINT_SEVERITY.contradictions,
    message: `contradictory frame "${frame.subject} ${frame.predicate}"${frame.context ? ` [${frame.context}]` : ''}: ${[...frame.objects].join(' vs ')}`,
    concept_slug: [...frame.slugs][0],
    details: {
      subject: frame.subject,
      predicate: frame.predicate,
      ...(frame.context ? { context: frame.context } : {}),
      objects: [...frame.objects],
      claim_ids: [...frame.claimIds],
      concepts: [...frame.slugs],
    },
  }))
}

// A visible claim without a citation is an unverifiable assertion — the exact
// thing WikiKit exists to prevent. Deprecated claims are exempt: they are
// already retired.
async function missingCitations(db: Db, spaceId: string): Promise<LintFinding[]> {
  const { rows } = await db.query<{ id: string; subject: string; predicate: string; object: string; slug: string }>(
    `SELECT cl.id, cl.subject, cl.predicate, cl.object, c.slug
       FROM wk_claims cl
       JOIN wk_concepts c ON c.id = cl.concept_id
      WHERE cl.space_id = $1
        AND cl.status IN ('verified', 'disputed')
        AND NOT EXISTS (SELECT 1 FROM wk_citations ci WHERE ci.claim_id = cl.id)
      ORDER BY c.slug, cl.created_at`,
    [spaceId],
  )
  return rows.map((row) => ({
    rule: 'missing-citations' as const,
    severity: LINT_SEVERITY['missing-citations'],
    message: `claim "${row.subject} ${row.predicate} ${row.object}" has no citation`,
    concept_slug: row.slug,
    claim_id: row.id,
  }))
}

// An active relation pointing at a concept without a current revision is a
// link into the void: readers can follow it and 404.
async function brokenRelations(db: Db, spaceId: string): Promise<LintFinding[]> {
  const { rows } = await db.query<{
    id: string
    from_slug: string
    to_slug: string
    kind: string
    broken_side: string
  }>(
    `SELECT rel.id, f.slug AS from_slug, t.slug AS to_slug, rel.kind,
            CASE WHEN f.current_revision_id IS NULL THEN f.slug ELSE t.slug END AS broken_side
       FROM wk_relations rel
       JOIN wk_concepts f ON f.id = rel.from_concept_id
       JOIN wk_concepts t ON t.id = rel.to_concept_id
      WHERE rel.space_id = $1
        AND rel.status = 'active'
        AND (f.current_revision_id IS NULL OR t.current_revision_id IS NULL)
      ORDER BY f.slug, t.slug`,
    [spaceId],
  )
  return rows.map((row) => ({
    rule: 'broken-relations' as const,
    severity: LINT_SEVERITY['broken-relations'],
    message: `relation ${row.from_slug} ${row.kind} ${row.to_slug} points at unreadable concept "${row.broken_side}"`,
    concept_slug: row.from_slug,
    details: { relation_id: row.id, kind: row.kind, to_slug: row.to_slug, broken: row.broken_side },
  }))
}

// valid_until in the past but still verified/disputed: the claim asserts
// something about a window that has closed and needs re-verification or
// deprecation.
async function staleClaims(db: Db, spaceId: string): Promise<LintFinding[]> {
  const { rows } = await db.query<{
    id: string
    subject: string
    predicate: string
    object: string
    valid_until: Date | string
    slug: string
  }>(
    `SELECT cl.id, cl.subject, cl.predicate, cl.object, cl.valid_until, c.slug
       FROM wk_claims cl
       JOIN wk_concepts c ON c.id = cl.concept_id
      WHERE cl.space_id = $1
        AND cl.status IN ('verified', 'disputed')
        AND cl.valid_until IS NOT NULL
        AND cl.valid_until < now()
      ORDER BY cl.valid_until ASC`,
    [spaceId],
  )
  return rows.map((row) => ({
    rule: 'stale-claims' as const,
    severity: LINT_SEVERITY['stale-claims'],
    message: `claim "${row.subject} ${row.predicate} ${row.object}" expired ${
      row.valid_until instanceof Date ? row.valid_until.toISOString() : String(row.valid_until)
    }`,
    concept_slug: row.slug,
    claim_id: row.id,
  }))
}

// A readable concept no active relation touches (either direction) is
// unreachable by graph navigation — usually a missed relation, occasionally a
// genuinely standalone page (hence warn, not error).
async function orphanConcepts(db: Db, spaceId: string, kinds: readonly string[] | undefined): Promise<LintFinding[]> {
  const { rows } = await db.query<{ slug: string }>(
    `SELECT c.slug
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1
        AND c.current_revision_id IS NOT NULL
        AND ${notScaffolding(kinds)}
        AND NOT EXISTS (
          SELECT 1 FROM wk_relations rel
           WHERE rel.status = 'active'
             AND (rel.from_concept_id = c.id OR rel.to_concept_id = c.id)
        )
      ORDER BY c.slug`,
    [spaceId],
  )
  return rows.map((row) => ({
    rule: 'orphan-concepts' as const,
    severity: LINT_SEVERITY['orphan-concepts'],
    message: `concept "${row.slug}" has no relations to or from any other concept`,
    concept_slug: row.slug,
  }))
}

// A readable page that no archived source stands behind: across ALL of its
// visible claims there is not one citation, so `sources` is zero.
//
// WHY the rule exists when three others already touch this ground. WikiKit's
// premise is that a claim quotes a document somebody archived; the evidence
// summary on the concept list (0.25.0) was the first surface to count that per
// page, and the first thing it showed on a real installation was that roughly a
// third of published pages carry no claims at all. The linter had
// `orphan-concepts` for a page nothing LINKS TO and nothing for a page nothing
// BACKS. `missing-citations` is per-CLAIM and says nothing about a page that
// makes none; `empty-concepts` is per-page but asks whether the page states
// anything checkable, not whether anything archived is behind it. Neither
// answers "which pages here are somebody's memory".
//
// WHY warn, and not either neighbour:
//   * NOT error. A page written by hand is a legitimate thing to have in a
//     wiki — a stub, a hub page, an index somebody typed — and the three error
//     rules all describe states that are simply wrong (a claim nobody can
//     check, a link into the void, a frame asserting two things). A rule that
//     shouts at a legitimate state is a rule an operator turns off, and a
//     turned-off rule catches nothing. It would also break CI for every
//     installation on upgrade, which is not a thing a lint rule may decide on
//     an operator's behalf.
//   * NOT info. info is where "noticed, nothing expected of you" lives —
//     dangling sources, a pending proposal. This one names an action and the
//     action is the product's whole loop: ingest a source and let synthesis
//     quote it. At a third of published pages an info line would also be
//     invisible under the info rules that already run per source and per
//     proposal.
// So: warn — somebody should look, nothing is broken.
//
// The overlap with `empty-concepts` (a claimless page is BOTH) is deliberate,
// not an oversight: the info line records a stub, this warn line records that
// nothing archived stands behind it and says what would fix it. Rejected:
// suppressing one when the other fires, which would make a page's reported
// severity depend on which rule reached it first and would hide the actionable
// line behind the passive one. `counts` is a census of what the linter found,
// never a checklist of distinct pages.
//
// The count itself is EVIDENCE_LATERAL from concepts.ts — the same aggregate
// the concept list renders. A second hand-written copy could drift over the
// visible statuses or a forgotten DISTINCT and then tell an operator that a
// page the index shows with `sources: 1` rests on nothing.
async function unsourcedConcepts(
  db: Db,
  spaceId: string,
  kinds: readonly string[] | undefined,
): Promise<LintFinding[]> {
  const { rows } = await db.query<{ slug: string; claims: number; sources: number }>(
    `WITH page AS (
       SELECT c.id, c.slug
         FROM wk_concepts c
         JOIN wk_concept_revisions r ON r.id = c.current_revision_id
        WHERE c.space_id = $1
          AND ${notScaffolding(kinds)}
     )
     SELECT p.slug, ev.claims, ev.sources
       FROM page p
       CROSS JOIN LATERAL (${EVIDENCE_LATERAL}) ev
      WHERE ev.sources = 0
      ORDER BY p.slug`,
    [spaceId],
  )
  return rows.map((row) => ({
    rule: 'unsourced-concepts' as const,
    severity: LINT_SEVERITY['unsourced-concepts'],
    // The two shapes read differently to whoever has to act: a page with no
    // claims needs a source before it can have any, a page whose claims all
    // lack a quote has statements nobody archived evidence for. Same fix,
    // different amount of prose already at risk — so the count is in the line.
    message:
      row.claims === 0
        ? `concept "${row.slug}" rests on no archived source: it makes no claims at all — ingest a source and let synthesis quote it`
        : `concept "${row.slug}" rests on no archived source: ${row.claims} claim${
            row.claims === 1 ? '' : 's'
          }, none of them quoting one — ingest a source and let synthesis quote it`,
    concept_slug: row.slug,
    // `uncited_claims` is deliberately not carried: when `sources` is zero it
    // equals `claims` by construction, so it would be a second name for a
    // number already here.
    details: { claims: row.claims },
  }))
}

// A readable page that is empty in EVERY sense at once: its current revision
// has no body, it states no visible claim, and no active relation touches it in
// either direction. A reader can open it and there is nothing there.
//
// WHY the rule exists. The concept list's evidence summary counts claims and
// sources over every page; `unsourced-concepts` reports the pages with zero
// sources but skips the scaffolding markers, and on a real installation that
// gap was large enough to break the linter's promise: a space whose index
// showed two dozen pages with `sources: 0` produced not one finding, so the
// operator who opened the report to find out what to do about them was told
// nothing was wrong. The pages behind that silence are not the linter's own
// furniture — they have titles, they are in the index, a reader can open them —
// they are simply blank. Something has to say so.
//
// WHY this rule does NOT look at the scaffolding markers, in either direction.
// Not as an exclusion, because excluding them is the defect this rule exists
// to fix. But equally not as a REQUIREMENT: keying off the marker would make
// the rule a report about one deployment's private migration tag rather than
// about the knowledge base, and it would find nothing at all on an installation
// that never ran that import — while the same blank pages arise wherever a
// relation target is created and then the relation goes away. Every condition below is
// observable in what the page IS, never in how it came to exist, so the rule
// means the same thing on every installation. Suppressing furniture from
// `orphan-concepts` and friends stays correct: those rules describe a fault
// (unreachable, unsourced) that a structural target is not guilty of. This one
// describes a page that is blank, which is exactly what such a target has
// become once nothing points through it any more.
//
// WHY warn, in the same three-way as `unsourced-concepts`:
//   * NOT error. The error rules describe states that are simply wrong — a
//     claim nobody can check, a link into the void, a frame asserting two
//     things. An empty page is a legitimate thing to have transiently: someone
//     creates the page, then writes it. Failing CI on the gap between those two
//     moments would train operators to turn the rule off.
//   * NOT info. info is "noticed, nothing expected of you" — a dangling source,
//     a pending proposal. This finding names an action and there are only two
//     of them, both cheap: delete the page, or put something on it.
// So: warn — somebody should look, nothing is broken.
//
// The overlap with `empty-concepts` is intended, on exactly the argument the
// 0.26.0 CHANGELOG makes for `empty-concepts` vs `unsourced-concepts`: a
// non-scaffolding stub is BOTH claimless (info: this page states nothing
// checkable) and blank (warn: this page is nothing at all, here is what to do),
// and those are two different sentences to two different readers. `counts` is a
// census of findings, never a headcount of pages, so neither line is
// suppressed — suppression would make a page's reported severity depend on
// which rule reached it first and would hide the actionable line behind the
// passive one. (Today `empty-concepts` skips scaffolding, so on the pages that
// motivated this rule it does not fire at all.)
async function stubConcepts(db: Db, spaceId: string): Promise<LintFinding[]> {
  const { rows } = await db.query<{ slug: string }>(
    `SELECT c.slug
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1
        -- Whitespace CLASS, not btrim(): the one-argument btrim strips spaces
        -- and nothing else, so a body of a single newline would read as text.
        AND r.markdown ~ '^[[:space:]]*$'
        AND NOT EXISTS (
          SELECT 1 FROM wk_claims cl
           WHERE cl.concept_id = c.id
             AND cl.status IN (${VISIBLE_CLAIM_STATUSES.map((status) => `'${status}'`).join(', ')})
        )
        AND NOT EXISTS (
          SELECT 1 FROM wk_relations rel
           WHERE rel.status = 'active'
             AND (rel.from_concept_id = c.id OR rel.to_concept_id = c.id)
        )
      ORDER BY c.slug`,
    [spaceId],
  )
  return rows.map((row) => ({
    rule: 'stub-concepts' as const,
    severity: LINT_SEVERITY['stub-concepts'],
    // Deliberately NOT "ingest a source": that is the fix for a page that says
    // things nothing archived backs, and this page says nothing. Advising an
    // ingest here would send an operator to synthesize prose about a title
    // somebody left behind.
    message: `concept "${row.slug}" is an empty stub: no text, no claims, and nothing links to or from it — delete it, or give it content`,
    concept_slug: row.slug,
  }))
}

// A readable page that carries a scaffolding marker AND states visible claims:
// the one row in the space about which the marker and the content disagree.
//
// WHY the rule exists, and why it is a rule rather than a fix somewhere else.
// The marker decides whether a page is a reference target, and it decides ALONE
// — the counts are not consulted (concepts.ts, and 0.29.0 wrote the consequence
// down under Known). That is deliberate and stays: the rule is then readable off
// a single row, and the marker is the deployment's own statement about that row,
// not an inference WikiKit drew from what happened to be attached to it. Making
// the marker conditional on the counts would trade this loud, rare problem for a
// quiet, common one — a page that silently changes category when a claim lands
// or is deprecated, with nothing in the row to explain why.
//
// What that costs is real and was, until this rule, entirely unannounced. Such a
// page's `evidence` is withheld from the concept list and from search hits, the
// three fault rules above skip it, and the claims themselves are perfectly
// visible on the page read — so the index says "not measured" about a page whose
// claims are genuine knowledge, and every surface an operator would check to
// find out why agrees that nothing is wrong. Since 0.29.0 an operator can even
// create the state from outside: declare a marker that pages with claims carry
// and a real measurement leaves the index, with no report anywhere. Loud is the
// answer. Not forbidden — the state is not illegal, it is contradictory, and the
// only thing wrong with it is that nobody was told.
//
// WHY `scaffolded-claims` and not `scaffolded-concepts` in the register of its
// `-concepts` neighbours. Those adjectives each name the fault that selects the
// page (orphan, unsourced, stub, empty), and "scaffolded" names no fault at all
// — every reference target is scaffolded, and reporting reference targets is
// precisely what this rule must not do. The claims are what make the row
// reportable, so they are the noun; and a reader who meets `scaffolded-claims`
// in a CI log has the whole contradiction in two words, with a term
// (`WIKIKIT_SCAFFOLDING_KINDS`) they can grep for.
//
// WHY warn, in the same three-way its two nearest neighbours argue:
//   * NOT error. The error rules describe knowledge that is simply wrong — a
//     claim nobody can check, a link into the void, a frame asserting two
//     things. Here the knowledge is fine: the claims are real, cited or not on
//     their own merits, and the page read shows them exactly as it should. What
//     is wrong is the INDEX's account of the page, and one of the two readings
//     below (a marker that no longer fits) is a page an operator may legitimately
//     be part-way through re-categorising. Failing CI on that — on every
//     installation, on upgrade, over a state the operator's own declaration
//     produces — is not a call a lint rule may make on their behalf, and a rule
//     that shouts at a legitimate transient is a rule that gets turned off.
//   * NOT info. info is "noticed, nothing expected of you" — a dangling source,
//     a pending proposal. Something IS expected here, and until it is done a
//     measurement the wiki has already computed is being kept from the index.
//     An info line would also be the rarest entry in a section already full of
//     one line per uncited source and per pending proposal, which is where a
//     rare and important finding goes to die.
// So: warn — somebody should look, nothing is broken.
//
// WHY it reports WikiKit's OWN `structural-reference` pages as well as an
// operator's configured markers — the same threaded list, whole, no split.
// The tempting split is to report only operator markers, on the reasoning that
// WikiKit writes its own reference targets itself and would never put claims on
// one. That reasoning is backwards. A claim on a page an operator's import
// marked is a plausible local convention — somebody stamped a kind on rows that
// turned out to hold knowledge, and the marker is probably the wrong one. A
// claim on a page WikiKit CREATED as furniture, whose body is the product's own
// sentence saying the knowledge lives on the pages it points at, means something
// the product asserts about its own data has stopped being true. That is the
// more alarming of the two and the one an operator can least discover by
// reading their configuration. A rule that trusts an invariant goes silent
// exactly when the invariant breaks.
// It is also one list here for the same reason it is one list everywhere else:
// splitting built-in from configured inside a rule would put a second answer to
// "which markers" in the linter, when the whole point of threading
// `scaffoldingKinds` is that there is one. Provenance is a question for
// GET /v1/installation/knowledge-config, which exists to answer it.
//
// WHAT THE FINDING DOES NOT SAY: the marker. Neither the message nor `details`
// names the `kind` that made the page a reference target, though the query has
// it in hand. Lint is served to agents (the `wikikit_lint` MCP tool), and the
// marker literals are exactly what 0.30.0 declined to hand every connected model
// — a string that makes a page exempt from the evidence measurement and from
// three fault rules is one short step from "write the page with that kind and
// the linter stops complaining". The operator does not need it here either: they
// have the slug, and the markers their own installation honours are one admin
// request away.
async function scaffoldedClaims(db: Db, spaceId: string, kinds: readonly string[] | undefined): Promise<LintFinding[]> {
  const { rows } = await db.query<{ slug: string; claims: number }>(
    // The inverse of every other page-level rule's test, written as the
    // negation of the SAME builder rather than as a second fragment listing the
    // kinds positively: two fragments would be two chances to disagree about
    // which rows are furniture, and this rule must select exactly the rows the
    // other three skip. The negation is total because notScaffolding coalesces
    // the marker to '' before comparing — no row falls out of both sides on a
    // NULL agent_meta, which a bare `NOT IN` over a nullable expression would
    // do silently.
    //
    // An installation that recognises no markers at all gets `NOT (true)` =
    // false and therefore no findings, which is the honest reading: with nothing
    // declared as structure there are no reference targets, so there is no
    // contradiction to report.
    //
    // The count is EVIDENCE_LATERAL — the same aggregate the concept list would
    // have rendered on this row had the marker not withheld it. That is not
    // reuse for its own sake: the number in the message IS the measurement being
    // withheld, and a second hand-written count could tell an operator that four
    // claims are being kept from an index that would have shown six.
    `WITH page AS (
       SELECT c.id, c.slug
         FROM wk_concepts c
         JOIN wk_concept_revisions r ON r.id = c.current_revision_id
        WHERE c.space_id = $1
          AND NOT (${notScaffolding(kinds)})
     )
     SELECT p.slug, ev.claims
       FROM page p
       CROSS JOIN LATERAL (${EVIDENCE_LATERAL}) ev
      WHERE ev.claims > 0
      ORDER BY p.slug`,
    [spaceId],
  )
  return rows.map((row) => ({
    rule: 'scaffolded-claims' as const,
    severity: LINT_SEVERITY['scaffolded-claims'],
    // BOTH readings, in the finding, because the linter cannot tell which one
    // holds and guessing would send half of the operators who read it to edit
    // the wrong thing. Either the marker is wrong for this page (it holds
    // knowledge, so it is not a reference target) or the claims are on the wrong
    // page (they belong where the page points). The count is in the line for the
    // same reason `unsourced-concepts` puts it there — "1 claim" and "23 claims"
    // are the same fault and very different amounts of knowledge to move — and
    // the consequence is spelled out last because it is the part nothing else
    // reports: this page's evidence is missing from the index and no other
    // surface says so.
    message: `concept "${row.slug}" is marked as a reference target but holds ${row.claims} visible claim${
      row.claims === 1 ? '' : 's'
    }: either the marker is wrong for this page, or those claims belong on the page it points at — until one of the two is fixed its evidence is withheld from the index`,
    concept_slug: row.slug,
    details: { claims: row.claims },
  }))
}

// Readable concept with zero visible claims: prose without a single
// verifiable statement — fine for a stub, worth knowing about.
async function emptyConcepts(db: Db, spaceId: string, kinds: readonly string[] | undefined): Promise<LintFinding[]> {
  const { rows } = await db.query<{ slug: string }>(
    `SELECT c.slug
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1
        AND c.current_revision_id IS NOT NULL
        AND ${notScaffolding(kinds)}
        AND NOT EXISTS (
          SELECT 1 FROM wk_claims cl
           WHERE cl.concept_id = c.id
             AND cl.status IN ('verified', 'disputed', 'deprecated')
        )
      ORDER BY c.slug`,
    [spaceId],
  )
  return rows.map((row) => ({
    rule: 'empty-concepts' as const,
    severity: LINT_SEVERITY['empty-concepts'],
    message: `concept "${row.slug}" carries no verifiable claims`,
    concept_slug: row.slug,
  }))
}

async function unreviewedProposals(db: Db, spaceId: string): Promise<LintFinding[]> {
  const { rows } = await db.query<{ id: string; title: string; created_at: Date | string }>(
    `SELECT id, title, created_at
       FROM wk_change_proposals
      WHERE space_id = $1 AND status = 'pending'
      ORDER BY created_at ASC`,
    [spaceId],
  )
  return rows.map((row) => ({
    rule: 'unreviewed-proposals' as const,
    severity: LINT_SEVERITY['unreviewed-proposals'],
    message: `proposal "${row.title}" is awaiting review`,
    details: {
      proposal_id: row.id,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    },
  }))
}

// Archived sources no claim cites: paid for (storage, maybe LLM calls) but
// contributing nothing citable. Often just "ingested but proposal still
// pending/rejected" — info severity on purpose.
async function danglingSources(db: Db, spaceId: string): Promise<LintFinding[]> {
  const { rows } = await db.query<{ id: string; title: string | null; kind: string }>(
    `SELECT s.id, s.title, s.kind
       FROM wk_sources s
      WHERE s.space_id = $1
        AND NOT EXISTS (SELECT 1 FROM wk_citations ci WHERE ci.source_id = s.id)
      ORDER BY s.created_at ASC`,
    [spaceId],
  )
  return rows.map((row) => ({
    rule: 'dangling-sources' as const,
    severity: LINT_SEVERITY['dangling-sources'],
    message: `source "${row.title ?? row.id}" (${row.kind}) is not cited by any claim`,
    details: { source_id: row.id },
  }))
}

// Visible claims citing sources whose stream the connector tombstoned
// (upstream document deleted). Warn, not error, and NO automatic status
// flip: the archived bytes remain valid evidence of what the document SAID —
// whether the claim should be deprecated is a human call, made through a
// normal proposal. Superseded (non-tombstoned) old versions get no finding:
// supersession is normal knowledge evolution.
async function tombstonedSources(db: Db, spaceId: string): Promise<LintFinding[]> {
  const { rows } = await db.query<{
    id: string
    subject: string
    predicate: string
    object: string
    slug: string
    external_source_id: string
    source_id: string
  }>(
    `SELECT DISTINCT cl.id, cl.subject, cl.predicate, cl.object, c.slug,
            st.external_source_id, ci.source_id
       FROM wk_claims cl
       JOIN wk_concepts c ON c.id = cl.concept_id
       JOIN wk_citations ci ON ci.claim_id = cl.id
       JOIN wk_sources s ON s.id = ci.source_id
       JOIN wk_source_streams st ON st.id = s.stream_id
      WHERE cl.space_id = $1
        AND cl.status IN ('verified', 'disputed')
        AND st.deleted_at IS NOT NULL
      ORDER BY c.slug, cl.subject`,
    [spaceId],
  )
  return rows.map((row) => ({
    rule: 'tombstoned-sources' as const,
    severity: LINT_SEVERITY['tombstoned-sources'],
    message: `claim "${row.subject} ${row.predicate} ${row.object}" cites a source whose upstream document was deleted (${row.external_source_id})`,
    concept_slug: row.slug,
    claim_id: row.id,
    details: { source_id: row.source_id, external_source_id: row.external_source_id },
  }))
}

// [[other-space:slug]] markdown links in current revisions whose target is
// not a readable concept in a DECLARED import (0023). The link convention is
// documentation-level — the graph truth lives in relations — so a dangling
// qualified link is a warn, never an error.
async function brokenCrossSpaceLinks(db: Db, spaceId: string): Promise<LintFinding[]> {
  const { rows: revisions } = await db.query<{ slug: string; markdown: string }>(
    `SELECT c.slug, r.markdown
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1`,
    [spaceId],
  )
  const referenced = new Map<string, Set<string>>() // target space → set of "from|targetSlug"
  for (const revision of revisions) {
    for (const match of revision.markdown.matchAll(/\[\[([a-z0-9][a-z0-9-]{0,62}):([a-z0-9][a-z0-9-]{0,126})\]\]/g)) {
      const set = referenced.get(match[1]!) ?? new Set<string>()
      set.add(`${revision.slug}|${match[2]!}`)
      referenced.set(match[1]!, set)
    }
  }
  if (!referenced.size) return []

  const [space] = await db.select<{ settings: Record<string, unknown> }>('wk_spaces', {
    id: `eq.${spaceId}`,
    limit: 1,
  })
  const importsRaw = space?.settings?.['imports']
  const imports = new Set(Array.isArray(importsRaw) ? importsRaw.filter((v): v is string => typeof v === 'string') : [])

  const findings: LintFinding[] = []
  for (const [targetSpace, refs] of referenced) {
    const targetSlugs = [...new Set([...refs].map((ref) => ref.split('|')[1]!))]
    const readable = new Set<string>()
    if (imports.has(targetSpace)) {
      const { rows } = await db.query<{ slug: string }>(
        `SELECT c.slug
           FROM wk_concepts c
           JOIN wk_spaces s ON s.id = c.space_id
          WHERE s.slug = $1 AND c.slug = ANY($2::text[]) AND c.current_revision_id IS NOT NULL`,
        [targetSpace, targetSlugs],
      )
      for (const row of rows) readable.add(row.slug)
    }
    for (const ref of refs) {
      const [fromSlug, targetSlug] = ref.split('|') as [string, string]
      if (readable.has(targetSlug)) continue
      findings.push({
        rule: 'broken-cross-space-links',
        severity: LINT_SEVERITY['broken-cross-space-links'],
        message: imports.has(targetSpace)
          ? `[[${targetSpace}:${targetSlug}]] in "${fromSlug}" targets no readable concept in that space`
          : `[[${targetSpace}:${targetSlug}]] in "${fromSlug}" references a space not declared in settings.imports`,
        concept_slug: fromSlug,
        details: { target_space: targetSpace, target_slug: targetSlug },
      })
    }
  }
  return findings
}

/**
 * Proposal-scoped lint over STAGED content — the review page's "will this
 * approval hurt?" panel. Deliberately a separate severity table from the
 * space lint (LINT_SEVERITY is a fixed contract): these findings judge a
 * pending proposal, not the visible knowledge base. LLM-free.
 */
export type ProposalLintRule =
  'missing-citations' | 'contradictions' | 'broken-relations' | 'stale-claims' | 'stale-base'

export const PROPOSAL_LINT_SEVERITY: Record<ProposalLintRule, LintSeverity> = {
  'missing-citations': 'error',
  contradictions: 'error',
  'stale-base': 'error',
  'broken-relations': 'warn',
  'stale-claims': 'warn',
}

export interface ProposalLintFinding {
  rule: ProposalLintRule
  severity: LintSeverity
  message: string
  concept_slug?: string
  claim_id?: string
  details?: Record<string, unknown>
}

export async function lintProposal(
  db: Db,
  spaceId: string,
  proposalId: string,
): Promise<{ findings: ProposalLintFinding[]; counts: { error: number; warn: number; info: number } }> {
  const findings: ProposalLintFinding[] = []

  // Staged claims without a single citation: approval would create an
  // unfalsifiable claim — the citation contract is the product.
  const uncited = await db.query<{ id: string; subject: string; predicate: string; object: string; slug: string }>(
    `SELECT cl.id, cl.subject, cl.predicate, cl.object, c.slug
       FROM wk_claims cl
       JOIN wk_concepts c ON c.id = cl.concept_id
      WHERE cl.proposal_id = $2 AND cl.space_id = $1 AND cl.status = 'proposed'
        AND NOT EXISTS (SELECT 1 FROM wk_citations ci WHERE ci.claim_id = cl.id)
      ORDER BY c.slug`,
    [spaceId, proposalId],
  )
  for (const row of uncited.rows) {
    findings.push({
      rule: 'missing-citations',
      severity: PROPOSAL_LINT_SEVERITY['missing-citations'],
      message: `staged claim "${row.subject} ${row.predicate} ${row.object}" has no citation`,
      concept_slug: row.slug,
      claim_id: row.id,
    })
  }

  // Frame collisions with EXISTING visible claims: approval will mark both
  // sides disputed — the impact warning. This is the THIRD surface on the
  // review screen that answers "will this approval hurt?", after the proposal
  // diff's `collides` flag and the rendered review page, and the message here
  // promises the same thing they do: "approval disputes both". So every
  // condition below is a condition of wk_apply_proposal flip 5 (0022), and the
  // declared predicate set is resolved by the SAME helper the diff and the
  // space rule above use. A finding that is broader than the flip tells the
  // reviewer a consequence the approval will not produce, and one that is
  // narrower hides a consequence it will:
  //   * functional predicates — predicate cardinality is space configuration,
  //     empty by default (0003, 0021). getFunctionalPredicates unions the
  //     typed `predicate_defs` registry with the legacy
  //     `functional_predicates` array, exactly as the SQL
  //     wk_functional_predicates v2 does. The hand-inlined settings lookup
  //     that stood here read only the legacy array, so a space declaring its
  //     predicates through the registry got NO findings at all while a space
  //     using the array got collisions the flip would not create — silently,
  //     because a query that reads the wrong half of a settings object never
  //     fails.
  //   * context / normalized object / overlapping validity / the
  //     adjudication='complementary' stamp / explicit supersession — the 0021
  //     refinements. A partitioned frame ('region:eu' vs 'region:us'), two
  //     canonically equal values ('1 GiB' vs '1024 MiB'), disjoint validity
  //     (succession), an adjudicated complement and a staged supersession all
  //     look like collisions to the coarse subject+predicate+different-object
  //     rule, and none of them dispute anything.
  // Rejected: re-inlining the settings lookup in SQL to save this round trip —
  // the two representations of the declaration are exactly what a hand-inlined
  // copy gets wrong, and this is a diagnostics endpoint, not a hot path.
  const functionalPredicates = await getFunctionalPredicates(db, spaceId)
  // An empty declared set is the default, and no claim can collide under it —
  // `= ANY('{}')` is false for every row, so the query would be a round trip
  // that can only return nothing.
  if (functionalPredicates.length) {
    const colliding = await db.query<{
      id: string
      subject: string
      predicate: string
      object: string
      slug: string
      existing_object: string
    }>(
      `SELECT cl.id, cl.subject, cl.predicate, cl.object, c.slug, other.object AS existing_object
         FROM wk_claims cl
         JOIN wk_concepts c ON c.id = cl.concept_id
         JOIN wk_claims other
           ON other.space_id = cl.space_id
          AND other.subject = cl.subject
          AND other.predicate = cl.predicate
          AND coalesce(other.context, '') = coalesce(cl.context, '')
          AND coalesce(other.object_normalized, other.object)
              <> coalesce(cl.object_normalized, cl.object)
          AND other.proposal_id IS DISTINCT FROM cl.proposal_id
          AND other.status IN ('verified', 'disputed')
          AND coalesce(cl.valid_from, '-infinity'::timestamptz)
              < coalesce(other.valid_until, 'infinity'::timestamptz)
          AND coalesce(other.valid_from, '-infinity'::timestamptz)
              < coalesce(cl.valid_until, 'infinity'::timestamptz)
          AND (cl.supersedes_claim_id IS NULL OR cl.supersedes_claim_id <> other.id)
        WHERE cl.proposal_id = $2 AND cl.space_id = $1 AND cl.status = 'proposed'
          AND cl.predicate = ANY($3::text[])
          AND coalesce(cl.agent_meta->>'adjudication', '') <> 'complementary'
        ORDER BY c.slug`,
      [spaceId, proposalId, functionalPredicates],
    )
    for (const row of colliding.rows) {
      findings.push({
        rule: 'contradictions',
        severity: PROPOSAL_LINT_SEVERITY.contradictions,
        message: `staged claim "${row.subject} ${row.predicate} ${row.object}" collides with existing "${row.existing_object}" — approval disputes both`,
        concept_slug: row.slug,
        claim_id: row.id,
      })
    }
  }

  // Stale base: approval WILL fail (mirrors the wk_apply_proposal check).
  const stale = await db.query<{ slug: string }>(
    `SELECT c.slug
       FROM wk_concept_revisions r
       JOIN wk_concepts c ON c.id = r.concept_id
      WHERE r.proposal_id = $2 AND r.space_id = $1 AND r.status = 'proposed'
        AND c.current_revision_id IS DISTINCT FROM r.base_revision_id
      ORDER BY c.slug`,
    [spaceId, proposalId],
  )
  for (const row of stale.rows) {
    findings.push({
      rule: 'stale-base',
      severity: PROPOSAL_LINT_SEVERITY['stale-base'],
      message: `concept "${row.slug}" moved on since synthesis — approval will fail with stale_base; re-ingest the source`,
      concept_slug: row.slug,
    })
  }

  // Staged relations whose target is a placeholder with neither a current
  // revision nor a staged one in THIS proposal: the link will dangle.
  const dangling = await db.query<{ from_slug: string; to_slug: string; kind: string }>(
    `SELECT f.slug AS from_slug, t.slug AS to_slug, rel.kind
       FROM wk_relations rel
       JOIN wk_concepts f ON f.id = rel.from_concept_id
       JOIN wk_concepts t ON t.id = rel.to_concept_id
      WHERE rel.proposal_id = $2 AND rel.space_id = $1 AND rel.status = 'proposed'
        AND t.current_revision_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM wk_concept_revisions tr
           WHERE tr.concept_id = t.id AND tr.proposal_id = $2 AND tr.status = 'proposed'
        )
      ORDER BY f.slug, t.slug`,
    [spaceId, proposalId],
  )
  for (const row of dangling.rows) {
    findings.push({
      rule: 'broken-relations',
      severity: PROPOSAL_LINT_SEVERITY['broken-relations'],
      message: `staged relation ${row.from_slug} ${row.kind} → ${row.to_slug} targets a concept with no readable page`,
      concept_slug: row.from_slug,
    })
  }

  // Staged claims already expired at staging time.
  const expired = await db.query<{ id: string; subject: string; predicate: string; object: string; slug: string }>(
    `SELECT cl.id, cl.subject, cl.predicate, cl.object, c.slug
       FROM wk_claims cl
       JOIN wk_concepts c ON c.id = cl.concept_id
      WHERE cl.proposal_id = $2 AND cl.space_id = $1 AND cl.status = 'proposed'
        AND cl.valid_until IS NOT NULL AND cl.valid_until < now()
      ORDER BY c.slug`,
    [spaceId, proposalId],
  )
  for (const row of expired.rows) {
    findings.push({
      rule: 'stale-claims',
      severity: PROPOSAL_LINT_SEVERITY['stale-claims'],
      message: `staged claim "${row.subject} ${row.predicate} ${row.object}" is already expired (valid_until in the past)`,
      concept_slug: row.slug,
      claim_id: row.id,
    })
  }

  const order: Record<LintSeverity, number> = { error: 0, warn: 1, info: 2 }
  findings.sort((a, b) => order[a.severity] - order[b.severity])
  const counts = { error: 0, warn: 0, info: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return { findings, counts }
}

/**
 * Run every check. Findings are ordered error → warn → info so the first line
 * of output is always the worst problem; counts let CI gate with a single
 * jq expression (plan §13.F).
 */
export async function lintSpace(db: Db, spaceId: string, options: ScaffoldingOptions = {}): Promise<LintReport> {
  const kinds = options.scaffoldingKinds
  // Sequential on purpose: lint runs on demand over one pool — eight parallel
  // queries would hog connections for a diagnostics endpoint.
  const findings: LintFinding[] = [
    ...(await contradictions(db, spaceId)),
    ...(await missingCitations(db, spaceId)),
    ...(await brokenRelations(db, spaceId)),
    ...(await staleClaims(db, spaceId)),
    ...(await orphanConcepts(db, spaceId, kinds)),
    ...(await unsourcedConcepts(db, spaceId, kinds)),
    ...(await tombstonedSources(db, spaceId)),
    ...(await brokenCrossSpaceLinks(db, spaceId)),
    ...(await stubConcepts(db, spaceId)),
    ...(await scaffoldedClaims(db, spaceId, kinds)),
    ...(await emptyConcepts(db, spaceId, kinds)),
    ...(await unreviewedProposals(db, spaceId)),
    ...(await danglingSources(db, spaceId)),
  ]
  const counts = { error: 0, warn: 0, info: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return { findings, counts }
}
