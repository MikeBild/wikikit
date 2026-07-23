// wk_change_proposals — the review gate (CONTRACTS §1.9, §4, §9.2).
//
// The central pattern (atomic apply via wk_apply_proposal): a proposal's
// CONTENT is real rows in the target tables with status='proposed' +
// proposal_id — never a JSON diff blob. createProposal is the ONLY staging
// write, used identically by ingest, import and manual POST .../proposals.
// Approve/reject are thin wrappers around the whitelisted SQL functions —
// TypeScript never flips a knowledge-row status itself, so the
// atomicity/locking discipline lives in exactly one place (the migration). The
// single sanctioned exception is the §9.2 stale_base handling: apply raises,
// the SQL has rolled back, and the CALLER marks the proposal 'failed' (see
// approveProposal).
//
// Idempotency: input_hash (sha256 over ordered source hashes + prompt
// version) + the partial unique index on (space_id, input_hash) WHERE
// status='pending' make retried ingests converge on the SAME pending proposal
// instead of stacking review work.
import { z } from 'zod'
import type { Db } from '../db/postgres.ts'
import {
  findContradictions,
  getPredicateRegistry,
  zClaimTriple,
  type ClaimStatus,
  type ClaimTriple,
  type IncomingClaim,
} from './claims.ts'
import { normalizeObject, resolveAlias } from './normalize.ts'
import { parseQualifiedSlug, readImports, QUALIFIED_SLUG_PATTERN } from './space-refs.ts'
import { ConflictError, NotFoundError, ValidationError } from './errors.ts'
import { RELATION_KINDS, type RelationKind } from './relations.ts'
import { clampLimit, isoString, resolveChunkCitation, sha256Hex } from './sources.ts'

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'failed' | 'split'
export const REVIEW_CHANNELS = ['rest', 'mcp_elicitation'] as const
export type ReviewChannel = (typeof REVIEW_CHANNELS)[number]

export interface ProposalSummary {
  id: string
  status: ProposalStatus
  title: string
  summary: string
  created_at: string
  reviewer: string | null
  review_channel: ReviewChannel | null
  reviewed_at: string | null
  /** Terminal reject that explicitly asks for a revised re-proposal (0020). */
  changes_requested: boolean
  /** Set on children created by wk_split_proposal. */
  parent_proposal_id: string | null
}

/** One staged claim with its provenance, as the review surfaces need it. */
export interface ClaimDiff extends ClaimTriple {
  status: ClaimStatus
  confidence: number
  /** Pending only: exact-frame collision with an existing visible claim. */
  collides: boolean
  citations: { source_id: string; quote: string; locator: string; source_title: string | null }[]
}

/** Per-concept structured diff — the shape of zProposalDetailResponse.concepts. */
export interface ConceptDiff {
  slug: string
  is_new: boolean
  old_markdown: string | null
  new_markdown: string
  /**
   * Pending only: the concept's current revision moved past this proposal's
   * base_revision_id — approval WILL fail with stale_base. Surfaced so the
   * review page can explain the remedy (re-ingest) instead of a blind 409.
   */
  stale: boolean
  claims_added: ClaimTriple[]
  claims_disputed: ClaimTriple[]
  claims_deprecated: ClaimTriple[]
  /** Full staged claims with citations (quote + source title) — additive to the triple groups above. */
  claims: ClaimDiff[]
  relations_added: { to_slug: string; kind: string }[]
}

/** One staged decision as exposed in the human review diff. */
export interface DecisionDiff {
  slug: string
  title: string
  context: string
  decision: string
  rationale: string
  alternatives: unknown[]
}

export interface ProposalDetail {
  id: string
  /** Space slug — what the wire shape carries. */
  space: string
  /** Space id — the transport enforces key/space match on this (⚠ global-id lookup). */
  space_id: string
  status: ProposalStatus
  title: string
  summary: string
  created_at: string
  reviewer: string | null
  review_note: string | null
  review_channel: ReviewChannel | null
  reviewed_at: string | null
  source_ids: string[]
  agent_meta: Record<string, unknown>
  changes_requested: boolean
  parent_proposal_id: string | null
  /** Resolved source rows for source_ids ∪ cited sources — replaces bare-uuid review UX. */
  sources: { id: string; title: string | null; url: string | null; kind: string; created_at: string }[]
  concepts: ConceptDiff[]
  decisions: DecisionDiff[]
  /**
   * Edge-level removals staged by this proposal (wk_relations rows carrying
   * removal_proposal_id = this proposal). Top-level, not per-concept: a
   * removal-only proposal has no concept entries at all. The marker survives
   * approve AND reject, so terminal proposals keep their full diff.
   */
  relations_removed: { from_slug: string; to_slug: string; kind: string }[]
}

/** Public REST/MCP shape; space_id is only an authorization handle. */
export type ProposalWireDetail = Omit<ProposalDetail, 'space_id'>

export interface ApplyResult {
  proposal_id: string
  status: 'approved'
  concepts: string[]
  claims_verified: number
  claims_disputed: number
  /** Claims deprecated by explicit supersession (flip 5c, 0022). */
  claims_deprecated: number
  /** Active relations deactivated by this approval (Flip 6b row count). */
  relations_removed: number
  review_channel: ReviewChannel
}

export interface RejectResult {
  proposal_id: string
  status: 'rejected'
  review_channel: ReviewChannel
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,126}$/

/**
 * The staging-write schema, exported so HTTP (zCreateProposalRequest) and the
 * wikikit_propose MCP tool validate the SAME shape (zod-first, one source of
 * truth). agent_meta is required by contract — 'manual' rows carry
 * {model:'manual', prompt_version:'manual'} (§1.14).
 */
