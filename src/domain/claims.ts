// wk_claims / wk_citations — verifiable statements with provenance
// (CONTRACTS §1.5, §1.6, §4).
//
// The claim model is the subject-predicate-object "frame": two claims with
// the SAME (subject, predicate) but a DIFFERENT object are an exact-frame
// contradiction. v0.1 is deliberately deterministic — no fuzzy/semantic
// matching (plan §15.2: "lives in" vs "residence is" does not collide; the
// mitigation is the controlled predicate vocabulary per space, fuzzy matching
// via embeddings is v0.2). findContradictions is the SAME matcher
// wk_apply_proposal applies at approval time, run early so the proposal diff
// and the proposal.created webhook can announce disputes before review.
import { z } from 'zod'
import type { Db } from '../db/postgres.ts'
import { normalizeObject, type PredicateDef } from './normalize.ts'

export type ClaimStatus = 'proposed' | 'draft' | 'verified' | 'disputed' | 'deprecated'

/**
 * What readers ever see (CONTRACTS §9.3): verified/disputed/deprecated.
 * proposed and draft are staging states — invisible everywhere outside the
 * proposal diff.
 */
export const VISIBLE_CLAIM_STATUSES = ['verified', 'disputed', 'deprecated'] as const

export interface ClaimTriple {
  subject: string
  predicate: string
  object: string
}

export const zClaimTriple = z.object({
  subject: z.string().min(1).max(500),
  predicate: z.string().min(1).max(200),
  object: z.string().min(1).max(2000),
})

export interface Citation {
  source_id: string
  quote: string
  locator: string
}

export interface ClaimWithCitations extends ClaimTriple {
  id: string
  status: ClaimStatus
  confidence: number
  valid_from: string | null
  valid_until: string | null
  created_at: string
  agent_meta: Record<string, unknown>
  citations: Citation[]
}

interface ClaimRow extends ClaimTriple {
  id: string
  status: ClaimStatus
  confidence: number
  valid_from: Date | string | null
  valid_until: Date | string | null
  created_at: Date | string
  agent_meta: Record<string, unknown>
}

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : String(value)

/**
 * Claims of one concept with their citations. Defaults to the reader-visible
 * statuses; callers that need staging content (the proposal diff) pass
 * statuses explicitly — visibility is opt-out by construction, never opt-in.
 */
export async function listClaimsForConcept(
  db: Db,
  spaceId: string,
  args: { conceptId: string; statuses?: ClaimStatus[] },
): Promise<ClaimWithCitations[]> {
  const statuses = args.statuses?.length ? args.statuses : [...VISIBLE_CLAIM_STATUSES]
  const claims = await db.select<ClaimRow>('wk_claims', {
    space_id: `eq.${spaceId}`,
    concept_id: `eq.${args.conceptId}`,
    status: `in.(${statuses.join(',')})`,
    order: 'created_at.asc',
  })
  if (!claims.length) return []

  // One batched citations query instead of N — citations are per-claim
  // provenance and every read that shows a claim must show its sources.
  const citations = await db.select<{ claim_id: string; source_id: string; quote: string; locator: string }>(
    'wk_citations',
    { claim_id: `in.(${claims.map((claim) => claim.id).join(',')})`, order: 'created_at.asc' },
  )
  const byClaim = new Map<string, Citation[]>()
  for (const citation of citations) {
    const list = byClaim.get(citation.claim_id) ?? []
    list.push({ source_id: citation.source_id, quote: citation.quote, locator: citation.locator })
    byClaim.set(citation.claim_id, list)
  }

  return claims.map((claim) => ({
    id: claim.id,
    subject: claim.subject,
    predicate: claim.predicate,
    object: claim.object,
    status: claim.status,
    confidence: claim.confidence,
    valid_from: iso(claim.valid_from),
    valid_until: iso(claim.valid_until),
    created_at: iso(claim.created_at)!,
    agent_meta: claim.agent_meta ?? {},
    citations: byClaim.get(claim.id) ?? [],
  }))
}

export interface ContradictionPair {
  subject: string
  predicate: string
  /** The incoming claim's object. */
  proposed_object: string
  /** The colliding object (existing row, or another incoming claim). */
  existing_object: string
  /** NULL when the collision is between two incoming claims (intra-batch). */
  existing_claim_id: string | null
  existing_concept_id: string | null
  existing_status: ClaimStatus | null
  /** First citation quote of the existing claim — adjudication evidence. */
  existing_quote: string | null
}

