// wk_decisions — decision records: context, the decision, rationale and the
// rejected alternatives (CONTRACTS §1.8, §4). The "why did we discard X"
// memory of a space (plan §13.B).
//
// Like relations, this module is read-only: decisions enter through the
// proposal staging path (CreateProposalArgs.decisions) and become visible
// when wk_apply_proposal flips them proposed → active. Readers only ever see
// active/superseded — a decision staged by a rejected proposal stays
// 'proposed' forever (kept for audit, invisible here).
import type { Db } from '../db/postgres.ts'
import { NotFoundError } from './errors.ts'
import { clampLimit, isoString } from './sources.ts'

export type DecisionStatus = 'proposed' | 'active' | 'superseded'

export interface DecisionSummary {
  slug: string
  title: string
  status: Exclude<DecisionStatus, 'proposed'>
  created_at: string
}

export interface Decision extends DecisionSummary {
  context: string
  decision: string
  rationale: string
  alternatives: unknown[]
  agent_meta: Record<string, unknown>
}

interface DecisionRow {
  slug: string
  title: string
  status: Exclude<DecisionStatus, 'proposed'>
  context: string
  decision: string
  rationale: string
  alternatives: unknown[]
  agent_meta: Record<string, unknown>
  created_at: Date | string
}

/** Visible decisions, newest first. Superseded ones stay listed — an outdated
 * decision plus its successor is more informative than a gap. */
export async function listDecisions(
  db: Db,
  spaceId: string,
  args: { limit?: number } = {},
): Promise<DecisionSummary[]> {
  const limit = clampLimit(args.limit, 50, 200)
  const rows = await db.select<DecisionRow>('wk_decisions', {
    space_id: `eq.${spaceId}`,
    status: 'in.(active,superseded)',
    order: 'created_at.desc',
    limit,
  })
  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    status: row.status,
    created_at: isoString(row.created_at),
  }))
}

/** Full decision by slug. A decision that only exists as 'proposed' is a 404
 * — indistinguishable from absence, same staging contract as concepts. */
export async function getDecision(db: Db, spaceId: string, args: { slug: string }): Promise<Decision> {
  const [row] = await db.select<DecisionRow>('wk_decisions', {
    space_id: `eq.${spaceId}`,
    slug: `eq.${args.slug}`,
    status: 'in.(active,superseded)',
    limit: 1,
  })
  if (!row) throw new NotFoundError(`decision ${args.slug} not found`)
  return {
    slug: row.slug,
    title: row.title,
    status: row.status,
    context: row.context,
    decision: row.decision,
    rationale: row.rationale,
    alternatives: Array.isArray(row.alternatives) ? row.alternatives : [],
    agent_meta: row.agent_meta ?? {},
    created_at: isoString(row.created_at),
  }
}
