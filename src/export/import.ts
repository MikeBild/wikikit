// Export/import entry points (CONTRACTS §4.3) + the bundle format registry.
//
// This module hosts the registry so the dependency graph stays acyclic:
// markdown.ts (model + md format) ← okf.ts (okf format) ← import.ts (registry
// + orchestration). Serializers and parsers are pure; everything touching the
// database lives HERE, in exactly two functions:
//
//   exportSpace  — snapshot → serialize → deterministic zip. A pure pipeline
//                  over loadSpaceSnapshot, so identical knowledge exports to
//                  identical bytes (the round-trip contract, plan §9).
//   importBundle — zip → parse → sources upserted DIRECTLY (they are
//                  immutable archive material, idempotent on content hash) →
//                  concepts/claims/decisions staged as ONE ChangeProposal.
//                  Foreign knowledge NEVER lands directly: it goes through
//                  the same review gate as LLM synthesis (plan §9: "Fremd-
//                  wissen durchläuft dasselbe Review-Gate").
//
// WHY sources bypass the gate while knowledge does not: a source is verbatim
// evidence — archiving it asserts nothing. A concept or claim asserts
// knowledge, and unreviewed assertions are exactly what the proposal
// machinery exists to prevent.
import { z } from 'zod'
import type { Db } from '../db/postgres.ts'
import { ValidationError } from '../domain/errors.ts'
import { createProposal, type CreateProposalArgs } from '../domain/proposals.ts'
import { createSource, sha256Hex } from '../domain/sources.ts'
import {
  loadSpaceSnapshot,
  markdownBundleFormat,
  type BundleFile,
  type BundleFormat,
  type BundleFormatAdapter,
  type ImportedBundle,
} from './markdown.ts'
import { okfBundleFormat } from './okf.ts'
import { createZip, readZip } from './zip.ts'

/** Format registry — the ONLY place a BundleFormat string meets an adapter. */
export const BUNDLE_FORMATS: Record<BundleFormat, BundleFormatAdapter> = {
  md: markdownBundleFormat,
  okf: okfBundleFormat,
}

const zFormat = z.enum(['md', 'okf'])

// agent_meta stamp for imported proposals (§1.14 shape). 'import' — not
// 'manual' — because provenance must distinguish "a human typed this" from
// "a bundle carried this in"; the prompt_version versions the import MAPPING
// (bundle → proposal), which can regress exactly like a prompt can.
export const IMPORT_MODEL = 'import'
export const IMPORT_PROMPT_VERSION = 'import.v1'

const encoder = new TextEncoder()
// fatal:true — a bundle entry that is not valid UTF-8 is not markdown
// knowledge; importing a lossily-decoded version would silently corrupt it.
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

// ---------------------------------------------------------------------------
// Export

/**
 * Export everything readable in a space as a zip stream (CONTRACTS §4.3).
 * Deterministic end to end: snapshot loading orders every query, serializers
 * sort their file lists, and the zip writer pins every header byte — so
 * export → import → export is byte-stable (excluding log.md, which narrates
 * LOCAL review history and is documented out of the stability contract).
 */
export async function exportSpace(
  db: Db,
  spaceId: string,
  args: { format: BundleFormat },
): Promise<ReadableStream<Uint8Array>> {
  const format = zFormat.parse(args.format)
  const snapshot = await loadSpaceSnapshot(db, spaceId)
  const files = BUNDLE_FORMATS[format].serialize(snapshot)
  const archive = createZip(files.map((file) => ({ path: file.path, data: encoder.encode(file.content) })))
  // Single-chunk stream: bundles are text and fit in memory (the snapshot
  // already did); a ReadableStream is the contract shape so the HTTP layer
  // can pipe it without buffering policy of its own.
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(archive)
      controller.close()
    },
  })
}

// ---------------------------------------------------------------------------
// Import

/** Unzip an uploaded bundle into UTF-8 BundleFiles (zip guards in zip.ts). */
export function decodeBundle(data: Uint8Array): BundleFile[] {
  return readZip(data).map((entry) => {
    try {
      return { path: entry.path, content: strictDecoder.decode(entry.data) }
    } catch {
      throw new ValidationError(`bundle entry ${entry.path} is not valid UTF-8`)
    }
  })
}

/**
 * Deterministic dedup anchor for an imported bundle. The proposal input_hash
 * contract (§1.9) hashes "what went in": here that is the PARSED knowledge —
 * hashing parsed content (not archive bytes) means the same knowledge
 * re-zipped by different tooling (store vs deflate, entry order) still
 * converges on the same pending proposal instead of stacking review work.
 */