export const zCreateProposalArgs = z
  .object({
    title: z.string().min(1).max(500),
    summary: z.string().max(4000).default(''),
    input_hash: z.string().regex(/^[0-9a-f]{64}$/, 'input_hash must be a sha256 hex digest'),
    source_ids: z.array(z.uuid()).default([]),
    agent_meta: z.record(z.string(), z.unknown()).default({}),
    concepts: z
      .array(
        z.object({
          slug: z.string().regex(SLUG_PATTERN),
          title: z.string().min(1).max(500),
          summary: z.string().max(4000).default(''),
          markdown: z.string().min(1),
          /**
           * The revision this content was SYNTHESIZED against (stale-base
           * anchor, §1.9): null = explicitly "written against no revision"
           * (new concept), absent = fall back to the concept's current
           * pointer at staging time (manual proposals, where authoring and
           * staging are the same moment). The ingest pipeline passes the id
           * it actually read before its LLM calls — capturing the pointer at
           * staging time instead would let a concurrent approval slip inside
           * the synthesis window and defeat the very check the anchor exists
           * for (lost-update TOCTOU).
           */
          base_revision_id: z.uuid().nullable().optional(),
          claims: z
            .array(
              zClaimTriple.extend({
                confidence: z.number().min(0).max(1).default(0.5),
                // 0021 semantics — all optional and additive. Validity is only
                // recorded when the SOURCE states it; context partitions the
                // frame ('region:eu', 'v2.x'); supersedes_claim_id stages a
                // deterministic succession the reviewer sees and approval
                // executes (deprecate the target, flip 5c).
                valid_from: z.iso.datetime().nullable().optional(),
                valid_until: z.iso.datetime().nullable().optional(),
                context: z.string().min(1).max(200).nullable().optional(),
                supersedes_claim_id: z.uuid().nullable().optional(),
                // Adjudication verdict stamped by the pipeline (never
                // caller-meaningful beyond audit): 'complementary' exempts
                // this claim from the apply-time dispute flip.
                adjudication: z.enum(['contradictory', 'temporal', 'complementary']).optional(),
                citations: z
                  .array(
                    z.union([
                      z.object({
                        source_id: z.uuid(),
                        quote: z.string().min(1),
                        locator: z.string().max(500).default(''),
                      }),
                      // Source-chunk citation (propose-from-evidence): the
                      // chunk id resolves to its canonical {source_id, quote}
                      // at staging time — chunk content IS a verbatim slice
                      // of the archived source, so the quote contract holds
                      // by construction.
                      z.object({
                        chunk_id: z.uuid(),
                        locator: z.string().max(500).default(''),
                      }),
                    ]),
                  )
                  .default([]),
              }),
            )
            .default([]),
          relations: z
            .array(
              z.object({
                // Plain slug or 'other-space:slug' (0023) — qualified targets
                // must exist in a DECLARED import of this space.
                to_slug: z.string().regex(QUALIFIED_SLUG_PATTERN),
                kind: z.enum(RELATION_KINDS),
              }),
            )
            .default([]),
        }),
      )
      .default([]),
    decisions: z
      .array(
        z.object({
          slug: z.string().regex(SLUG_PATTERN),
          title: z.string().min(1).max(500),
          context: z.string().min(1),
          decision: z.string().min(1),
          rationale: z.string().default(''),
          alternatives: z.array(z.unknown()).default([]),
        }),
      )
      .default([]),
    /**
     * Removals of EXISTING active relations. Top-level (not per-concept) on
     * purpose: a removal is edge-level and must not force a fake revision
     * through concepts[].markdown min(1) — a removal-only proposal is valid.
     */
    relations_removed: z
      .array(
        z.object({
          from_slug: z.string().regex(SLUG_PATTERN),
          to_slug: z.string().regex(SLUG_PATTERN),
          kind: z.enum(RELATION_KINDS),
        }),
      )
      .default([]),
  })
  .refine((value) => value.concepts.length > 0 || value.decisions.length > 0 || value.relations_removed.length > 0, {
    message: 'a proposal must stage at least one concept, decision or relation removal',
  })
  // Duplicate slugs would stage two proposed revisions (rev N and N+1) for
  // one concept; on approval BOTH flip to 'current' and the concept pointer
  // lands on an arbitrary one — permanently breaking the one-current-revision
  // invariant. The import path dedups first-wins before calling; the boundary
  // schema must refuse what import has to work around.
  .refine((value) => new Set(value.concepts.map((concept) => concept.slug)).size === value.concepts.length, {
    message: 'concepts[].slug must be unique within a proposal',
  })
  .refine((value) => new Set(value.decisions.map((decision) => decision.slug)).size === value.decisions.length, {
    message: 'decisions[].slug must be unique within a proposal',
  })
  .refine(
    (value) =>
      new Set(value.relations_removed.map((edge) => `${edge.from_slug}\n${edge.to_slug}\n${edge.kind}`)).size ===
      value.relations_removed.length,
    { message: 'relations_removed entries must be unique within a proposal' },
  )
  // Adding and removing the SAME edge in one proposal is contradictory: the
  // add re-adopts the row while the removal marks it — approval order inside
  // the apply function would decide the outcome. Refuse at the boundary.
  .refine(
    (value) => {
      const removed = new Set(value.relations_removed.map((edge) => `${edge.from_slug}\n${edge.to_slug}\n${edge.kind}`))
      return !value.concepts.some((concept) =>
        concept.relations.some((relation) => removed.has(`${concept.slug}\n${relation.to_slug}\n${relation.kind}`)),
      )
    },
    { message: 'a relation cannot be both added and removed in the same proposal' },
  )

export type CreateProposalArgs = z.input<typeof zCreateProposalArgs>

/**
 * The dedup anchor (§1.9): sha256 over the ORDERED source hashes plus the
 * prompt version. Sorted so hash equality is set equality — the same sources
 * ingested in a different order are the same knowledge.
 */
export function computeInputHash(sourceHashes: string[], promptVersion: string): string {
  return sha256Hex([...sourceHashes].sort().join('\n') + '\n' + promptVersion)
}

export async function listProposals(
  db: Db,
  spaceId: string,
  args: { status?: ProposalStatus; limit?: number } = {},
): Promise<ProposalSummary[]> {
  const limit = clampLimit(args.limit, 50, 200)
  const rows = await db.select<{
    id: string
    status: ProposalStatus
    title: string
    summary: string
    created_at: Date | string
    reviewer: string | null
    review_channel: ReviewChannel | null
    reviewed_at: Date | string | null
    changes_requested: boolean
    parent_proposal_id: string | null
  }>('wk_change_proposals', {
    space_id: `eq.${spaceId}`,
    ...(args.status ? { status: `eq.${args.status}` } : {}),
    order: 'created_at.desc',
    limit,
  })
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    title: row.title,
    summary: row.summary,
    created_at: isoString(row.created_at),
    reviewer: row.reviewer,
    review_channel: row.review_channel,
    reviewed_at: row.reviewed_at === null ? null : isoString(row.reviewed_at),
    changes_requested: row.changes_requested === true,
    parent_proposal_id: row.parent_proposal_id ?? null,
  }))
}