/** Incoming claim shape for the matcher: the triple plus 0021 semantics. */
export interface IncomingClaim extends ClaimTriple {
  context?: string | null
  valid_from?: string | null
  valid_until?: string | null
}

// Interval overlap with open ends: null = ±infinity. Disjoint validity is
// SUCCESSION ("galt zu einem anderen Zeitpunkt"), never a contradiction.
function intervalsOverlap(
  aFrom: string | null | undefined,
  aUntil: string | null | undefined,
  bFrom: string | null | undefined,
  bUntil: string | null | undefined,
): boolean {
  const from = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NEGATIVE_INFINITY)
  const until = (value: string | null | undefined) => (value ? Date.parse(value) : Number.POSITIVE_INFINITY)
  return from(aFrom) < until(bUntil) && from(bFrom) < until(aUntil)
}

/**
 * Functional predicates are a space-level semantic contract. An undeclared
 * predicate is multi-valued: different objects are complementary facts, not
 * automatically a contradiction. Empty-by-default is deliberate because
 * names such as `is`, `has_status`, and `part_of` are domain-dependent.
 */
export async function getFunctionalPredicates(db: Db, spaceId: string): Promise<string[]> {
  const [space] = await db.select<{ settings: Record<string, unknown> }>('wk_spaces', {
    id: `eq.${spaceId}`,
    limit: 1,
  })
  const names = new Set<string>()
  const legacy = space?.settings?.['functional_predicates']
  if (Array.isArray(legacy)) {
    for (const value of legacy) if (typeof value === 'string' && value.length > 0) names.add(value)
  }
  // The typed registry (0021) is consulted too — mirrors wk_functional_predicates v2.
  for (const def of readPredicateDefs(space?.settings)) if (def.functional) names.add(def.name)
  return [...names]
}

/** Loose reader over settings.predicate_defs — malformed entries are skipped, never fatal. */
function readPredicateDefs(settings: Record<string, unknown> | undefined): PredicateDef[] {
  const raw = settings?.['predicate_defs']
  if (!Array.isArray(raw)) return []
  const defs: PredicateDef[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.name !== 'string' || !candidate.name) continue
    const type = candidate.type
    defs.push({
      name: candidate.name,
      type:
        type === 'number' || type === 'quantity' || type === 'date' || type === 'enum' || type === 'reference'
          ? type
          : 'string',
      functional: candidate.functional === true,
      unit:
        typeof candidate.unit === 'object' && candidate.unit !== null
          ? (candidate.unit as PredicateDef['unit'])
          : undefined,
      enum_values: Array.isArray(candidate.enum_values)
        ? candidate.enum_values.filter((value): value is string => typeof value === 'string')
        : undefined,
    })
  }
  return defs
}

/** The typed predicate registry (settings.predicate_defs) keyed by name. */
export async function getPredicateRegistry(db: Db, spaceId: string): Promise<Map<string, PredicateDef>> {
  const [space] = await db.select<{ settings: Record<string, unknown> }>('wk_spaces', {
    id: `eq.${spaceId}`,
    limit: 1,
  })
  return new Map(readPredicateDefs(space?.settings).map((def) => [def.name, def]))
}

/**
 * Semantic contradiction CANDIDATES — the embeddings-backed fuzzy layer.
 * Interface fixed now, implementation lands with the hybrid ranker: candidate
 * pairs surface as proposal WARNINGS only, never auto-disputes (the
 * deterministic frame matcher stays the only dispute authority).
 */
export async function findContradictionCandidates(
  _db: Db,
  _spaceId: string,
  _args: { claims: ClaimTriple[] },
): Promise<ContradictionPair[]> {
  return []
}

/**
 * Deterministic exact-frame contradiction matcher: for each incoming triple,
 * find (a) persisted claims in the space with the same (subject, predicate)
 * but a different object, and (b) collisions among the incoming triples
 * themselves (a source can contradict itself).
 *
 * WHY only verified/disputed on the persisted side: deprecated claims are
 * retired knowledge — contradicting them is the EXPECTED way knowledge moves
 * on, not a dispute. This mirrors wk_apply_proposal's flip-5 filter exactly,
 * so the pre-review diff never announces a dispute the approval would not
 * actually create.
 */
