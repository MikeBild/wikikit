// Export/import bundle model + the Markdown-tree format (plan §9, CONTRACTS
// §4.3).
//
// The shared vocabulary of the whole export subsystem lives here:
//
//   SpaceSnapshot   — everything READABLE in a space (current revisions,
//                     visible claims, active relations/decisions, all
//                     sources, the review log), loaded in one deterministic
//                     pass. Serializers are pure functions of this snapshot —
//                     that purity IS the byte-stability guarantee: identical
//                     knowledge always zips to identical bytes.
//   BundleFormatAdapter — serialize(snapshot) → files, parse(files) →
//                     ImportedBundle. The OKF adapter (okf.ts) implements the
//                     same interface behind the format switch, so all OKF
//                     knowledge stays isolated in one file (plan §15.1).
//   ImportedBundle  — the parse result both formats produce. Deliberately
//                     transport-shaped, not DB-shaped: sources are keyed by
//                     their FILE ref (not uuids), because ids never travel
//                     across systems — import.ts maps refs to fresh rows.
//
// Round-trip contract and its honest limits:
//   * Concept markdown, claims (subject/predicate/object/confidence/
//     citations) and relations round-trip losslessly through frontmatter.
//   * Claim/decision STATUS is exported as information but re-derived by the
//     review gate on import: proposed→verified on approve, exact-frame
//     collisions re-dispute. 'deprecated' claims and 'superseded' decisions
//     therefore re-import as verified/active — status is review history, not
//     source knowledge, and history does not travel.
//   * log.md and index.md are DERIVED files: ignored on import, regenerated
//     on export. index.md is a pure function of the knowledge (byte-stable);
//     log.md narrates the local audit trail and is excluded from the
//     stability contract.
import type { Db } from '../db/postgres.ts'
import { NotFoundError, ValidationError } from '../domain/errors.ts'
import type { ReviewChannel } from '../domain/proposals.ts'
import { RELATION_KINDS, type RelationKind } from '../domain/relations.ts'
import { isoString } from '../domain/sources.ts'
import { extractTitle, parseFrontmatter, serializeFrontmatter } from '../markdown.ts'
import { z } from 'zod'

export type BundleFormat = 'md' | 'okf'

/** One file inside a bundle — path uses forward slashes, content is UTF-8. */
export interface BundleFile {
  path: string
  content: string
}

// ---------------------------------------------------------------------------
// Snapshot model

export interface SnapshotCitation {
  /** Source content hash — the cross-system stable key (uuids never travel). */
  source: string
  quote: string
  locator: string
}

export interface SnapshotClaim {
  subject: string
  predicate: string
  object: string
  status: string
  confidence: number
  citations: SnapshotCitation[]
}

export interface SnapshotConcept {
  slug: string
  title: string
  summary: string
  markdown: string
  claims: SnapshotClaim[]
  relations: { to: string; kind: RelationKind }[]
}

export interface SnapshotDecision {
  slug: string
  title: string
  status: string
  context: string
  decision: string
  rationale: string
  alternatives: unknown[]
}

export interface SnapshotSource {
  content_hash: string
  kind: string
  url: string | null
  title: string | null
  /** raw_content verbatim — the hash anchor must survive the round trip. */
  content: string
}

export interface SnapshotLogEntry {
  /** ISO date (YYYY-MM-DD, UTC) of the review. */
  date: string
  action: 'Approved' | 'Rejected'
  title: string
  reviewer: string | null
  review_channel: ReviewChannel | null
  model: string | null
  concepts: string[]
}

export interface SpaceSnapshot {
  space: { slug: string; name: string }
  concepts: SnapshotConcept[]
  decisions: SnapshotDecision[]
  sources: SnapshotSource[]
  log: SnapshotLogEntry[]
}

// ---------------------------------------------------------------------------
// Imported bundle model (what parse() returns, what import.ts stages)

export interface ImportedSource {
  /** Filename stem — citation refs in the same bundle point at this. */
  ref: string
  kind: 'markdown' | 'text' | 'url' | 'import'
  url: string | null
  title: string | null
  content: string
}

export interface ImportedBundle {
  concepts: SnapshotConcept[]
  decisions: SnapshotDecision[]
  sources: ImportedSource[]
}

export interface BundleFormatAdapter {
  format: BundleFormat
  serialize(snapshot: SpaceSnapshot): BundleFile[]
  parse(files: BundleFile[]): ImportedBundle
}