// Get-or-create a concept identity row and LOCK it. The lock serializes rev
// numbering: two concurrent proposals touching the same concept compute
// max(rev)+1 one after the other instead of colliding on unique(concept_id,
// rev). Creation races resolve through ON CONFLICT DO NOTHING + re-select
// (the second tx blocks on the unique index until the first commits).
async function lockOrCreateConcept(
  tx: Db,
  spaceId: string,
  slug: string,
  title: string,
): Promise<{ id: string; current_revision_id: string | null }> {
  type ConceptRow = { id: string; current_revision_id: string | null }
  const locked = await tx.query<ConceptRow>(
    'SELECT id, current_revision_id FROM wk_concepts WHERE space_id = $1 AND slug = $2 FOR UPDATE',
    [spaceId, slug],
  )
  if (locked.rows[0]) return locked.rows[0]
  const inserted = await tx.query<ConceptRow>(
    `INSERT INTO wk_concepts (space_id, slug, title)
     VALUES ($1, $2, $3)
     ON CONFLICT (space_id, slug) DO NOTHING
     RETURNING id, current_revision_id`,
    [spaceId, slug, title],
  )
  if (inserted.rows[0]) return inserted.rows[0]
  const retried = await tx.query<ConceptRow>(
    'SELECT id, current_revision_id FROM wk_concepts WHERE space_id = $1 AND slug = $2 FOR UPDATE',
    [spaceId, slug],
  )
  if (!retried.rows[0]) throw new Error(`concept ${slug} vanished during staging`)
  return retried.rows[0]
}

/**
 * Stage a ChangeProposal: proposal row + proposed revisions/claims/citations/
 * relations/decisions + the proposal.created outbox event — ONE transaction
 * (§4 CreateProposalArgs contract). Returns the existing pending proposal on
 * an input_hash hit (idempotent convergence, no duplicate review work).
 */
