// wk_relations — typed links between concepts (CONTRACTS §1.7, §4).
//
// Read-only module by design: relations are WRITTEN exclusively through the
// proposal staging path (proposals.createProposal inserts status='proposed'
// rows; wk_apply_proposal activates them and synthesizes 'contradicts'
// relations for disputed claim pairs). There is deliberately no
// createRelation here — a relation that skipped the review gate would be
// unaudited knowledge.
import type { Db } from '../db/postgres.ts'
import { NotFoundError } from './errors.ts'
import { isoString } from './sources.ts'

export type RelationKind = 'related' | 'part_of' | 'depends_on' | 'contradicts' | 'supersedes'

export const RELATION_KINDS = ['related', 'part_of', 'depends_on', 'contradicts', 'supersedes'] as const

export interface Relation {
  id: string
  from_slug: string
  from_title: string
  to_slug: string
  to_title: string
  kind: RelationKind
  /** 'out' = conceptId is the from-side, 'in' = the to-side. */
  direction: 'out' | 'in'
  /** Target wiki's slug for a cross-space link (0023), null intra-space. */
  space: string | null
  created_at: string
}

/**
 * Active relations touching a concept, both directions, with endpoint slugs
 * AND titles resolved. WHY both directions: 'contradicts' pairs are inserted
 * one-way by wk_apply_proposal (fresh → old), but a reader of EITHER concept
 * must see the dispute — a one-directional read would hide half of every
 * conflict.
 *
 * Titles come from the CURRENT revisions, falling back to the identity row's
 * title where no readable page exists (a bare relation target has an identity
 * and a title but no revision): every active relation stays visible — hiding
 * one because its endpoint is not readable would hide knowledge, and
 * `broken-relations` (lint) owns reporting the broken ones. The inbound side
 * is same-space by construction: `rel.space_id = $1` keeps a foreign wiki's
 * relation INTO this concept out, exactly as zConceptNeighborsResponse
 * promises.
 */
export async function listRelations(db: Db, spaceId: string, args: { conceptId: string }): Promise<Relation[]> {
  const { rows } = await db.query<{
    id: string
    from_slug: string
    from_title: string
    to_slug: string
    to_title: string
    kind: RelationKind
    from_concept_id: string
    space: string | null
    created_at: Date | string
  }>(
    `SELECT rel.id, f.slug AS from_slug, COALESCE(fr.title, f.title) AS from_title,
            t.slug AS to_slug, COALESCE(tr.title, t.title) AS to_title,
            rel.kind, rel.from_concept_id,
            CASE WHEN rel.to_space_id IS NULL THEN NULL ELSE ts.slug END AS space,
            rel.created_at
       FROM wk_relations rel
       JOIN wk_concepts f ON f.id = rel.from_concept_id
       LEFT JOIN wk_concept_revisions fr ON fr.id = f.current_revision_id
       JOIN wk_concepts t ON t.id = rel.to_concept_id
       LEFT JOIN wk_concept_revisions tr ON tr.id = t.current_revision_id
       LEFT JOIN wk_spaces ts ON ts.id = rel.to_space_id
      WHERE rel.space_id = $1
        AND rel.status = 'active'
        AND (rel.from_concept_id = $2 OR rel.to_concept_id = $2)
      ORDER BY rel.kind ASC, f.slug ASC, t.slug ASC`,
    [spaceId, args.conceptId],
  )
  return rows.map((row) => ({
    id: row.id,
    from_slug: row.from_slug,
    from_title: row.from_title,
    to_slug: row.to_slug,
    to_title: row.to_title,
    kind: row.kind,
    direction: row.from_concept_id === args.conceptId ? 'out' : 'in',
    space: row.space,
    created_at: isoString(row.created_at),
  }))
}

export interface SameSourceSibling {
  slug: string
  title: string
  shared_sources: number
}

/**
 * Concepts of the same space that quote the same archived sources — the
 * neighbors no relation names yet. Ranked by how many distinct sources the
 * two pages share, because the count IS the argument for the suggestion.
 *
 * Only verified/disputed claims on both sides: 'deprecated' is visible on a
 * page for honesty about its past, but withdrawn evidence must not drive
 * navigation, and staged claims are not knowledge at all. Concepts already
 * related to this one (either direction) and the concept itself are excluded —
 * this list exists to surface what the relations panel does NOT already show.
 */
export async function sameSourceSiblings(
  db: Db,
  spaceId: string,
  conceptId: string,
  args: { limit?: number } = {},
): Promise<SameSourceSibling[]> {
  const limit = Math.max(1, Math.min(args.limit ?? 10, 50))
  const { rows } = await db.query<{ slug: string; title: string; shared_sources: number }>(
    `SELECT c2.slug, r2.title, count(DISTINCT ci1.source_id)::int AS shared_sources
       FROM wk_claims cl1
       JOIN wk_citations ci1 ON ci1.claim_id = cl1.id
       JOIN wk_citations ci2 ON ci2.source_id = ci1.source_id
       JOIN wk_claims cl2 ON cl2.id = ci2.claim_id
       JOIN wk_concepts c2 ON c2.id = cl2.concept_id
       JOIN wk_concept_revisions r2 ON r2.id = c2.current_revision_id
      WHERE cl1.space_id = $1
        AND cl1.concept_id = $2
        AND cl1.status IN ('verified', 'disputed')
        AND cl2.space_id = $1
        AND cl2.concept_id <> $2
        AND cl2.status IN ('verified', 'disputed')
        AND NOT EXISTS (
              SELECT 1 FROM wk_relations rel
               WHERE rel.space_id = $1
                 AND rel.status = 'active'
                 AND ((rel.from_concept_id = $2 AND rel.to_concept_id = c2.id)
                   OR (rel.from_concept_id = c2.id AND rel.to_concept_id = $2)))
      GROUP BY c2.slug, r2.title
      ORDER BY shared_sources DESC, c2.slug ASC
      LIMIT $3`,
    [spaceId, conceptId, limit],
  )
  return rows.map((row) => ({ slug: row.slug, title: row.title, shared_sources: row.shared_sources }))
}

export interface ConceptNeighbors {
  relations: { slug: string; title: string; kind: RelationKind; direction: 'out' | 'in'; space: string | null }[]
  same_source: SameSourceSibling[]
}

/**
 * The neighbors read — one producer for GET .../concepts/{slug}/neighbors.
 * The same 404 contract as getConcept: a concept without a current revision is
 * indistinguishable from one that never existed. Each relation row is folded
 * to its FAR endpoint — the page a reader would go to — with `space` non-null
 * only on an outgoing cross-wiki link (inbound is same-space by construction).
 */
export async function conceptNeighbors(db: Db, spaceId: string, args: { slug: string }): Promise<ConceptNeighbors> {
  const { rows } = await db.query<{ concept_id: string }>(
    `SELECT c.id AS concept_id
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1 AND c.slug = $2`,
    [spaceId, args.slug],
  )
  const concept = rows[0]
  if (!concept) throw new NotFoundError(`concept ${args.slug} not found`)

  const relations = await listRelations(db, spaceId, { conceptId: concept.concept_id })
  const siblings = await sameSourceSiblings(db, spaceId, concept.concept_id, { limit: 10 })
  return {
    relations: relations.map((relation) =>
      relation.direction === 'out'
        ? {
            slug: relation.to_slug,
            title: relation.to_title,
            kind: relation.kind,
            direction: 'out',
            space: relation.space,
          }
        : { slug: relation.from_slug, title: relation.from_title, kind: relation.kind, direction: 'in', space: null },
    ),
    same_source: siblings,
  }
}
