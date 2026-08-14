// Vault-mirror bundle format (`obsidian`) — serialize-only.
//
// WHY a third format when `md` already exists: the difference is not syntax
// but PACKAGE CONTENT. `md` is the round-trip format — it must stay
// re-importable, so it carries `sources/` (which would mirror a user's own
// notes back at them) and `log.md` (whose bytes change with every review).
// A vault mirror must be the opposite: a pure function of the APPROVED
// knowledge only, byte-stable until the knowledge itself changes, with the
// provenance marker guaranteed server-side on every file.
//
// The contract this format serves (provenance loop-guard):
//   * every emitted file carries `wikikit: {space, kind, slug}` as the FIRST
//     frontmatter key — the marker hasWikiKitProvenance() probes and the
//     ingest guard refuses, so mirrored files can never round back in;
//   * no `sources/`, no `log.md` — nothing derived from raw archives or
//     local review history ships to a vault;
//   * frontmatter stays flat scalars beside the marker (title, summary,
//     status) so it renders cleanly as note properties.
//
// parse() throws: a mirror is a projection, not an interchange bundle. The
// import path never learns this format (import.ts keeps its own md|okf enum),
// and this adapter refuses defensively should anyone route bytes here.
import { ValidationError } from '../domain/errors.ts'
import { serializeFrontmatter } from '../markdown.ts'
import {
  inlineText,
  type BundleFile,
  type BundleFormatAdapter,
  type SnapshotConcept,
  type SnapshotDecision,
  type SpaceSnapshot,
} from './markdown.ts'

const str = (value: unknown): string | null => (typeof value === 'string' && value.length ? value : null)

/** The provenance marker — ALWAYS the first frontmatter key (see header). */
function marker(space: string, kind: 'index' | 'concept' | 'decision', slug?: string): Record<string, unknown> {
  return { wikikit: { space, kind, ...(slug ? { slug } : {}) } }
}

function conceptToVault(space: string, concept: SnapshotConcept): BundleFile {
  const data: Record<string, unknown> = {
    ...marker(space, 'concept', concept.slug),
    title: concept.title,
    ...(concept.summary ? { summary: concept.summary } : {}),
  }
  // Relations become a trailing `## Related` section of [[slug]] links —
  // the graph travels as links (what a vault resolves), not as frontmatter
  // structure (which nothing in a vault consumes). Deduplicated: a concept
  // may relate to the same target under several kinds, but one link suffices.
  let body = concept.markdown
  const related = [...new Set(concept.relations.map((relation) => relation.to))]
  if (related.length) {
    body = `${body.trimEnd()}\n\n## Related\n\n${related.map((to) => `- [[${to}]]`).join('\n')}\n`
  }
  return { path: `concepts/${concept.slug}.md`, content: serializeFrontmatter(data, body) }
}

function decisionToVault(space: string, decision: SnapshotDecision): BundleFile {
  const data: Record<string, unknown> = {
    ...marker(space, 'decision', decision.slug),
    title: decision.title,
    status: decision.status,
  }
  // Readable body derived from the decision fields (pure function → still
  // byte-stable). Deliberately NOT shared with other formats: each format
  // owns its rendering, so one cannot drift the other's bytes.
  const body: string[] = ['## Context', '', decision.context, '', '## Decision', '', decision.decision]
  if (decision.rationale) body.push('', '## Rationale', '', decision.rationale)
  if (decision.alternatives.length) {
    body.push('', '## Alternatives', '')
    for (const alternative of decision.alternatives) {
      const alt = alternative as { option?: unknown; reason_rejected?: unknown }
      const option = str(alt?.option) ?? JSON.stringify(alternative)
      body.push(`- ${option}${str(alt?.reason_rejected) ? ` — rejected: ${str(alt.reason_rejected)}` : ''}`)
    }
  }
  body.push('')
  return { path: `decisions/${decision.slug}.md`, content: serializeFrontmatter(data, body.join('\n')) }
}

/** TOC of [[slug]] links — concepts and decisions only (see header). */
function renderVaultIndex(snapshot: SpaceSnapshot, concepts: SnapshotConcept[], decisions: SnapshotDecision[]): string {
  const lines: string[] = [`# ${inlineText(snapshot.space.name)}`]
  if (concepts.length) {
    lines.push('', '## Concepts', '')
    for (const concept of concepts) {
      lines.push(`- [[${concept.slug}]] — ${inlineText(concept.summary || concept.title)}`)
    }
  }
  if (decisions.length) {
    lines.push('', '## Decisions', '')
    for (const decision of decisions) lines.push(`- [[${decision.slug}]] — ${inlineText(decision.title)}`)
  }
  lines.push('')
  return serializeFrontmatter(marker(snapshot.space.slug, 'index'), lines.join('\n'))
}

export const obsidianBundleFormat: BundleFormatAdapter = {
  format: 'obsidian',

  serialize(snapshot) {
    const concepts = [...snapshot.concepts].sort((a, b) => a.slug.localeCompare(b.slug))
    const decisions = [...snapshot.decisions].sort((a, b) => a.slug.localeCompare(b.slug))
    const files: BundleFile[] = [{ path: 'index.md', content: renderVaultIndex(snapshot, concepts, decisions) }]
    for (const concept of concepts) files.push(conceptToVault(snapshot.space.slug, concept))
    for (const decision of decisions) files.push(decisionToVault(snapshot.space.slug, decision))
    return files
  },

  parse() {
    throw new ValidationError('obsidian bundles are export-only — import md or okf bundles instead')
  },
}