export async function createProposal(
  db: Db,
  spaceId: string,
  args: CreateProposalArgs,
): Promise<{ proposal_id: string; status: 'pending' }> {
  const input = zCreateProposalArgs.parse(args)
  // The documented input_hash recipe (sorted source hashes + prompt version)
  // carries ZERO entropy for a sourceless removal-only proposal — every such
  // proposal built per the recipe hashes identically, and the pending-dedup
  // fast path would silently swallow a DIFFERENT removal set as "the same
  // knowledge". Salt the effective hash with the canonical removal set:
  // identical retries still converge (deterministic), different removal sets
  // stage as distinct proposals.
  const inputHash = input.relations_removed.length
    ? sha256Hex(
        `${input.input_hash}\n${input.relations_removed
          .map((edge) => `${edge.from_slug}\t${edge.to_slug}\t${edge.kind}`)
          .sort()
          .join('\n')}`,
      )
    : input.input_hash

  try {
    return await db.tx(async (tx) => {
      const [space] = await tx.select<{ slug: string }>('wk_spaces', { id: `eq.${spaceId}`, limit: 1 })
      if (!space) throw new NotFoundError('space not found')

      // Dedup fast path INSIDE the tx: the partial unique index is still the
      // authority (the catch below handles the race), this just avoids
      // staging rows that would be rolled back.
      const [pending] = await tx.select<{ id: string }>('wk_change_proposals', {
        space_id: `eq.${spaceId}`,
        input_hash: `eq.${inputHash}`,
        status: 'eq.pending',
        limit: 1,
      })
      if (pending) return { proposal_id: pending.id, status: 'pending' as const }

      // Chunk citations resolve FIRST: {chunk_id} → the chunk's canonical
      // {source_id, quote}. The lookup is space-scoped, so a foreign or
      // nonexistent chunk id fails as a 400 before anything is staged; the
      // locator records the chunk for provenance when the caller gave none.
      for (const entry of input.concepts) {
        for (const claim of entry.claims) {
          claim.citations = await Promise.all(
            claim.citations.map(async (citation) => {
              if (!('chunk_id' in citation)) return citation
              try {
                const resolved = await resolveChunkCitation(tx, spaceId, citation.chunk_id)
                return {
                  source_id: resolved.source_id,
                  quote: resolved.quote,
                  locator: citation.locator || `chunk:${citation.chunk_id}`,
                }
              } catch (error) {
                if (error instanceof NotFoundError) {
                  throw new ValidationError(`source chunk not found in this space: ${citation.chunk_id}`)
                }
                throw error
              }
            }),
          )
        }
      }

      // Space-ownership check on every referenced source id (proposal-level
      // source_ids AND per-citation source_ids): 'no wk_ row access without
      // space_id' applies to the row a citation POINTS AT too. Without this a
      // knowledge:propose key could pin citations to another tenant's sources
      // (cross-tenant provenance corruption — and wk_citations.source_id is
      // ON DELETE RESTRICT, so a foreign citation would even block deleting
      // the other tenant's space). A nonexistent id becomes a 400 here
      // instead of a raw 23503 → 500 at the FK.
      const referencedSourceIds = [
        ...new Set([
          ...input.source_ids,
          ...input.concepts.flatMap((entry) =>
            entry.claims.flatMap((claim) =>
              claim.citations.flatMap((citation) => ('source_id' in citation ? [citation.source_id] : [])),
            ),
          ),
        ]),
      ]
      if (referencedSourceIds.length) {
        const known = await tx.query<{ id: string }>(
          'SELECT id FROM wk_sources WHERE space_id = $1 AND id = ANY($2::uuid[])',
          [spaceId, referencedSourceIds],
        )
        const visible = new Set(known.rows.map((row) => row.id))
        const missing = referencedSourceIds.filter((id) => !visible.has(id))
        if (missing.length) {
          throw new ValidationError(`source id(s) not found in this space: ${missing.join(', ')}`)
        }
      }

      const [proposal] = await tx.insert<{ id: string }>('wk_change_proposals', {
        space_id: spaceId,
        title: input.title,
        summary: input.summary,
        input_hash: inputHash,
        source_ids: input.source_ids,
        agent_meta: JSON.stringify(input.agent_meta),
      })
      const proposalId = proposal!.id

      // 0021 semantics, resolved ONCE per staging: the alias map canonicalizes
      // claim subjects (stored claims are always canonical — apply/lint/frame
      // index need zero alias awareness) and the predicate registry drives the
      // server-side object normalization (never caller-supplied).
      const [settingsRow] = await tx.select<{ settings: Record<string, unknown> }>('wk_spaces', {
        id: `eq.${spaceId}`,
        limit: 1,
      })
      const aliases =
        typeof settingsRow?.settings?.['aliases'] === 'object' && settingsRow.settings['aliases'] !== null
          ? (settingsRow.settings['aliases'] as Record<string, unknown>)
          : undefined
      const registry = await getPredicateRegistry(tx, spaceId)

      // Cross-space relation targets (0023): must name a space DECLARED in
      // settings.imports and an EXISTING, reader-visible concept there.
      // Resolution only — never creation: no cross-space writes, ever.
      const imports = new Set(readImports(settingsRow?.settings))
      const foreignTargets = new Map<string, { id: string; space_id: string }>()
      for (const entry of input.concepts) {
        for (const relation of entry.relations) {
          const parsed = parseQualifiedSlug(relation.to_slug)
          if (!parsed?.space || foreignTargets.has(relation.to_slug)) continue
          if (!imports.has(parsed.space)) {
            throw new ValidationError(
              `space '${parsed.space}' is not declared in settings.imports of this space — cross-space relations require a declared import`,
            )
          }
          const { rows: found } = await tx.query<{ id: string; space_id: string }>(
            `SELECT c.id, c.space_id
               FROM wk_concepts c
               JOIN wk_spaces s ON s.id = c.space_id
              WHERE s.slug = $1 AND c.slug = $2 AND c.current_revision_id IS NOT NULL`,
            [parsed.space, parsed.slug],
          )
          if (!found[0]) {
            throw new ValidationError(
              `cross-space relation target '${relation.to_slug}' does not exist as a readable concept`,
            )
          }
          foreignTargets.set(relation.to_slug, found[0])
        }
      }

      // Space-ownership check for supersedes targets: succession may only
      // deprecate a VISIBLE claim of this space.
      const supersedeIds = [
        ...new Set(
          input.concepts.flatMap((entry) =>
            entry.claims.flatMap((claim) => (claim.supersedes_claim_id ? [claim.supersedes_claim_id] : [])),
          ),
        ),
      ]
      if (supersedeIds.length) {
        const known = await tx.query<{ id: string }>(
          `SELECT id FROM wk_claims
            WHERE space_id = $1 AND id = ANY($2::uuid[]) AND status IN ('verified', 'disputed')`,
          [spaceId, supersedeIds],
        )
        const visible = new Set(known.rows.map((row) => row.id))
        const missing = supersedeIds.filter((id) => !visible.has(id))
        if (missing.length) {
          throw new ValidationError(
            `supersedes_claim_id(s) not found as visible claims in this space: ${missing.join(', ')}`,
          )
        }
      }

      const allTriples: IncomingClaim[] = []
      const conceptSlugs: string[] = []
      let claimsCount = 0

      // Lock EVERY involved concept (staged concepts + relation targets) in
      // one sorted pass BEFORE staging: two concurrent proposals over
      // overlapping concept sets then acquire their FOR UPDATE locks in the
      // same order and serialize instead of deadlocking (40P01 → 500).
      // Residual: wk_apply_proposal locks in id order while this locks in
      // slug order, so a create racing an approve can still theoretically
      // deadlock — Postgres resolves it by aborting one, and the staging
      // retry converges via the input_hash dedup.
      const titleBySlug = new Map<string, string>()
      for (const entry of input.concepts) {
        for (const relation of entry.relations) {
          // Qualified targets never join the local lock/create pass — no
          // cross-space writes means no foreign lock ordering problem, and a
          // foreign placeholder concept must never be invented.
          if (parseQualifiedSlug(relation.to_slug)?.space) continue
          if (relation.to_slug !== entry.slug && !titleBySlug.has(relation.to_slug)) {
            titleBySlug.set(relation.to_slug, relation.to_slug)
          }
        }
      }
      for (const entry of input.concepts) titleBySlug.set(entry.slug, entry.title)
      // Removal endpoints join the SAME sorted lock pass, but lock-only: a
      // removal must never auto-create a concept — a typo'd slug is a 400,
      // not a fresh empty concept.
      const removalOnlySlugs = new Set<string>()
      for (const edge of input.relations_removed) {
        for (const slug of [edge.from_slug, edge.to_slug]) {
          if (!titleBySlug.has(slug)) removalOnlySlugs.add(slug)
        }
      }
      const conceptBySlug = new Map<string, { id: string; current_revision_id: string | null }>()
      for (const slug of [...new Set([...titleBySlug.keys(), ...removalOnlySlugs])].sort()) {
        if (removalOnlySlugs.has(slug)) {
          const locked = await tx.query<{ id: string; current_revision_id: string | null }>(
            'SELECT id, current_revision_id FROM wk_concepts WHERE space_id = $1 AND slug = $2 FOR UPDATE',
            [spaceId, slug],
          )
          if (!locked.rows[0]) throw new ValidationError(`concept not found: ${slug}`)
          conceptBySlug.set(slug, locked.rows[0])
        } else {
          conceptBySlug.set(slug, await lockOrCreateConcept(tx, spaceId, slug, titleBySlug.get(slug)!))
        }
      }

      for (const entry of input.concepts) {
        conceptSlugs.push(entry.slug)
        const concept = conceptBySlug.get(entry.slug)!

        // Safe under the concept row lock taken above — no two transactions
        // compute the same next rev for one concept.
        const nextRev = await tx.query<{ next: number }>(
          'SELECT COALESCE(MAX(rev), 0) + 1 AS next FROM wk_concept_revisions WHERE concept_id = $1',
          [concept.id],
        )
        await tx.insert(
          'wk_concept_revisions',
          {
            space_id: spaceId,
            concept_id: concept.id,
            rev: Number(nextRev.rows[0]!.next),
            status: 'proposed',
            title: entry.title,
            summary: entry.summary,
            markdown: entry.markdown,
            // The stale-base anchor: what this revision was synthesized
            // against. Callers that synthesized EARLIER (the ingest pipeline,
            // whose LLM calls take seconds-to-minutes) pass the id they
            // actually read; the staging-time pointer is only the fallback
            // for manual proposals where authoring and staging coincide.
            // wk_apply_proposal fails the approve if the pointer moved.
            base_revision_id:
              entry.base_revision_id !== undefined ? entry.base_revision_id : concept.current_revision_id,
            agent_meta: JSON.stringify(input.agent_meta),
            proposal_id: proposalId,
          },
          { returning: false },
        )

        for (const claim of entry.claims) {
          claimsCount += 1
          const subject = resolveAlias(aliases, claim.subject)
          const normalized = normalizeObject(registry.get(claim.predicate), claim.object)
          allTriples.push({
            subject,
            predicate: claim.predicate,
            object: claim.object,
            context: claim.context ?? null,
            valid_from: claim.valid_from ?? null,
            valid_until: claim.valid_until ?? null,
          })
          const [claimRow] = await tx.insert<{ id: string }>('wk_claims', {
            space_id: spaceId,
            concept_id: concept.id,
            subject,
            predicate: claim.predicate,
            object: claim.object,
            object_normalized: normalized.normalized,
            object_value_num: normalized.valueNum,
            object_unit: normalized.unit,
            context: claim.context ?? null,
            valid_from: claim.valid_from ?? null,
            valid_until: claim.valid_until ?? null,
            supersedes_claim_id: claim.supersedes_claim_id ?? null,
            status: 'proposed',
            confidence: claim.confidence,
            agent_meta: JSON.stringify(
              claim.adjudication ? { ...input.agent_meta, adjudication: claim.adjudication } : input.agent_meta,
            ),
            proposal_id: proposalId,
          })
          if (claim.citations.length) {
            await tx.insert(
              'wk_citations',
              claim.citations.map((citation) => {
                // Chunk citations were resolved to source_id/quote above —
                // this narrowing is a type-level formality, not a runtime path.
                if (!('source_id' in citation)) {
                  throw new Error(`unresolved chunk citation: ${citation.chunk_id}`)
                }
                return {
                  space_id: spaceId,
                  claim_id: claimRow!.id,
                  source_id: citation.source_id,
                  quote: citation.quote,
                  locator: citation.locator,
                }
              }),
              { returning: false },
            )
          }
        }

        for (const relation of entry.relations) {
          if (relation.to_slug === entry.slug) continue // self-relations are noise, drop silently
          const foreign = foreignTargets.get(relation.to_slug)
          const target = foreign ?? conceptBySlug.get(relation.to_slug)!
          const targetSpaceId = foreign ? foreign.space_id : null
          // A pending REMOVAL of the same edge is an explicit conflict, not a
          // silent one: re-asserting an active edge stages nothing (the
          // upsert below no-ops), so if the pending removal were approved
          // later, this proposal's approval could not restore the edge it
          // asserted. Surface that as a 400 while it is still detectable.
          // (The narrower race — removal STAGED AND APPROVED entirely within
          // this proposal's pending window — remains an accepted single-slot
          // limitation, documented in CONTRACTS §1.7.)
          const pendingRemoval = await tx.query<{ id: string }>(
            `SELECT rel.id
               FROM wk_relations rel
               JOIN wk_change_proposals p ON p.id = rel.removal_proposal_id
              WHERE rel.space_id = $1 AND rel.from_concept_id = $2 AND rel.to_concept_id = $3 AND rel.kind = $4
                AND p.status = 'pending'
              LIMIT 1`,
            [spaceId, concept.id, target.id, relation.kind],
          )
          if (pendingRemoval.rows[0]) {
            throw new ValidationError(
              `relation ${entry.slug} ${relation.kind} ${relation.to_slug} has a pending removal proposal — review that first`,
            )
          }
          // Upsert with RE-ADOPTION: an already-ACTIVE relation keeps its
          // status and provenance (re-proposing it is a no-op, never a
          // downgrade back to 'proposed'), but a row left 'removed' by a
          // rejection — or 'proposed' under a different proposal — is taken
          // over by THIS proposal. Plain DO NOTHING would poison the tuple
          // forever: wk_apply_proposal's flip only activates rows whose
          // proposal_id matches, so a once-rejected relation could never
          // become active again.
          await tx.query(
            `INSERT INTO wk_relations (space_id, from_concept_id, to_concept_id, kind, status, proposal_id, to_space_id)
             VALUES ($1, $2, $3, $4, 'proposed', $5, $6)
             ON CONFLICT (space_id, from_concept_id, to_concept_id, kind)
             DO UPDATE SET status = 'proposed', proposal_id = EXCLUDED.proposal_id
             WHERE wk_relations.status <> 'active'`,
            [spaceId, concept.id, target.id, relation.kind, proposalId, targetSpaceId],
          )
        }
      }

      for (const decision of input.decisions) {
        // Same re-adoption rationale as relations: unique(space_id, slug) —
        // an ACTIVE decision keeps its row untouched, but a proposed (e.g.
        // pinned to a rejected proposal) or superseded one is re-staged with
        // this proposal's content and ownership, so approval can activate it.
        await tx.query(
          `INSERT INTO wk_decisions (space_id, slug, title, context, decision, rationale, alternatives, status, proposal_id, agent_meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'proposed', $8, $9)
           ON CONFLICT (space_id, slug)
           DO UPDATE SET title = EXCLUDED.title,
                         context = EXCLUDED.context,
                         decision = EXCLUDED.decision,
                         rationale = EXCLUDED.rationale,
                         alternatives = EXCLUDED.alternatives,
                         agent_meta = EXCLUDED.agent_meta,
                         status = 'proposed',
                         proposal_id = EXCLUDED.proposal_id
           WHERE wk_decisions.status <> 'active'`,
          [
            spaceId,
            decision.slug,
            decision.title,
            decision.context,
            decision.decision,
            decision.rationale,
            JSON.stringify(decision.alternatives),
            proposalId,
            JSON.stringify(input.agent_meta),
          ],
        )
      }

      for (const edge of input.relations_removed) {
        const from = conceptBySlug.get(edge.from_slug)!
        const to = conceptBySlug.get(edge.to_slug)!
        // Mark the ACTIVE row for removal — no status flip before approval,
        // so every reader keeps seeing the relation during review. A marker
        // already held by another pending proposal is overwritten: relation
        // removal provenance is single-slot, the same accepted trade-off as
        // proposal_id re-adoption above. Zero rows = the edge does not exist
        // as an active relation → 400, staging must not invent work for the
        // apply function.
        const marked = await tx.query<{ id: string }>(
          `UPDATE wk_relations SET removal_proposal_id = $5
            WHERE space_id = $1 AND from_concept_id = $2 AND to_concept_id = $3 AND kind = $4 AND status = 'active'
            RETURNING id`,
          [spaceId, from.id, to.id, edge.kind, proposalId],
        )
        if (!marked.rows[0]) {
          throw new ValidationError(
            `no active ${edge.kind} relation from ${edge.from_slug} to ${edge.to_slug} in this space`,
          )
        }
      }

      // Run the SAME exact-frame matcher the approval will apply, so the
      // proposal.created event announces contradictions before any review.
      const contradictions = await findContradictions(tx, spaceId, { claims: allTriples })

      await tx.emitEvent(spaceId, 'wikikit.proposal.created', {
        proposal_id: proposalId,
        space: space.slug,
        title: input.title,
        source_ids: input.source_ids,
        concepts: conceptSlugs,
        claims_count: claimsCount,
        contradictions_count: contradictions.length,
        relations_removed_count: input.relations_removed.length,
      })

      return { proposal_id: proposalId, status: 'pending' as const }
    })
  } catch (error) {
    // Dedup race: two identical ingests staged concurrently — the loser hits
    // the partial unique index and converges on the winner's pending
    // proposal. Any OTHER 23505 (e.g. citation FK issues) stays an error.
    const pg = error as { code?: string; constraint?: string }
    if (pg.code === '23505' && pg.constraint === 'wk_change_proposals_pending_dedup') {
      const [winner] = await db.select<{ id: string }>('wk_change_proposals', {
        space_id: `eq.${spaceId}`,
        input_hash: `eq.${inputHash}`,
        status: 'eq.pending',
        limit: 1,
      })
      if (winner) return { proposal_id: winner.id, status: 'pending' }
    }
    throw error
  }
}

