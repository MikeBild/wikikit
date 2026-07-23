// wk_concepts / wk_concept_revisions — the wiki-page read model (CONTRACTS
// §1.3, §1.4, §4).
//
// The visibility rule everything here relies on: a concept is readable ONLY
// through wk_concepts.current_revision_id. Revisions are immutable; proposed
// revisions exist as rows but are invisible BY CONSTRUCTION because every
// read joins over the current pointer — there is no status filter to forget.
// The single exception is getConceptHistory, whose entire purpose is the
// audit trail (all statuses, with agent_meta).
import type { Db } from '../db/postgres.ts'
import { VISIBLE_CLAIM_STATUSES, type ClaimWithCitations, listClaimsForConcept } from './claims.ts'
import { NotFoundError } from './errors.ts'
import { clampLimit, decodeCursor, encodeCursor, isoString } from './sources.ts'

export interface ConceptSummary {
  slug: string
  title: string
  summary: string
  rev: number
  updated_at: string
}

/** Compact index handed to the classify LLM call — slug/title/summary only. */
export interface ConceptIndexEntry {
  slug: string
  title: string
  summary: string
}

export type RelationKindValue = 'related' | 'part_of' | 'depends_on' | 'contradicts' | 'supersedes'

/**
 * Full concept read. A SUPERSET of the §5.3 wire contract: revision_id (the
 * stale-base anchor the ingest pipeline synthesizes against) and the per-claim
 * audit fields never leave the process — both transports serve
 * toConceptResponse(detail), never this shape verbatim.
 */
export interface ConceptDetail {
  slug: string
  title: string
  summary: string
  markdown: string
  rev: number
  /** Id of the current revision — what a synthesis based on this read must anchor to. */
  revision_id: string
  updated_at: string
  claims: ClaimWithCitations[]
  relations: { to_slug: string; kind: RelationKindValue; space: string | null }[]
  agent_meta: Record<string, unknown>
}

/**
 * The §5.3 zConceptResponse wire mapping, shared by REST getConceptHandler
 * AND MCP wikikit_read so the two transports can never disagree. Explicit
 * field-by-field: ConceptDetail carries more (revision_id; per-claim
 * valid_from/valid_until/created_at/agent_meta) than the published contract —
 * serve exactly the contract, no accidental surface.
 */
export function toConceptResponse(concept: ConceptDetail): Record<string, unknown> {
  return {
    slug: concept.slug,
    title: concept.title,
    summary: concept.summary,
    markdown: concept.markdown,
    rev: concept.rev,
    updated_at: concept.updated_at,
    claims: concept.claims.map((claim) => ({
      id: claim.id,
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      status: claim.status,
      confidence: claim.confidence,
      citations: claim.citations,
    })),
    relations: concept.relations,
    agent_meta: concept.agent_meta,
  }
}

export interface RevisionSummary {
  id: string
  rev: number
  status: 'proposed' | 'current' | 'superseded' | 'rejected'
  title: string
  summary: string
  base_revision_id: string | null
  proposal_id: string | null
  agent_meta: Record<string, unknown>
  created_at: string
}

interface ConceptRevisionRow {
  concept_id: string
  revision_id: string
  slug: string
  title: string
  summary: string
  markdown: string
  rev: number
  updated_at: Date | string
  agent_meta: Record<string, unknown>
}

/**
 * List readable concepts (those with a current revision) with keyset
 * pagination and the space epoch (the ETag driver for list endpoints).
 *
 * WHY slug-ordered instead of updated_at: a wiki listing is an index, and a
 * slug keyset is immune to rows moving while a client pages (an approval
 * bumping updated_at would make a time-ordered keyset skip or repeat).
 */
export async function listConcepts(
  db: Db,
  spaceId: string,
  args: { limit?: number; after?: string } = {},
): Promise<{ items: ConceptSummary[]; next_after: string | null; epoch: number }> {
  const limit = clampLimit(args.limit, 50, 200)
  const [space] = await db.select<{ epoch: string | number }>('wk_spaces', { id: `eq.${spaceId}`, limit: 1 })
  if (!space) throw new NotFoundError('space not found')

  const values: unknown[] = [spaceId]
  let keyset = ''
  if (args.after) {
    const [slug] = decodeCursor(args.after, 1)
    values.push(slug)
    keyset = ' AND c.slug > $2'
  }
  values.push(limit + 1)
  const { rows } = await db.query<{ slug: string; title: string; summary: string; rev: number; updated_at: Date }>(
    `SELECT c.slug, r.title, r.summary, r.rev, c.updated_at
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1${keyset}
      ORDER BY c.slug ASC
      LIMIT $${values.length}`,
    values,
  )
  const page = rows.slice(0, limit)
  const items = page.map((row) => ({
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    rev: row.rev,
    updated_at: isoString(row.updated_at),
  }))
  const last = page.at(-1)
  return {
    items,
    next_after: rows.length > limit && last ? encodeCursor(last.slug) : null,
    epoch: Number(space.epoch),
  }
}

