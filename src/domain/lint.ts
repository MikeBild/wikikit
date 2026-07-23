// Knowledge-base hygiene checks (plan §5, CONTRACTS §4) — LLM-free, pure SQL,
// CI-consumable via GET /v1/spaces/{space}/lint.
//
// The severity mapping is FIXED by contract (do not tune it per space):
//   error: contradictions, missing-citations, broken-relations
//   warn:  stale-claims, orphan-concepts
//   info:  empty-concepts, unreviewed-proposals, dangling-sources
//
// Every rule is one space-scoped query over the READER-VISIBLE state (current
// revisions, verified/disputed/deprecated claims, active relations) — lint
// judges the knowledge base users actually see, never the staging area. The
// one deliberate exception is unreviewed-proposals, whose whole point is to
// surface the staging backlog.
import type { Db } from '../db/postgres.ts'
import { getFunctionalPredicates } from './claims.ts'

export type LintRule =
  | 'contradictions'
  | 'missing-citations'
  | 'broken-relations'
  | 'stale-claims'
  | 'orphan-concepts'
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
async function orphanConcepts(db: Db, spaceId: string): Promise<LintFinding[]> {
  const { rows } = await db.query<{ slug: string }>(
    `SELECT c.slug
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1
        AND c.current_revision_id IS NOT NULL
        AND coalesce(r.agent_meta->>'kind', '') NOT IN ('structural-reference', 'subkit-domain-migration-relation-repair')
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

// Readable concept with zero visible claims: prose without a single
// verifiable statement — fine for a stub, worth knowing about.
async function emptyConcepts(db: Db, spaceId: string): Promise<LintFinding[]> {
  const { rows } = await db.query<{ slug: string }>(
    `SELECT c.slug
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1
        AND c.current_revision_id IS NOT NULL
        AND coalesce(r.agent_meta->>'kind', '') NOT IN ('structural-reference', 'subkit-domain-migration-relation-repair')
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

  // Frame collisions with EXISTING visible claims (same rule as apply flip 5):
  // approval will mark both sides disputed — the impact warning.
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
        AND other.object <> cl.object
        AND other.status IN ('verified', 'disputed')
      WHERE cl.proposal_id = $2 AND cl.space_id = $1 AND cl.status = 'proposed'
        AND cl.predicate = ANY (
          SELECT jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(s.settings->'functional_predicates') = 'array'
                 THEN s.settings->'functional_predicates' ELSE '[]'::jsonb END)
            FROM wk_spaces s WHERE s.id = $1
        )
      ORDER BY c.slug`,
    [spaceId, proposalId],
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
export async function lintSpace(db: Db, spaceId: string): Promise<LintReport> {
  // Sequential on purpose: lint runs on demand over one pool — eight parallel
  // queries would hog connections for a diagnostics endpoint.
  const findings: LintFinding[] = [
    ...(await contradictions(db, spaceId)),
    ...(await missingCitations(db, spaceId)),
    ...(await brokenRelations(db, spaceId)),
    ...(await staleClaims(db, spaceId)),
    ...(await orphanConcepts(db, spaceId)),
    ...(await tombstonedSources(db, spaceId)),
    ...(await brokenCrossSpaceLinks(db, spaceId)),
    ...(await emptyConcepts(db, spaceId)),
    ...(await unreviewedProposals(db, spaceId)),
    ...(await danglingSources(db, spaceId)),
  ]
  const counts = { error: 0, warn: 0, info: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return { findings, counts }
}
