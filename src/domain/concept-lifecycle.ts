import type { Db } from '../db/postgres.ts'
import { ConflictError, NotFoundError } from './errors.ts'
import { clampLimit, isoString, sha256Hex } from './sources.ts'

export type ConceptLifecycleAction = 'delete' | 'restore'
export interface DeletedConcept {
  slug: string
  title: string
  deleted_at: string
  deleted_revision_id: string
}
export interface LifecycleProposal {
  proposal_id: string
  status: 'pending'
  action: ConceptLifecycleAction
  slug: string
}

export async function stageConceptLifecycle(
  db: Db,
  spaceId: string,
  args: { slug: string; action: ConceptLifecycleAction; actor: string },
): Promise<LifecycleProposal> {
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{
      id: string
      title: string
      current_revision_id: string | null
      deleted_revision_id: string | null
    }>(
      'SELECT id, title, current_revision_id, deleted_revision_id FROM wk_concepts WHERE space_id = $1 AND slug = $2 FOR UPDATE',
      [spaceId, args.slug],
    )
    const concept = rows[0]
    if (!concept) throw new NotFoundError(`concept ${args.slug} not found`)
    const revisionId = args.action === 'delete' ? concept.current_revision_id : concept.deleted_revision_id
    if (!revisionId) {
      throw new ConflictError(
        args.action === 'delete' ? 'concept_not_readable' : 'concept_not_deleted',
        `concept ${args.slug} cannot be ${args.action}d`,
      )
    }
    const inputHash = sha256Hex(`concept:${args.action}:${args.slug}:${revisionId}`)
    const [existing] = await tx.select<{ id: string }>('wk_change_proposals', {
      space_id: `eq.${spaceId}`,
      input_hash: `eq.${inputHash}`,
      status: 'eq.pending',
      limit: 1,
    })
    if (existing) return { proposal_id: existing.id, status: 'pending', action: args.action, slug: args.slug }
    const [proposal] = await tx.insert<{ id: string }>('wk_change_proposals', {
      space_id: spaceId,
      title: `${args.action === 'delete' ? 'Delete' : 'Restore'} page: ${concept.title}`,
      summary:
        args.action === 'delete'
          ? `Remove ${args.slug} from current knowledge after review.`
          : `Restore the last visible revision of ${args.slug} after review.`,
      input_hash: inputHash,
      source_ids: [],
      agent_meta: JSON.stringify({ model: 'manual', prompt_version: 'concept-lifecycle', actor: args.actor }),
    })
    await tx.insert('wk_concept_lifecycle_changes', {
      space_id: spaceId,
      concept_id: concept.id,
      proposal_id: proposal!.id,
      action: args.action,
      revision_id: revisionId,
    })
    if (args.action === 'delete') {
      await tx.query(
        `UPDATE wk_relations SET removal_proposal_id = $3
          WHERE space_id = $1 AND status = 'active'
            AND (from_concept_id = $2 OR (to_concept_id = $2 AND to_space_id IS NULL))`,
        [spaceId, concept.id, proposal!.id],
      )
    }
    const [space] = await tx.select<{ slug: string }>('wk_spaces', { id: `eq.${spaceId}`, limit: 1 })
    await tx.emitEvent(spaceId, 'wikikit.proposal.created', {
      proposal_id: proposal!.id,
      space: space?.slug ?? '',
      title: `${args.action} page: ${concept.title}`,
      source_ids: [],
      concepts: [args.slug],
      claims_count: 0,
      contradictions_count: 0,
      relations_removed_count: 0,
    })
    return { proposal_id: proposal!.id, status: 'pending', action: args.action, slug: args.slug }
  })
}

export async function listDeletedConcepts(
  db: Db,
  spaceId: string,
  args: { limit?: number } = {},
): Promise<{ items: DeletedConcept[] }> {
  const rows = await db.query<{ slug: string; title: string; deleted_at: Date | string; deleted_revision_id: string }>(
    `SELECT slug, title, deleted_at, deleted_revision_id FROM wk_concepts
      WHERE space_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT $2`,
    [spaceId, clampLimit(args.limit, 50, 200)],
  )
  return { items: rows.rows.map((row) => ({ ...row, deleted_at: isoString(row.deleted_at) })) }
}