export function computeImportHash(bundle: ImportedBundle): string {
  const canonical = {
    v: IMPORT_PROMPT_VERSION,
    concepts: [...bundle.concepts]
      .map((concept) => ({ ...concept, claims: concept.claims, relations: concept.relations }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    decisions: [...bundle.decisions].sort((a, b) => a.slug.localeCompare(b.slug)),
    sources: bundle.sources.map((source) => sha256Hex(source.content)).sort(),
  }
  return sha256Hex(JSON.stringify(canonical))
}

const clip = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value)

/**
 * Map a parsed bundle to CreateProposalArgs (pure — unit-testable without a
 * database). sourceIdByRef resolves citation refs to wk_sources ids; refs
 * that resolve to nothing DROP the citation but KEEP the claim — the OKF
 * consumption philosophy (broken links tolerated, spec §9) applied to
 * provenance: an uncited claim is reviewable, a silently dropped claim is
 * lost knowledge.
 */
export function bundleToProposalArgs(
  bundle: ImportedBundle,
  sourceIdByRef: Map<string, string>,
  opts: { format: BundleFormat; inputHash: string; sourceIds: string[] },
): CreateProposalArgs {
  // First-wins slug dedup: staging two revisions of one concept in one
  // proposal would make the second stale against the first by construction.
  const seen = new Set<string>()
  const concepts: NonNullable<CreateProposalArgs['concepts']> = []
  for (const concept of bundle.concepts) {
    if (seen.has(concept.slug)) continue
    seen.add(concept.slug)
    concepts.push({
      slug: concept.slug,
      title: clip(concept.title, 500),
      summary: clip(concept.summary, 4000),
      // A body-less foreign document is still a concept; the title heading
      // satisfies the "revisions are never empty" invariant (zod min(1)).
      markdown: concept.markdown || `# ${concept.title}\n`,
      claims: concept.claims.map((claim) => ({
        subject: claim.subject,
        predicate: claim.predicate,
        object: claim.object,
        // Imported claim STATUS is deliberately not staged — the review gate
        // re-derives it (approve → verified, collisions → disputed).
        confidence: claim.confidence,
        citations: claim.citations.flatMap((citation) => {
          const sourceId = sourceIdByRef.get(citation.source)
          if (!sourceId) return []
          return [{ source_id: sourceId, quote: citation.quote, locator: clip(citation.locator, 500) }]
        }),
      })),
      relations: concept.relations.map((relation) => ({ to_slug: relation.to, kind: relation.kind })),
    })
  }

  const seenDecisions = new Set<string>()
  const decisions: NonNullable<CreateProposalArgs['decisions']> = []
  for (const decision of bundle.decisions) {
    if (seenDecisions.has(decision.slug)) continue
    seenDecisions.add(decision.slug)
    decisions.push({
      slug: decision.slug,
      title: clip(decision.title, 500),
      context: decision.context,
      decision: decision.decision,
      rationale: decision.rationale,
      alternatives: decision.alternatives,
    })
  }

  const summaryParts: string[] = []
  if (concepts.length) summaryParts.push(`${concepts.length} concept${concepts.length === 1 ? '' : 's'}`)
  if (decisions.length) summaryParts.push(`${decisions.length} decision${decisions.length === 1 ? '' : 's'}`)
  if (opts.sourceIds.length)
    summaryParts.push(`${opts.sourceIds.length} source${opts.sourceIds.length === 1 ? '' : 's'}`)

  return {
    title: `Import ${opts.format} bundle`,
    summary: `Imported ${summaryParts.join(', ')}: ${concepts.map((concept) => concept.slug).join(', ') || '(decisions only)'}`,
    input_hash: opts.inputHash,
    source_ids: opts.sourceIds,
    agent_meta: {
      model: IMPORT_MODEL,
      prompt_version: IMPORT_PROMPT_VERSION,
      input_hash: opts.inputHash,
      source_ids: opts.sourceIds,
      format: opts.format,
    },
    concepts,
    decisions,
  }
}

/**
 * Import an uploaded bundle (CONTRACTS §4.3): sources upserted directly
 * (idempotent on content hash — re-importing reuses existing rows), all
 * knowledge staged as ONE pending ChangeProposal behind the review gate.
 *
 * Citation refs resolve through TWO keys per source: the filename stem (what
 * foreign bundles cite) and sha256(content) (what OUR exports cite — the stem
 * and the hash coincide there, but a foreign bundle may rename files while
 * keeping hash refs intact).
 */
export async function importBundle(
  db: Db,
  spaceId: string,
  args: { data: Uint8Array; format: BundleFormat },
): Promise<{ proposal_id: string; sources_created: number }> {
  const format = zFormat.parse(args.format)
  const bundle = BUNDLE_FORMATS[format].parse(decodeBundle(args.data))

  // Validate BEFORE any write: a sources-only (or empty) bundle cannot
  // produce the one ChangeProposal the contract promises, so nothing must
  // have been persisted when we refuse it.
  if (!bundle.concepts.length && !bundle.decisions.length) {
    throw new ValidationError('bundle contains no concepts or decisions to import', {
      next_best_actions: ['add at least one concept document to the bundle', 'use POST .../ingest for single sources'],
    })
  }

  const sourceIdByRef = new Map<string, string>()
  const sourceIds: string[] = []
  let sourcesCreated = 0
  const seenRefs = new Set<string>()
  for (const source of bundle.sources) {
    if (seenRefs.has(source.ref)) continue // duplicate stems: first wins
    seenRefs.add(source.ref)
    const { source: row, created } = await createSource(db, spaceId, {
      kind: source.kind,
      url: source.url ?? undefined,
      title: source.title ? clip(source.title, 500) : undefined,
      raw: source.content,
      // Verbatim projection: import archives, it does not normalize —
      // normalization is the ingest pipeline's judgement call, and an import
      // that rewrote source bytes could never round-trip.
      markdown: source.content,
    })
    if (created) sourcesCreated += 1
    sourceIds.push(row.id)
    sourceIdByRef.set(source.ref, row.id)
    sourceIdByRef.set(row.content_hash, row.id)
  }

  const inputHash = computeImportHash(bundle)
  const proposalArgs = bundleToProposalArgs(bundle, sourceIdByRef, { format, inputHash, sourceIds })
  const { proposal_id } = await createProposal(db, spaceId, proposalArgs)
  return { proposal_id, sources_created: sourcesCreated }
}
