// OKF v0.1 adapter — ALL Open Knowledge Format knowledge lives in this file
// (plan §15.1: spec fidelity is the top OKF risk, so the mitigation is
// containment: pin the spec, isolate the mapping, stamp every bundle).
//
// Written against the VENDORED spec at docs/okf-v0.1.md (retrieved 2026-07-15
// from GoogleCloudPlatform/knowledge-catalog). Section references below (§n)
// point into that document. If upstream moves, re-vendor the spec first and
// change this file second — never the other way around.
//
// Mapping decisions (WikiKit ↔ OKF):
//   * Concept → `type: Concept` document; summary → `description` (§4.1).
//   * Source  → `type: Source` under sources/<content_hash>.md; the source
//     URL rides in `resource` (§4.1: canonical URI of the underlying asset);
//     the body is the raw content verbatim — external material mirrored as a
//     first-class concept, the §8 "references/ subdirectory" pattern.
//   * Decision → `type: Decision` with a generated readable body (Context /
//     Decision / Rationale / Alternatives sections — §4.2 favors structural
//     markdown).
//   * Claims/relations have NO OKF equivalent, so they travel in a single
//     producer-defined frontmatter extension key `wikikit:` (§4.1
//     Extensions: producers MAY add keys, consumers SHOULD preserve unknown
//     keys) — lossless for WK↔WK exchange, invisible-but-harmless for
//     foreign consumers. The frontmatter is authoritative on import; bodies
//     are never re-parsed for structure.
//   * The manifest is the bundle-root index.md frontmatter block — per §11
//     the ONLY place index frontmatter is permitted — carrying `okf_version`
//     plus a generator stamp.
//
// Import is deliberately permissive (§9): unknown types become generic
// concepts, missing optional fields are defaulted, broken links tolerated.
// Only structurally corrupt input (unparseable YAML) is rejected — silently
// mis-importing knowledge would be worse than failing.
import { ValidationError } from '../domain/errors.ts'
import { extractTitle, parseFrontmatter, serializeFrontmatter } from '../markdown.ts'
import { VERSION } from '../version.ts'
import {
  claimsFromFrontmatter,
  claimsToFrontmatter,
  inlineLinkText,
  inlineText,
  normalizeSourceKind,
  relationsFromFrontmatter,
  slugFromPath,
  slugify,
  type BundleFile,
  type BundleFormatAdapter,
  type ImportedBundle,
  type ImportedSource,
  type SnapshotConcept,
  type SnapshotDecision,
  type SpaceSnapshot,
} from './markdown.ts'

/** The pinned spec version this adapter implements (docs/okf-v0.1.md §11). */
export const OKF_VERSION = '0.1'

/** Generator stamp written into every bundle manifest. */
export const OKF_GENERATOR = `wikikit/${VERSION}`

const RESERVED_FILENAMES = new Set(['index.md', 'log.md']) // §3.1

const str = (value: unknown): string | null => (typeof value === 'string' && value.length ? value : null)

// ---------------------------------------------------------------------------
// Serialization

function conceptToOkf(concept: SnapshotConcept): BundleFile {
  const wikikit: Record<string, unknown> = {}
  if (concept.claims.length) wikikit.claims = claimsToFrontmatter(concept.claims)
  if (concept.relations.length) {
    wikikit.relations = concept.relations.map((relation) => ({ to: relation.to, kind: relation.kind }))
  }
  const data: Record<string, unknown> = {
    type: 'Concept',
    title: concept.title,
    ...(concept.summary ? { description: concept.summary } : {}),
    ...(Object.keys(wikikit).length ? { wikikit } : {}),
  }
  return { path: `concepts/${concept.slug}.md`, content: serializeFrontmatter(data, concept.markdown) }
}