interface ProposalRow {
  id: string
  space_id: string
  status: ProposalStatus
  title: string
  summary: string
  input_hash: string
  source_ids: string[]
  agent_meta: Record<string, unknown>
  reviewer: string | null
  review_note: string | null
  review_channel: ReviewChannel | null
  reviewed_at: Date | string | null
  changes_requested: boolean
  parent_proposal_id: string | null
  created_at: Date | string
}

/**
 * The structured diff (⚠ global-id lookup — transport must check the returned
 * space_id against the key's space). Claims are grouped:
 *   added      — every claim this proposal stages
 *   disputed   — claims that ARE disputed (post-approval) or WOULD BE
 *                (pending: exact-frame collision with an existing visible
 *                claim) — the reviewer sees the dispute before deciding
 *   deprecated — claims of this proposal in status 'deprecated' (empty in
 *                v0.1 flows; the shape is part of the wire contract)
 */
export async function getProposal(db: Db, args: { id: string }): Promise<ProposalDetail> {
  const [proposal] = await db.select<ProposalRow>('wk_change_proposals', { id: `eq.${args.id}`, limit: 1 })
  if (!proposal) throw new NotFoundError(`proposal ${args.id} not found`)
  const [space] = await db.select<{ slug: string }>('wk_spaces', { id: `eq.${proposal.space_id}`, limit: 1 })

  const revisions = await db.query<{
    concept_id: string
    slug: string
    markdown: string
    base_revision_id: string | null
    old_markdown: string | null
    stale: boolean
  }>(
    `SELECT r.concept_id, c.slug, r.markdown, r.base_revision_id, base.markdown AS old_markdown,
            (r.status = 'proposed' AND c.current_revision_id IS DISTINCT FROM r.base_revision_id) AS stale
       FROM wk_concept_revisions r
       JOIN wk_concepts c ON c.id = r.concept_id
       LEFT JOIN wk_concept_revisions base ON base.id = r.base_revision_id
      WHERE r.proposal_id = $1
      ORDER BY c.slug ASC`,
    [args.id],
  )

  // One query for all proposal claims with a "collides" flag computed by the
  // same frame rule as wk_apply_proposal flip 5 — used only while pending
  // (after approval the persisted 'disputed' status is the truth).
  const claims = await db.query<{
    id: string
    concept_id: string
    subject: string
    predicate: string
    object: string
    status: ClaimStatus
    confidence: number
    collides: boolean
  }>(
    `SELECT cl.id, cl.concept_id, cl.subject, cl.predicate, cl.object, cl.status, cl.confidence,
            EXISTS (
              SELECT 1 FROM wk_claims other
               WHERE other.space_id = cl.space_id
                 AND other.subject = cl.subject
                 AND other.predicate = cl.predicate
                 AND other.object <> cl.object
                 AND other.proposal_id IS DISTINCT FROM cl.proposal_id
                 AND other.status IN ('verified', 'disputed')
            ) AS collides
       FROM wk_claims cl
      WHERE cl.proposal_id = $1
      ORDER BY cl.created_at ASC`,
    [args.id],
  )

  // Citations for every staged claim, with the source title resolved — the
  // review surfaces show quote + source side by side.
  const citations = await db.query<{
    claim_id: string
    source_id: string
    quote: string
    locator: string
    source_title: string | null
  }>(
    `SELECT ci.claim_id, ci.source_id, ci.quote, ci.locator, s.title AS source_title
       FROM wk_citations ci
       JOIN wk_claims cl ON cl.id = ci.claim_id
       JOIN wk_sources s ON s.id = ci.source_id
      WHERE cl.proposal_id = $1
      ORDER BY ci.created_at ASC`,
    [args.id],
  )

  const relations = await db.query<{ from_concept_id: string; to_slug: string; kind: RelationKind }>(
    `SELECT rel.from_concept_id, t.slug AS to_slug, rel.kind
       FROM wk_relations rel
       JOIN wk_concepts t ON t.id = rel.to_concept_id
      WHERE rel.proposal_id = $1
      ORDER BY t.slug ASC, rel.kind ASC`,
    [args.id],
  )

  // Removals live on the MARKER, never on proposal_id — the query above
  // cannot conflate them. The marker survives approve and reject, so the
  // diff of a terminal proposal stays complete for the audit trail.
  const relationsRemoved = await db.query<{ from_slug: string; to_slug: string; kind: RelationKind }>(
    `SELECT f.slug AS from_slug, t.slug AS to_slug, rel.kind
       FROM wk_relations rel
       JOIN wk_concepts f ON f.id = rel.from_concept_id
       JOIN wk_concepts t ON t.id = rel.to_concept_id
      WHERE rel.removal_proposal_id = $1
      ORDER BY f.slug ASC, t.slug ASC, rel.kind ASC`,
    [args.id],
  )

  // Decisions are real staged rows just like revisions, claims and relations.
  // Load them for every proposal status: approval activates them, rejection
  // deliberately keeps them proposed for the audit trail, and both states
  // must remain reviewable after the fact. Slug ordering keeps JSON/Markdown
  // stable across calls and transports.
  const decisions = await db.query<DecisionDiff>(
    `SELECT slug, title, context, decision, rationale, alternatives
       FROM wk_decisions
      WHERE proposal_id = $1
      ORDER BY slug ASC`,
    [args.id],
  )

  const pending = proposal.status === 'pending'
  const citationsByClaim = new Map<string, ClaimDiff['citations']>()
  for (const citation of citations.rows) {
    const list = citationsByClaim.get(citation.claim_id) ?? []
    list.push({
      source_id: citation.source_id,
      quote: citation.quote,
      locator: citation.locator,
      source_title: citation.source_title,
    })
    citationsByClaim.set(citation.claim_id, list)
  }
  const concepts: ConceptDiff[] = revisions.rows.map((revision) => {
    const own = claims.rows.filter((claim) => claim.concept_id === revision.concept_id)
    const triple = (claim: ClaimTriple): ClaimTriple => ({
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
    })
    return {
      slug: revision.slug,
      is_new: revision.base_revision_id === null,
      old_markdown: revision.old_markdown,
      new_markdown: revision.markdown,
      stale: pending && revision.stale === true,
      claims_added: own.map(triple),
      claims_disputed: own.filter((claim) => (pending ? claim.collides : claim.status === 'disputed')).map(triple),
      claims_deprecated: own.filter((claim) => claim.status === 'deprecated').map(triple),
      claims: own.map((claim) => ({
        subject: claim.subject,
        predicate: claim.predicate,
        object: claim.object,
        status: claim.status,
        confidence: Number(claim.confidence ?? 0.5),
        collides: pending && claim.collides,
        citations: citationsByClaim.get(claim.id) ?? [],
      })),
      relations_added: relations.rows
        .filter((relation) => relation.from_concept_id === revision.concept_id)
        .map((relation) => ({ to_slug: relation.to_slug, kind: relation.kind })),
    }
  })

  // Resolve the source rows behind source_ids ∪ cited ids: the review
  // surfaces show titles, not bare uuids.
  const sourceIds = [
    ...new Set([...(proposal.source_ids ?? []), ...citations.rows.map((citation) => citation.source_id)]),
  ]
  const sources = sourceIds.length
    ? await db.query<{ id: string; title: string | null; url: string | null; kind: string; created_at: Date | string }>(
        `SELECT id, title, url, kind, created_at FROM wk_sources WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC`,
        [sourceIds],
      )
    : {
        rows: [] as { id: string; title: string | null; url: string | null; kind: string; created_at: Date | string }[],
      }

  return {
    id: proposal.id,
    space: space?.slug ?? '',
    space_id: proposal.space_id,
    status: proposal.status,
    title: proposal.title,
    summary: proposal.summary,
    created_at: isoString(proposal.created_at),
    reviewer: proposal.reviewer,
    review_note: proposal.review_note,
    review_channel: proposal.review_channel,
    reviewed_at: proposal.reviewed_at === null ? null : isoString(proposal.reviewed_at),
    source_ids: proposal.source_ids ?? [],
    agent_meta: proposal.agent_meta ?? {},
    changes_requested: proposal.changes_requested === true,
    parent_proposal_id: proposal.parent_proposal_id ?? null,
    sources: sources.rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      kind: row.kind,
      created_at: isoString(row.created_at),
    })),
    concepts,
    decisions: decisions.rows.map((decision) => ({
      slug: decision.slug,
      title: decision.title,
      context: decision.context,
      decision: decision.decision,
      rationale: decision.rationale,
      alternatives: Array.isArray(decision.alternatives) ? decision.alternatives : [],
    })),
    relations_removed: relationsRemoved.rows.map((edge) => ({
      from_slug: edge.from_slug,
      to_slug: edge.to_slug,
      kind: edge.kind,
    })),
  }
}

