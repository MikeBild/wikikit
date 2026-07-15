// wk_relations — typed links between concepts (CONTRACTS §1.7, §4).
//
// Read-only module by design: relations are WRITTEN exclusively through the
// proposal staging path (proposals.createProposal inserts status='proposed'
// rows; wk_apply_proposal activates them and synthesizes 'contradicts'
// relations for disputed claim pairs). There is deliberately no
// createRelation here — a relation that skipped the review gate would be
// unaudited knowledge.
import type { Db } from '../db/postgres.ts'
import { isoString } from './sources.ts'

export type RelationKind = 'related' | 'part_of' | 'depends_on' | 'contradicts' | 'supersedes'

export const RELATION_KINDS = ['related', 'part_of', 'depends_on', 'contradicts', 'supersedes'] as const

export interface Relation {
  id: string
  from_slug: string
  to_slug: string
  kind: RelationKind
  /** 'out' = conceptId is the from-side, 'in' = the to-side. */
  direction: 'out' | 'in'
  created_at: string
}

/**
 * Active relations touching a concept, both directions, with endpoint slugs
 * resolved. WHY both directions: 'contradicts' pairs are inserted one-way by
 * wk_apply_proposal (fresh → old), but a reader of EITHER concept must see
 * the dispute — a one-directional read would hide half of every conflict.
 */
export async function listRelations(db: Db, spaceId: string, args: { conceptId: string }): Promise<Relation[]> {
  const { rows } = await db.query<{
    id: string
    from_slug: string
    to_slug: string
    kind: RelationKind
    from_concept_id: string
    created_at: Date | string
  }>(
    `SELECT rel.id, f.slug AS from_slug, t.slug AS to_slug, rel.kind, rel.from_concept_id, rel.created_at
       FROM wk_relations rel
       JOIN wk_concepts f ON f.id = rel.from_concept_id
       JOIN wk_concepts t ON t.id = rel.to_concept_id
      WHERE rel.space_id = $1
        AND rel.status = 'active'
        AND (rel.from_concept_id = $2 OR rel.to_concept_id = $2)
      ORDER BY rel.kind ASC, f.slug ASC, t.slug ASC`,
    [spaceId, args.conceptId],
  )
  return rows.map((row) => ({
    id: row.id,
    from_slug: row.from_slug,
    to_slug: row.to_slug,
    kind: row.kind,
    direction: row.from_concept_id === args.conceptId ? 'out' : 'in',
    created_at: isoString(row.created_at),
  }))
}