function decisionToOkf(decision: SnapshotDecision): BundleFile {
  const data: Record<string, unknown> = {
    type: 'Decision',
    title: decision.title,
    wikikit: {
      status: decision.status,
      context: decision.context,
      decision: decision.decision,
      ...(decision.rationale ? { rationale: decision.rationale } : {}),
      ...(decision.alternatives.length ? { alternatives: decision.alternatives } : {}),
    },
  }
  // Readable body DERIVED from the frontmatter fields (pure function → still
  // byte-stable). Import reads the frontmatter, never these sections.
  const body: string[] = ['# Context', '', decision.context, '', '# Decision', '', decision.decision]
  if (decision.rationale) body.push('', '# Rationale', '', decision.rationale)
  if (decision.alternatives.length) {
    body.push('', '# Alternatives', '')
    for (const alternative of decision.alternatives) {
      const alt = alternative as { option?: unknown; reason_rejected?: unknown }
      const option = str(alt?.option) ?? JSON.stringify(alternative)
      body.push(`- ${option}${str(alt?.reason_rejected) ? ` — rejected: ${str(alt.reason_rejected)}` : ''}`)
    }
  }
  body.push('')
  return { path: `decisions/${decision.slug}.md`, content: serializeFrontmatter(data, body.join('\n')) }
}

function sourceToOkf(source: SpaceSnapshot['sources'][number]): BundleFile {
  const data: Record<string, unknown> = {
    type: 'Source',
    ...(source.title ? { title: source.title } : {}),
    ...(source.url ? { resource: source.url } : {}),
    wikikit: { kind: source.kind },
  }
  return { path: `sources/${source.content_hash}.md`, content: serializeFrontmatter(data, source.content) }
}

// Root index.md: the manifest frontmatter (§11) + §6 progressive-disclosure
// sections (`* [Title](url) - description` bullet form, exactly as specified).
function renderOkfIndex(snapshot: SpaceSnapshot): string {
  const manifest: Record<string, unknown> = {
    okf_version: OKF_VERSION,
    generator: OKF_GENERATOR,
    space: snapshot.space.slug,
    title: snapshot.space.name,
  }
  const lines: string[] = []
  // Titles/summaries are unconstrained strings (zSynthesizeOutput places no
  // newline restriction on them) — inline them, or a multi-line summary would
  // split the bullet and fail our own index-structure conformance rule.
  if (snapshot.concepts.length) {
    lines.push('# Concepts', '')
    for (const concept of snapshot.concepts) {
      lines.push(
        `* [${inlineLinkText(concept.title)}](/concepts/${concept.slug}.md) - ${inlineText(concept.summary || concept.title)}`,
      )
    }
    lines.push('')
  }
  if (snapshot.decisions.length) {
    lines.push('# Decisions', '')
    for (const decision of snapshot.decisions) {
      lines.push(
        `* [${inlineLinkText(decision.title)}](/decisions/${decision.slug}.md) - ${inlineText(decision.title)}`,
      )
    }
    lines.push('')
  }
  if (snapshot.sources.length) {
    lines.push('# Sources', '')
    for (const source of snapshot.sources) {
      lines.push(
        `* [${inlineLinkText(source.title || source.content_hash)}](/sources/${source.content_hash}.md) - ${source.kind} source`,
      )
    }
    lines.push('')
  }
  // Heading-only body for an empty space: §6 index bodies are headings and
  // link bullets — a prose placeholder line would fail our own validator.
  if (!lines.length) lines.push('# Contents', '')
  return serializeFrontmatter(manifest, lines.join('\n'))
}