/** Canonical public projection shared by REST and MCP. */
export function toProposalWire(detail: ProposalDetail): ProposalWireDetail {
  const { space_id: _spaceId, ...wire } = detail
  return wire
}

/**
 * The human-readable diff (plan §15.3: review happens over curl/chat, so this
 * text must carry the whole decision). Served as text/markdown via Accept
 * header and readable inline in a chat. Pure function of the JSON detail —
 * both representations always agree.
 */
export function renderProposalMarkdown(detail: ProposalDetail): string {
  const lines: string[] = []
  lines.push(`# Proposal: ${detail.title}`)
  lines.push('')
  lines.push(`- **id:** ${detail.id}`)
  lines.push(`- **space:** ${detail.space}`)
  lines.push(`- **status:** ${detail.status}`)
  lines.push(`- **created:** ${detail.created_at}`)
  if (detail.reviewer) {
    lines.push(`- **reviewer:** ${detail.reviewer}${detail.reviewed_at ? ` (${detail.reviewed_at})` : ''}`)
  }
  if (detail.review_channel) lines.push(`- **review channel:** ${detail.review_channel}`)
  if (detail.review_note) lines.push(`- **review note:** ${detail.review_note}`)
  if (detail.changes_requested) {
    lines.push(`- **changes requested:** yes — revise per the review note and submit a FRESH proposal`)
  }
  if (detail.parent_proposal_id) lines.push(`- **split from:** ${detail.parent_proposal_id}`)
  if (detail.source_ids.length) lines.push(`- **sources:** ${detail.source_ids.join(', ')}`)
  const meta = detail.agent_meta as { model?: unknown; prompt_version?: unknown }
  if (meta.model) lines.push(`- **agent:** ${String(meta.model)} (${String(meta.prompt_version ?? 'unknown')})`)
  if (detail.summary) {
    lines.push('')
    lines.push(detail.summary)
  }

  const bullet = (claim: ClaimTriple) => `- ${claim.subject} **${claim.predicate}** ${claim.object}`

  for (const concept of detail.concepts) {
    lines.push('')
    lines.push(
      `## Concept \`${concept.slug}\` — ${concept.is_new ? 'new' : 'update'}${concept.stale ? ' ⚠ STALE' : ''}`,
    )
    if (concept.stale) {
      lines.push('')
      lines.push(
        '> ⚠ The concept moved on since this proposal was synthesized — approval will fail with stale_base. Remedy: re-ingest the source against the current revision.',
      )
    }
    if (!concept.is_new && concept.old_markdown !== null) {
      lines.push('')
      lines.push('### Old revision')
      lines.push('')
      lines.push('```markdown')
      lines.push(concept.old_markdown)
      lines.push('```')
    }
    lines.push('')
    lines.push('### New revision')
    lines.push('')
    lines.push('```markdown')
    lines.push(concept.new_markdown)
    lines.push('```')
    if (concept.claims_added.length) {
      lines.push('')
      lines.push(`### Claims added (${concept.claims_added.length})`)
      lines.push('')
      for (const claim of concept.claims_added) {
        lines.push(bullet(claim))
        // Quote + source title beside the claim — the citation IS the review
        // evidence; a reviewer should never chase a bare uuid.
        const full = concept.claims.find(
          (candidate) =>
            candidate.subject === claim.subject &&
            candidate.predicate === claim.predicate &&
            candidate.object === claim.object,
        )
        const citation = full?.citations[0]
        if (citation) {
          lines.push(`  - quote: "${citation.quote}"${citation.source_title ? ` — ${citation.source_title}` : ''}`)
        }
      }
    }
    if (concept.claims_disputed.length) {
      lines.push('')
      lines.push(`### Claims disputed (${concept.claims_disputed.length}) ⚠`)
      lines.push('')
      for (const claim of concept.claims_disputed) lines.push(bullet(claim))
    }
    if (concept.claims_deprecated.length) {
      lines.push('')
      lines.push(`### Claims deprecated (${concept.claims_deprecated.length})`)
      lines.push('')
      for (const claim of concept.claims_deprecated) lines.push(bullet(claim))
    }
    if (concept.relations_added.length) {
      lines.push('')
      lines.push('### Relations')
      lines.push('')
      for (const relation of concept.relations_added) lines.push(`- ${relation.kind} → [[${relation.to_slug}]]`)
    }
  }

  if (detail.relations_removed.length) {
    // Tense follows the proposal state: a terminal proposal's diff must not
    // promise a future effect that already happened (approved) or never will
    // (rejected/failed).
    const removalEffect =
      detail.status === 'pending'
        ? 'will be deactivated on approval'
        : detail.status === 'approved'
          ? 'deactivated by this approval'
          : 'NOT deactivated — this proposal was not approved'
    lines.push('')
    lines.push(`## Relations removed (${detail.relations_removed.length}) ⚠`)
    lines.push('')
    for (const edge of detail.relations_removed) {
      lines.push(`- [[${edge.from_slug}]] ${edge.kind} → [[${edge.to_slug}]] — ${removalEffect}`)
    }
  }

  for (const decision of detail.decisions) {
    lines.push('')
    lines.push(`## Decision \`${decision.slug}\` — ${decision.title}`)
    lines.push('')
    lines.push('### Context')
    lines.push('')
    lines.push(decision.context)
    lines.push('')
    lines.push('### Decision')
    lines.push('')
    lines.push(decision.decision)
    lines.push('')
    lines.push('### Rationale')
    lines.push('')
    lines.push(decision.rationale || '_None provided._')
    lines.push('')
    lines.push('### Alternatives')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(decision.alternatives, null, 2))
    lines.push('```')
  }
  lines.push('')
  return lines.join('\n')
}

