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
  const { rows } = await db.query<{
    subject: string
    predicate: string
    objects: string[]
    claim_ids: string[]
    slugs: string[]
  }>(
    `SELECT cl.subject, cl.predicate,
            array_agg(DISTINCT cl.object) AS objects,
            array_agg(cl.id::text) AS claim_ids,
            array_agg(DISTINCT c.slug) AS slugs
       FROM wk_claims cl
       JOIN wk_concepts c ON c.id = cl.concept_id
      WHERE cl.space_id = $1
        AND cl.predicate = ANY($2::text[])
        AND cl.status IN ('verified', 'disputed')
      GROUP BY cl.subject, cl.predicate
     HAVING count(DISTINCT cl.object) > 1
      ORDER BY cl.subject, cl.predicate`,
    [spaceId, functionalPredicates],
  )
  return rows.map((row) => ({
    rule: 'contradictions' as const,
    severity: LINT_SEVERITY.contradictions,
    message: `contradictory frame "${row.subject} ${row.predicate}": ${row.objects.join(' vs ')}`,
    concept_slug: row.slugs[0],
    details: {
      subject: row.subject,
      predicate: row.predicate,
      objects: row.objects,
      claim_ids: row.claim_ids,
      concepts: row.slugs,
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
    ...(await emptyConcepts(db, spaceId)),
    ...(await unreviewedProposals(db, spaceId)),
    ...(await danglingSources(db, spaceId)),
  ]
  const counts = { error: 0, warn: 0, info: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return { findings, counts }
}