// log.md per §7: `## YYYY-MM-DD` date headings, newest first, bold-word
// bullet convention.
function renderOkfLog(snapshot: SpaceSnapshot): string {
  const lines: string[] = ['# Update Log']
  let currentDate = ''
  for (const entry of snapshot.log) {
    if (entry.date !== currentDate) {
      currentDate = entry.date
      lines.push('', `## ${entry.date}`, '')
    }
    const links = entry.concepts.map((slug) => `[${slug}](/concepts/${slug}.md)`).join(', ')
    const parts = [`* **${entry.action}**: ${entry.title}`]
    if (entry.reviewer) parts.push(`reviewer ${entry.reviewer}`)
    if (entry.review_channel) parts.push(`channel ${entry.review_channel}`)
    if (entry.model) parts.push(`model ${entry.model}`)
    if (links) parts.push(`concepts ${links}`)
    lines.push(parts.join(' — '))
  }
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Parsing (permissive consumption, §9)

interface ClassifiedDoc {
  file: BundleFile
  data: Record<string, unknown>
  body: string
  type: string
}

function parseDoc(file: BundleFile): ClassifiedDoc {
  const { data, content } = parseFrontmatter(file.content)
  return { file, data, body: content, type: (str(data.type) ?? '').toLowerCase() }
}

function okfConcept(doc: ClassifiedDoc): SnapshotConcept {
  const wikikit = (doc.data.wikikit ?? {}) as Record<string, unknown>
  return {
    slug: slugFromPath(doc.file.path, 'concepts/'),
    title: str(doc.data.title) ?? extractTitle(doc.body) ?? slugFromPath(doc.file.path, 'concepts/'),
    summary: str(doc.data.description) ?? '',
    markdown: doc.body,
    claims: claimsFromFrontmatter(wikikit.claims, doc.file.path),
    relations: relationsFromFrontmatter(wikikit.relations, doc.file.path),
  }
}

function okfDecision(doc: ClassifiedDoc): SnapshotDecision {
  const wikikit = (doc.data.wikikit ?? {}) as Record<string, unknown>
  const slug = slugFromPath(doc.file.path, 'decisions/')
  const decision = str(wikikit.decision) ?? str(doc.data.description) ?? doc.body.trim()
  if (!decision) throw new ValidationError(`${doc.file.path}: decision document has no decision text`)
  return {
    slug,
    title: str(doc.data.title) ?? slug,
    status: str(wikikit.status) ?? 'active',
    context: str(wikikit.context) ?? str(doc.data.description) ?? '(imported from OKF bundle)',
    decision,
    rationale: str(wikikit.rationale) ?? '',
    alternatives: Array.isArray(wikikit.alternatives) ? wikikit.alternatives : [],
  }
}

function okfSource(doc: ClassifiedDoc): ImportedSource {
  if (!doc.body) throw new ValidationError(`${doc.file.path}: source document has an empty body`)
  const wikikit = (doc.data.wikikit ?? {}) as Record<string, unknown>
  return {
    ref: doc.file.path.split('/').at(-1)!.replace(/\.md$/i, ''),
    kind: normalizeSourceKind(wikikit.kind),
    url: str(doc.data.resource),
    title: str(doc.data.title),
    content: doc.body,
  }
}

export const okfBundleFormat: BundleFormatAdapter = {
  format: 'okf',

  serialize(snapshot) {
    const files: BundleFile[] = [
      { path: 'index.md', content: renderOkfIndex(snapshot) },
      { path: 'log.md', content: renderOkfLog(snapshot) },
    ]
    for (const concept of [...snapshot.concepts].sort((a, b) => a.slug.localeCompare(b.slug))) {
      files.push(conceptToOkf(concept))
    }
    for (const decision of [...snapshot.decisions].sort((a, b) => a.slug.localeCompare(b.slug))) {
      files.push(decisionToOkf(decision))
    }
    for (const source of [...snapshot.sources].sort((a, b) => a.content_hash.localeCompare(b.content_hash))) {
      files.push(sourceToOkf(source))
    }
    return files
  },

  parse(files) {
    const bundle: ImportedBundle = { concepts: [], decisions: [], sources: [] }
    const seenConcepts = new Set<string>()
    for (const file of files) {
      if (!file.path.endsWith('.md')) continue
      const base = file.path.split('/').at(-1)!
      if (RESERVED_FILENAMES.has(base)) continue // §3.1 — never concept documents
      const doc = parseDoc(file)
      if (doc.type === 'decision') {
        bundle.decisions.push(okfDecision(doc))
      } else if (doc.type === 'source' || file.path.startsWith('sources/')) {
        bundle.sources.push(okfSource(doc))
      } else {
        // Everything else — including unknown and missing types — is a
        // generic concept (§9: consumers MUST tolerate unknown types).
        const concept = okfConcept(doc)
        // Foreign trees may slugify two paths onto one slug — first wins,
        // duplicates are dropped rather than clobbered.
        if (!seenConcepts.has(concept.slug)) {
          seenConcepts.add(concept.slug)
          bundle.concepts.push(concept)
        }
      }
    }
    return bundle
  },
}

// ---------------------------------------------------------------------------
// Conformance validation (spec §9) — used by the contract tests to prove
// every exported bundle is conformant, and reusable for diagnosing foreign
// bundles. Returns issues instead of throwing: conformance is a report, and
// the PERMISSIVE import path above must never depend on it.

export interface OkfIssue {
  path: string
  rule: string
  message: string
}

const DATE_HEADING = /^## (.+)$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function checkIndexStructure(file: BundleFile, isRoot: boolean, issues: OkfIssue[]): void {
  let body = file.content
  if (file.content.startsWith('---')) {
    if (!isRoot) {
      // §11: frontmatter in index.md is permitted ONLY at the bundle root.
      issues.push({
        path: file.path,
        rule: 'index-frontmatter',
        message: 'only the root index.md may carry frontmatter',
      })
    }
    try {
      const parsed = parseFrontmatter(file.content)
      body = parsed.content
      const version = parsed.data.okf_version
      if (version !== undefined && (typeof version !== 'string' || !/^\d+\.\d+$/.test(version))) {
        issues.push({ path: file.path, rule: 'okf-version', message: 'okf_version must be "<major>.<minor>"' })
      }
    } catch (error) {
      issues.push({ path: file.path, rule: 'frontmatter-parse', message: (error as Error).message })
      return
    }
  }
  // §6: sections of headings and link bullets. Lenient line check — prose
  // paragraphs are tolerated by consumers, but our own exports keep to the
  // specified structure, so the validator enforces it.
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('* ') || trimmed.startsWith('- ')) continue
    issues.push({ path: file.path, rule: 'index-structure', message: `unexpected index line: ${trimmed.slice(0, 60)}` })
    break
  }
}