// The SQL functions raise with the machine code as the EXACT message
// (documented in the migration), so mapping is string equality — never
// substring guessing on arbitrary errors.
function mapReviewError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'proposal_not_found') throw new NotFoundError('proposal not found')
  if (message === 'proposal_not_pending') {
    throw new ConflictError('proposal_not_pending', 'proposal has already been reviewed', {
      nextBestActions: ['GET /v1/proposals/{id} to see its terminal status'],
    })
  }
  if (message === 'stale_base') {
    throw new ConflictError('stale_base', 'the concept moved on since this proposal was synthesized', {
      nextBestActions: [
        'this proposal is now failed (terminal)',
        're-ingest the source to synthesize against the current revision',
      ],
    })
  }
  if (message === 'unknown_split_slug') {
    throw new ValidationError('concepts must name slugs staged by this proposal')
  }
  if (message === 'split_nothing_left') {
    throw new ValidationError(
      'nothing to split: the subset covers every staged concept (or the proposal has a single reviewable unit)',
    )
  }
  if (message === 'note_required') {
    throw new ValidationError('request-changes requires a non-empty note — the note IS the requested change')
  }
  throw error
}

/**
 * True when the (already-validated or raw) proposal body stages any
 * cross-space relation. Transports use this for the key-visibility half of
 * the 0023 gate: a space-scoped key sees exactly one space and may therefore
 * never stage across spaces (403-not-404 discipline).
 */