/**
 * Full concept read: current revision + visible claims with citations +
 * active outgoing relations. A concept whose only revisions are proposed (or
 * rejected) has no current pointer and is a 404 — indistinguishable from a
 * concept that never existed, which is exactly the staging-area contract.
 */
export async function getConcept(db: Db, spaceId: string, args: { slug: string }): Promise<ConceptDetail> {
  const { rows } = await db.query<ConceptRevisionRow>(
    `SELECT c.id AS concept_id, r.id AS revision_id, c.slug, r.title, r.summary, r.markdown, r.rev, c.updated_at, r.agent_meta
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1 AND c.slug = $2`,
    [spaceId, args.slug],
  )
  const concept = rows[0]
  if (!concept) throw new NotFoundError(`concept ${args.slug} not found`)

  const claims = await listClaimsForConcept(db, spaceId, {
    conceptId: concept.concept_id,
    statuses: [...VISIBLE_CLAIM_STATUSES],
  })

  // Outgoing relations only, per zConceptResponse ({to_slug, kind}) — the
  // bidirectional view lives in relations.listRelations.
  // Cross-space targets (0023) carry the target space slug for provenance;
  // a dangling foreign target (space deleted, cascade removed the row) simply
  // no longer joins. Targets that lost their readable page are filtered like
  // local ones never were — lint surfaces those.
  const relations = await db.query<{ to_slug: string; kind: RelationKindValue; space: string | null }>(
    `SELECT t.slug AS to_slug, rel.kind,
            CASE WHEN rel.to_space_id IS NULL THEN NULL ELSE ts.slug END AS space
       FROM wk_relations rel
       JOIN wk_concepts t ON t.id = rel.to_concept_id
       LEFT JOIN wk_spaces ts ON ts.id = rel.to_space_id
      WHERE rel.space_id = $1 AND rel.from_concept_id = $2 AND rel.status = 'active'
      ORDER BY t.slug ASC, rel.kind ASC`,
    [spaceId, concept.concept_id],
  )

  return {
    slug: concept.slug,
    title: concept.title,
    summary: concept.summary,
    markdown: concept.markdown,
    rev: concept.rev,
    revision_id: concept.revision_id,
    updated_at: isoString(concept.updated_at),
    claims,
    relations: relations.rows,
    agent_meta: concept.agent_meta ?? {},
  }
}

/**
 * Revision history INCLUDING proposed/rejected revisions and their agent_meta
 * (model, prompt_version, input_hash, source_ids) — the audit surface that
 * makes "which model wrote this, from what, reviewed by whom" answerable.
 * Newest first. The concept itself must exist (identity row), but does not
 * need a current revision: history of a still-staged concept is legitimate
 * audit data for knowledge:read holders.
 */
export async function getConceptHistory(db: Db, spaceId: string, args: { slug: string }): Promise<RevisionSummary[]> {
  const [concept] = await db.select<{ id: string }>('wk_concepts', {
    space_id: `eq.${spaceId}`,
    slug: `eq.${args.slug}`,
    limit: 1,
  })
  if (!concept) throw new NotFoundError(`concept ${args.slug} not found`)
  const rows = await db.select<{
    id: string
    rev: number
    status: RevisionSummary['status']
    title: string
    summary: string
    base_revision_id: string | null
    proposal_id: string | null
    agent_meta: Record<string, unknown>
    created_at: Date | string
  }>('wk_concept_revisions', { concept_id: `eq.${concept.id}`, order: 'rev.desc' })
  return rows.map((row) => ({
    id: row.id,
    rev: row.rev,
    status: row.status,
    title: row.title,
    summary: row.summary,
    base_revision_id: row.base_revision_id,
    proposal_id: row.proposal_id,
    agent_meta: row.agent_meta ?? {},
    created_at: isoString(row.created_at),
  }))
}

/**
 * The compact concept index fed to the classify call: every READABLE concept
 * as {slug, title, summary}. Deliberately summary-only — the classifier
 * decides which concepts a source touches, it never needs full bodies (and
 * the index must stay small enough to ship in one prompt).
 */
export async function getConceptIndex(db: Db, spaceId: string): Promise<ConceptIndexEntry[]> {
  const { rows } = await db.query<ConceptIndexEntry>(
    `SELECT c.slug, r.title, r.summary
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1
      ORDER BY c.slug ASC`,
    [spaceId],
  )
  return rows
}