function checkLogStructure(file: BundleFile, issues: OkfIssue[]): void {
  for (const line of file.content.split('\n')) {
    const heading = line.match(DATE_HEADING)
    if (heading && !ISO_DATE.test(heading[1]!)) {
      // §7: date headings MUST use ISO 8601 YYYY-MM-DD form.
      issues.push({ path: file.path, rule: 'log-date', message: `log date heading is not ISO 8601: ${heading[1]}` })
    }
  }
}

/**
 * Validate a bundle against the OKF v0.1 conformance rules (§9):
 *   1. every non-reserved .md file has a parseable YAML frontmatter block,
 *   2. with a non-empty `type`,
 *   3. reserved files (index.md, log.md) follow §6/§7 when present.
 */
export function checkOkfConformance(files: BundleFile[]): OkfIssue[] {
  const issues: OkfIssue[] = []
  for (const file of files) {
    if (!file.path.endsWith('.md')) continue
    const base = file.path.split('/').at(-1)!
    if (base === 'index.md') {
      checkIndexStructure(file, file.path === 'index.md', issues)
      continue
    }
    if (base === 'log.md') {
      checkLogStructure(file, issues)
      continue
    }
    if (!file.content.startsWith('---')) {
      issues.push({
        path: file.path,
        rule: 'frontmatter-required',
        message: 'concept document has no frontmatter block',
      })
      continue
    }
    let data: Record<string, unknown>
    try {
      data = parseFrontmatter(file.content).data
    } catch (error) {
      issues.push({ path: file.path, rule: 'frontmatter-parse', message: (error as Error).message })
      continue
    }
    if (!str(data.type)) {
      issues.push({ path: file.path, rule: 'type-required', message: 'frontmatter has no non-empty `type` field' })
    }
  }
  return issues
}

/** Read the manifest (root index.md frontmatter, §11) of a parsed bundle. */
export function readOkfManifest(files: BundleFile[]): { okf_version: string | null; generator: string | null } {
  const root = files.find((file) => file.path === 'index.md')
  if (!root || !root.content.startsWith('---')) return { okf_version: null, generator: null }
  try {
    const { data } = parseFrontmatter(root.content)
    return { okf_version: str(data.okf_version), generator: str(data.generator) }
  } catch {
    return { okf_version: null, generator: null }
  }
}

// Re-export for slugify-dependent tests without reaching into markdown.ts.
export { slugify }