export function stagesCrossSpaceRelations(body: unknown): boolean {
  const concepts = (body as { concepts?: { relations?: { to_slug?: unknown }[] }[] } | undefined)?.concepts
  if (!Array.isArray(concepts)) return false
  return concepts.some(
    (entry) =>
      Array.isArray(entry?.relations) &&
      entry.relations.some((relation) => typeof relation?.to_slug === 'string' && relation.to_slug.includes(':')),
  )
}

export interface SplitResult {
  parent: { id: string; status: 'split' | 'pending' }
  children: { proposal_id: string; concepts: string[] }[]
}

/**
 * ⚠ Global-id wrapper over db.call('wk_split_proposal'). Full split
 * (no concepts arg): one pending child per staged concept (+ one for
 * decisions/leftover removal markers), parent → terminal 'split'. Subset
 * (defer): the named concepts move to ONE child; the parent keeps its id and
 * remainder and stays pending with a re-salted input_hash.
 */
export async function splitProposal(
  db: Db,
  args: { id: string; reviewer: string; concepts?: string[]; reviewChannel?: ReviewChannel },
): Promise<SplitResult> {
  if (!args.reviewer) throw new ValidationError('reviewer is required')
  try {
    const [result] = await db.call<SplitResult>('wk_split_proposal', [
      args.id,
      args.reviewer,
      args.concepts && args.concepts.length ? args.concepts : null,
      args.reviewChannel ?? 'rest',
    ])
    return result!
  } catch (error) {
    mapReviewError(error)
  }
}

export interface RequestChangesResult extends RejectResult {
  changes_requested: true
}

/**
 * ⚠ Global-id wrapper over db.call('wk_request_changes') — a terminal reject
 * plus the machine-readable changes_requested flag. The note is mandatory:
 * agents read it as the revision brief for a fresh proposal.
 */
export async function requestChanges(
  db: Db,
  args: { id: string; reviewer: string; note: string; reviewChannel?: ReviewChannel },
): Promise<RequestChangesResult> {
  if (!args.reviewer) throw new ValidationError('reviewer is required')
  try {
    const [result] = await db.call<RequestChangesResult>('wk_request_changes', [
      args.id,
      args.reviewer,
      args.note,
      args.reviewChannel ?? 'rest',
    ])
    return result!
  } catch (error) {
    mapReviewError(error)
  }
}

/**
 * ⚠ Global-id wrapper over db.call('wk_apply_proposal') — the only approve
 * path. On stale_base the CALLER marks the proposal failed (terminal) per
 * §9.2 — the one status write TypeScript performs itself, because the SQL
 * function has already rolled back by the time the error surfaces. Failing
 * (instead of leaving it pending forever) frees the (space_id, input_hash)
 * pending-dedup slot so a re-ingest can produce a FRESH proposal against the
 * current revision instead of converging back onto the unapprovable one.
 */
export async function approveProposal(
  db: Db,
  args: { id: string; reviewer: string; note?: string; reviewChannel?: ReviewChannel },
): Promise<ApplyResult> {
  if (!args.reviewer) throw new ValidationError('reviewer is required')
  const reviewChannel = args.reviewChannel ?? 'rest'
  try {
    const [result] = await db.call<ApplyResult>('wk_apply_proposal', [
      args.id,
      args.reviewer,
      args.note ?? null,
      reviewChannel,
    ])
    return result!
  } catch (error) {
    if (error instanceof Error && error.message === 'stale_base') {
      // Guarded on status='pending' so a racing review cannot be overwritten;
      // best-effort — the 409 below is the caller's truth either way.
      await db
        .update(
          'wk_change_proposals',
          { id: `eq.${args.id}`, status: 'eq.pending' },
          {
            status: 'failed',
            reviewer: args.reviewer,
            review_note: args.note ?? 'stale_base: concept moved on since synthesis',
            review_channel: reviewChannel,
            reviewed_at: new Date().toISOString(),
          },
          { returning: false },
        )
        .catch(() => {})
    }
    mapReviewError(error)
  }
}

/** ⚠ Global-id wrapper over db.call('wk_reject_proposal'). */
export async function rejectProposal(
  db: Db,
  args: { id: string; reviewer: string; note?: string; reviewChannel?: ReviewChannel },
): Promise<RejectResult> {
  if (!args.reviewer) throw new ValidationError('reviewer is required')
  const reviewChannel = args.reviewChannel ?? 'rest'
  try {
    const [result] = await db.call<RejectResult>('wk_reject_proposal', [
      args.id,
      args.reviewer,
      args.note ?? null,
      reviewChannel,
    ])
    return result!
  } catch (error) {
    mapReviewError(error)
  }
}