export async function findContradictions(
  db: Db,
  spaceId: string,
  args: { claims: IncomingClaim[] },
): Promise<ContradictionPair[]> {
  const incoming = z
    .array(
      zClaimTriple.extend({
        context: z.string().max(200).nullable().optional(),
        valid_from: z.string().nullable().optional(),
        valid_until: z.string().nullable().optional(),
      }),
    )
    .parse(args.claims)
  if (!incoming.length) return []

  const functional = new Set(await getFunctionalPredicates(db, spaceId))
  const relevant = incoming.filter((claim) => functional.has(claim.predicate))
  if (!relevant.length) return []

  // 0021 semantics: comparison happens on the NORMALIZED object within one
  // context partition, and only for OVERLAPPING validity — mirroring the
  // apply-time flip 5 exactly, so the pre-review diff never announces a
  // dispute the approval would not create.
  const registry = await getPredicateRegistry(db, spaceId)
  const norm = (predicate: string, object: string) => normalizeObject(registry.get(predicate), object).normalized

  const pairs: ContradictionPair[] = []

  // Intra-batch collisions first (no SQL needed).
  for (let i = 0; i < relevant.length; i++) {
    for (let j = i + 1; j < relevant.length; j++) {
      const a = relevant[i]!
      const b = relevant[j]!
      if (
        a.subject === b.subject &&
        a.predicate === b.predicate &&
        (a.context ?? '') === (b.context ?? '') &&
        norm(a.predicate, a.object) !== norm(b.predicate, b.object) &&
        intervalsOverlap(a.valid_from, a.valid_until, b.valid_from, b.valid_until)
      ) {
        pairs.push({
          subject: a.subject,
          predicate: a.predicate,
          proposed_object: b.object,
          existing_object: a.object,
          existing_claim_id: null,
          existing_concept_id: null,
          existing_status: null,
          existing_quote: null,
        })
      }
    }
  }

  // Persisted collisions in ONE query: frame tuples as parallel arrays
  // unpacked via unnest, joined against the (space_id, subject, predicate)
  // index. Space-scoped like every query in this module. The first citation
  // quote rides along as adjudication evidence.
  const frames = [
    ...new Map(relevant.map((claim) => [JSON.stringify([claim.subject, claim.predicate]), claim])).values(),
  ]
  const { rows } = await db.query<{
    id: string
    concept_id: string
    subject: string
    predicate: string
    object: string
    object_normalized: string | null
    context: string | null
    valid_from: Date | string | null
    valid_until: Date | string | null
    status: ClaimStatus
    quote: string | null
  }>(
    `SELECT cl.id, cl.concept_id, cl.subject, cl.predicate, cl.object, cl.object_normalized,
            cl.context, cl.valid_from, cl.valid_until, cl.status,
            (SELECT ci.quote FROM wk_citations ci WHERE ci.claim_id = cl.id ORDER BY ci.created_at ASC LIMIT 1) AS quote
       FROM wk_claims cl
       JOIN unnest($2::text[], $3::text[]) AS frame(subject, predicate)
         ON frame.subject = cl.subject AND frame.predicate = cl.predicate
      WHERE cl.space_id = $1
        AND cl.status IN ('verified', 'disputed')`,
    [spaceId, frames.map((frame) => frame.subject), frames.map((frame) => frame.predicate)],
  )

  for (const claim of relevant) {
    for (const existing of rows) {
      if (
        existing.subject === claim.subject &&
        existing.predicate === claim.predicate &&
        (existing.context ?? '') === (claim.context ?? '') &&
        (existing.object_normalized ?? existing.object) !== norm(claim.predicate, claim.object) &&
        intervalsOverlap(claim.valid_from, claim.valid_until, iso(existing.valid_from), iso(existing.valid_until))
      ) {
        pairs.push({
          subject: claim.subject,
          predicate: claim.predicate,
          proposed_object: claim.object,
          existing_object: existing.object,
          existing_claim_id: existing.id,
          existing_concept_id: existing.concept_id,
          existing_status: existing.status,
          existing_quote: existing.quote ?? null,
        })
      }
    }
  }

  return pairs
}