// ---------------------------------------------------------------------------
// Shared helpers

const CONCEPT_SLUG = /^[a-z0-9][a-z0-9-]{0,126}$/

/** Force any foreign identifier into the wk_concepts slug grammar. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 127)
    .replace(/-+$/g, '')
  return slug || 'untitled'
}

/** 'concepts/deep/dir/okf.md' → slug for the path below a stripped prefix. */
export function slugFromPath(path: string, stripPrefix: string): string {
  const relative = path.startsWith(stripPrefix) ? path.slice(stripPrefix.length) : path
  const stem = relative.replace(/\.md$/i, '')
  return CONCEPT_SLUG.test(stem) ? stem : slugify(stem)
}

// Confidence is float4 in Postgres — full float64 digits would leak binary
// noise (0.8999999761…) into the export. Four decimals round-trip cleanly
// through float4 and read like what a reviewer typed.
export function roundConfidence(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

// Frontmatter claim schema — the zod boundary for BOTH bundle formats
// (markdown frontmatter and the OKF `wikikit` extension carry the same
// shape). Lenient where the review gate re-derives values anyway.
const zCitationFm = z.object({
  source: z.string().min(1),
  quote: z.string().min(1),
  locator: z.string().default(''),
})
const zClaimFm = z.object({
  subject: z.string().min(1).max(500),
  predicate: z.string().min(1).max(200),
  object: z.string().min(1).max(2000),
  status: z.string().default('verified'),
  confidence: z.number().min(0).max(1).default(0.5),
  citations: z.array(zCitationFm).default([]),
})
const zRelationFm = z.object({
  to: z.string().min(1),
  kind: z.enum(RELATION_KINDS),
})
export const zClaimsFm = z.array(zClaimFm).default([])
export const zRelationsFm = z.array(zRelationFm).default([])

const SOURCE_KINDS = new Set(['markdown', 'text', 'url', 'import'])

export function normalizeSourceKind(kind: unknown): ImportedSource['kind'] {
  return typeof kind === 'string' && SOURCE_KINDS.has(kind) ? (kind as ImportedSource['kind']) : 'import'
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.length ? value : null)

/** Frontmatter payload for a claim list — fixed key order, empties omitted. */
export function claimsToFrontmatter(claims: SnapshotClaim[]): Record<string, unknown>[] {
  return claims.map((claim) => ({
    subject: claim.subject,
    predicate: claim.predicate,
    object: claim.object,
    status: claim.status,
    confidence: roundConfidence(claim.confidence),
    ...(claim.citations.length
      ? {
          citations: claim.citations.map((citation) => ({
            source: citation.source,
            quote: citation.quote,
            ...(citation.locator ? { locator: citation.locator } : {}),
          })),
        }
      : {}),
  }))
}

export function claimsFromFrontmatter(value: unknown, path: string): SnapshotClaim[] {
  if (value === undefined) return []
  const parsed = zClaimsFm.safeParse(value)
  if (!parsed.success) throw new ValidationError(`${path}: invalid claims frontmatter — ${parsed.error.message}`)
  return parsed.data.map((claim) => ({
    subject: claim.subject,
    predicate: claim.predicate,
    object: claim.object,
    status: claim.status,
    confidence: claim.confidence,
    citations: claim.citations.map((citation) => ({
      source: citation.source,
      quote: citation.quote,
      locator: citation.locator,
    })),
  }))
}

export function relationsFromFrontmatter(value: unknown, path: string): SnapshotConcept['relations'] {
  if (value === undefined) return []
  const parsed = zRelationsFm.safeParse(value)
  if (!parsed.success) throw new ValidationError(`${path}: invalid relations frontmatter — ${parsed.error.message}`)
  return parsed.data.map((relation) => ({ to: slugify(relation.to), kind: relation.kind }))
}

// ---------------------------------------------------------------------------
// Markdown-tree format (plan §9)
//
// Layout:
//   index.md              TOC with [[slug]] wiki links (derived)
//   log.md                audit narrative (derived, local history)
//   concepts/<slug>.md    claims + relations in frontmatter, body = markdown
//   decisions/<slug>.md   everything in frontmatter (lossless; a body would
//                         duplicate the fields and drift in diffs)
//   sources/<hash>.md     kind/url/title in frontmatter, body = raw verbatim

function conceptToFile(concept: SnapshotConcept): BundleFile {
  const data: Record<string, unknown> = { title: concept.title }
  if (concept.summary) data.summary = concept.summary
  if (concept.claims.length) data.claims = claimsToFrontmatter(concept.claims)
  if (concept.relations.length) {
    data.relations = concept.relations.map((relation) => ({ to: relation.to, kind: relation.kind }))
  }
  return { path: `concepts/${concept.slug}.md`, content: serializeFrontmatter(data, concept.markdown) }
}

function decisionToFile(decision: SnapshotDecision): BundleFile {
  const data: Record<string, unknown> = {
    title: decision.title,
    status: decision.status,
    context: decision.context,
    decision: decision.decision,
  }
  if (decision.rationale) data.rationale = decision.rationale
  if (decision.alternatives.length) data.alternatives = decision.alternatives
  return { path: `decisions/${decision.slug}.md`, content: serializeFrontmatter(data, '') }
}

function sourceToFile(source: SnapshotSource): BundleFile {
  const data: Record<string, unknown> = { kind: source.kind }
  if (source.url) data.url = source.url
  if (source.title) data.title = source.title
  // Body is raw_content VERBATIM — sha256(body) must reproduce content_hash
  // on import. Our frontmatter fence parses off cleanly even when the raw
  // content itself starts with '---' (the parser stops at the FIRST closing
  // fence, which is ours).
  return { path: `sources/${source.content_hash}.md`, content: serializeFrontmatter(data, source.content) }
}

/**
 * Collapse arbitrary text (titles, summaries — LLM/manual strings with no
 * newline restriction) into a single index-bullet-safe line. A raw newline
 * interpolated into a `* [...](...) - ...` bullet would split the bullet and
 * fail the bundle's own index-structure conformance check.
 */
export function inlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** inlineText plus bracket escaping — for text placed INSIDE a markdown link label. */
export function inlineLinkText(value: string): string {
  return inlineText(value).replace(/([[\]])/g, '\\$1')
}

function renderIndex(snapshot: SpaceSnapshot): string {
  const lines: string[] = [`# ${inlineText(snapshot.space.name)}`]
  if (snapshot.concepts.length) {
    lines.push('', '## Concepts', '')
    for (const concept of snapshot.concepts) {
      lines.push(`- [[${concept.slug}]] — ${inlineText(concept.summary || concept.title)}`)
    }
  }
  if (snapshot.decisions.length) {
    lines.push('', '## Decisions', '')
    for (const decision of snapshot.decisions) lines.push(`- [[${decision.slug}]] — ${inlineText(decision.title)}`)
  }
  if (snapshot.sources.length) {
    lines.push('', '## Sources', '')
    for (const source of snapshot.sources) {
      lines.push(`- [${inlineLinkText(source.title || source.content_hash)}](sources/${source.content_hash}.md)`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function renderLog(snapshot: SpaceSnapshot): string {
  const lines: string[] = ['# Update Log']
  let currentDate = ''
  for (const entry of snapshot.log) {
    if (entry.date !== currentDate) {
      currentDate = entry.date
      lines.push('', `## ${entry.date}`, '')
    }
    const parts = [`- **${entry.action}**: ${entry.title}`]
    if (entry.reviewer) parts.push(`reviewer: ${entry.reviewer}`)
    if (entry.review_channel) parts.push(`channel: ${entry.review_channel}`)
    if (entry.model) parts.push(`model: ${entry.model}`)
    if (entry.concepts.length) parts.push(`concepts: ${entry.concepts.map((slug) => `[[${slug}]]`).join(', ')}`)
    lines.push(parts.join(' — '))
  }
  lines.push('')
  return lines.join('\n')
}

function parseConceptFile(file: BundleFile, slug: string): SnapshotConcept {
  const { data, content } = parseFrontmatter(file.content)
  return {
    slug,
    title: str(data.title) ?? extractTitle(content) ?? slug,
    summary: str(data.summary) ?? '',
    markdown: content,
    claims: claimsFromFrontmatter(data.claims, file.path),
    relations: relationsFromFrontmatter(data.relations, file.path),
  }
}

function parseDecisionFile(file: BundleFile, slug: string): SnapshotDecision {
  const { data, content } = parseFrontmatter(file.content)
  const decision = str(data.decision) ?? content.trim()
  if (!decision) throw new ValidationError(`${file.path}: decision file has no decision text`)
  return {
    slug,
    title: str(data.title) ?? slug,
    status: str(data.status) ?? 'active',
    context: str(data.context) ?? '(imported without context)',
    decision,
    rationale: str(data.rationale) ?? '',
    alternatives: Array.isArray(data.alternatives) ? data.alternatives : [],
  }
}

function parseSourceFile(file: BundleFile, ref: string): ImportedSource {
  const { data, content } = parseFrontmatter(file.content)
  if (!content) throw new ValidationError(`${file.path}: source file has an empty body`)
  return {
    ref,
    kind: normalizeSourceKind(data.kind),
    url: str(data.url),
    title: str(data.title),
    content,
  }
}

export const markdownBundleFormat: BundleFormatAdapter = {
  format: 'md',

  serialize(snapshot) {
    // Fixed file order — combined with the deterministic zip writer this
    // makes the archive a pure function of the snapshot.
    const files: BundleFile[] = [
      { path: 'index.md', content: renderIndex(snapshot) },
      { path: 'log.md', content: renderLog(snapshot) },
    ]
    for (const concept of [...snapshot.concepts].sort((a, b) => a.slug.localeCompare(b.slug))) {
      files.push(conceptToFile(concept))
    }
    for (const decision of [...snapshot.decisions].sort((a, b) => a.slug.localeCompare(b.slug))) {
      files.push(decisionToFile(decision))
    }
    for (const source of [...snapshot.sources].sort((a, b) => a.content_hash.localeCompare(b.content_hash))) {
      files.push(sourceToFile(source))
    }
    return files
  },

  parse(files) {
    const bundle: ImportedBundle = { concepts: [], decisions: [], sources: [] }
    for (const file of files) {
      if (!file.path.endsWith('.md')) continue // non-markdown payloads are not knowledge
      const base = file.path.split('/').at(-1)!
      if (base === 'index.md' || base === 'log.md') continue // derived files (see header)
      if (file.path.startsWith('concepts/')) {
        bundle.concepts.push(parseConceptFile(file, slugFromPath(file.path, 'concepts/')))
      } else if (file.path.startsWith('decisions/')) {
        bundle.decisions.push(parseDecisionFile(file, slugFromPath(file.path, 'decisions/')))
      } else if (file.path.startsWith('sources/')) {
        bundle.sources.push(parseSourceFile(file, base.replace(/\.md$/i, '')))
      } else {
        // Unknown location: treat as a concept rather than silently dropping
        // knowledge — permissive import mirrors OKF's consumption philosophy.
        bundle.concepts.push(parseConceptFile(file, slugFromPath(file.path, '')))
      }
    }
    return bundle
  },
}

// ---------------------------------------------------------------------------
// Snapshot loader — shared by both formats via exportSpace (import.ts hosts
// the format registry, keeping markdown ← okf ← import acyclic).

/**
 * Load everything readable in a space as one deterministic snapshot. Reader
 * visibility rules apply BY CONSTRUCTION (current-revision joins, visible
 * claim statuses, active relations) — an export can never leak staged
 * content, because it queries through the same pointers readers use.
 */
export async function loadSpaceSnapshot(db: Db, spaceId: string): Promise<SpaceSnapshot> {
  const [space] = await db.select<{ slug: string; name: string }>('wk_spaces', { id: `eq.${spaceId}`, limit: 1 })
  if (!space) throw new NotFoundError('space not found')

  const concepts = await db.query<{ id: string; slug: string; title: string; summary: string; markdown: string }>(
    `SELECT c.id, c.slug, r.title, r.summary, r.markdown
       FROM wk_concepts c
       JOIN wk_concept_revisions r ON r.id = c.current_revision_id
      WHERE c.space_id = $1
      ORDER BY c.slug ASC`,
    [spaceId],
  )

  const claims = await db.query<{
    id: string
    concept_id: string
    subject: string
    predicate: string
    object: string
    status: string
    confidence: number
  }>(
    `SELECT cl.id, cl.concept_id, cl.subject, cl.predicate, cl.object, cl.status, cl.confidence
       FROM wk_claims cl
       JOIN wk_concepts c ON c.id = cl.concept_id
      WHERE cl.space_id = $1
        AND cl.status IN ('verified', 'disputed', 'deprecated')
        AND c.current_revision_id IS NOT NULL
      ORDER BY cl.created_at ASC, cl.id ASC`,
    [spaceId],
  )

  const citations = await db.query<{ claim_id: string; content_hash: string; quote: string; locator: string }>(
    `SELECT ct.claim_id, s.content_hash, ct.quote, ct.locator
       FROM wk_citations ct
       JOIN wk_sources s ON s.id = ct.source_id
      WHERE ct.space_id = $1
      ORDER BY ct.created_at ASC, ct.id ASC`,
    [spaceId],
  )
  const citationsByClaim = new Map<string, SnapshotCitation[]>()
  for (const row of citations.rows) {
    const list = citationsByClaim.get(row.claim_id) ?? []
    list.push({ source: row.content_hash, quote: row.quote, locator: row.locator })
    citationsByClaim.set(row.claim_id, list)
  }

  const relations = await db.query<{ from_concept_id: string; to_slug: string; kind: RelationKind }>(
    `SELECT rel.from_concept_id, t.slug AS to_slug, rel.kind
       FROM wk_relations rel
       JOIN wk_concepts f ON f.id = rel.from_concept_id
       JOIN wk_concepts t ON t.id = rel.to_concept_id
      WHERE rel.space_id = $1 AND rel.status = 'active' AND f.current_revision_id IS NOT NULL
      ORDER BY t.slug ASC, rel.kind ASC`,
    [spaceId],
  )

  const decisions = await db.select<{
    slug: string
    title: string
    status: string
    context: string
    decision: string
    rationale: string
    alternatives: unknown[]
  }>('wk_decisions', { space_id: `eq.${spaceId}`, status: 'in.(active,superseded)', order: 'slug.asc' })

  const sources = await db.select<{
    content_hash: string
    kind: string
    url: string | null
    title: string | null
    raw_content: string
  }>('wk_sources', { space_id: `eq.${spaceId}`, order: 'content_hash.asc' })

  const reviews = await db.query<{
    id: string
    status: 'approved' | 'rejected'
    title: string
    reviewer: string | null
    review_channel: ReviewChannel | null
    reviewed_at: Date | string
    agent_meta: Record<string, unknown> | null
  }>(
    `SELECT id, status, title, reviewer, review_channel, reviewed_at, agent_meta
       FROM wk_change_proposals
      WHERE space_id = $1 AND status IN ('approved', 'rejected') AND reviewed_at IS NOT NULL
      ORDER BY reviewed_at DESC, id ASC`,
    [spaceId],
  )
  const proposalConcepts = await db.query<{ proposal_id: string; slug: string }>(
    `SELECT DISTINCT r.proposal_id, c.slug
       FROM wk_concept_revisions r
       JOIN wk_concepts c ON c.id = r.concept_id
      WHERE r.space_id = $1 AND r.proposal_id IS NOT NULL
      ORDER BY c.slug ASC`,
    [spaceId],
  )
  const slugsByProposal = new Map<string, string[]>()
  for (const row of proposalConcepts.rows) {
    const list = slugsByProposal.get(row.proposal_id) ?? []
    list.push(row.slug)
    slugsByProposal.set(row.proposal_id, list)
  }

  return {
    space: { slug: space.slug, name: space.name },
    concepts: concepts.rows.map((concept) => ({
      slug: concept.slug,
      title: concept.title,
      summary: concept.summary,
      markdown: concept.markdown,
      claims: claims.rows
        .filter((claim) => claim.concept_id === concept.id)
        .map((claim) => ({
          subject: claim.subject,
          predicate: claim.predicate,
          object: claim.object,
          status: claim.status,
          confidence: roundConfidence(Number(claim.confidence)),
          citations: citationsByClaim.get(claim.id) ?? [],
        })),
      relations: relations.rows
        .filter((relation) => relation.from_concept_id === concept.id)
        .map((relation) => ({ to: relation.to_slug, kind: relation.kind })),
    })),
    decisions: decisions.map((decision) => ({
      slug: decision.slug,
      title: decision.title,
      status: decision.status,
      context: decision.context,
      decision: decision.decision,
      rationale: decision.rationale,
      alternatives: Array.isArray(decision.alternatives) ? decision.alternatives : [],
    })),
    sources: sources.map((source) => ({
      content_hash: source.content_hash,
      kind: source.kind,
      url: source.url,
      title: source.title,
      content: source.raw_content,
    })),
    log: reviews.rows.map((review) => ({
      date: isoString(review.reviewed_at).slice(0, 10),
      action: review.status === 'approved' ? ('Approved' as const) : ('Rejected' as const),
      title: review.title,
      reviewer: review.reviewer,
      review_channel: review.review_channel,
      model: typeof review.agent_meta?.model === 'string' ? review.agent_meta.model : null,
      concepts: slugsByProposal.get(review.id) ?? [],
    })),
  }
}
