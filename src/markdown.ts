// Markdown utilities — the unified/remark frontmatter pipeline (ContentKit's
// markdown.mjs pattern, trimmed to WikiKit's needs).
//
// WikiKit's markdown roles and who uses which helper:
//   * parseFrontmatter / serializeFrontmatter — the lossless round-trip that
//     lets exports carry structured claims in frontmatter and re-import them
//     byte-stably (plan §9: export → wipe → import → export must be stable).
//   * normalizeMarkdown — one canonical formatting for stored markdown, so
//     sha256 content-hash idempotency is about CONTENT, not about whether an
//     author typed `*` or `-` bullets.
//   * htmlToMarkdown — the URL-ingest projection (HTML page → archived
//     markdown) used by ingest/acquire.
//   * extractWikiLinks / extractTitle — cheap structural probes ([[slug]]
//     graph hints, title fallback) that must not require an LLM.
//
// WHY frontmatter is parsed with a pinned regex + the yaml package instead of
// walking the remark AST: the parse must produce the EXACT SAME `content`
// string that serializeFrontmatter would re-wrap (round-trip contract), and
// remark-stringify would reformat the body. The remark pipeline is used only
// where reformatting is the point (normalizeMarkdown) or unavoidable
// (htmlToMarkdown).
import rehypeParse from 'rehype-parse'
import rehypeRemark from 'rehype-remark'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { ValidationError } from './domain/errors.ts'

export interface ParsedMarkdown {
  /** Frontmatter as a plain object — {} when the document has none. */
  data: Record<string, unknown>
  /** The body EXACTLY as authored (byte-stable round-trip anchor). */
  content: string
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/**
 * Split a document into YAML frontmatter and body. Documents without a
 * leading `---` fence parse as { data: {}, content: unchanged }. Malformed
 * YAML or a non-object frontmatter is a ValidationError — silently dropping
 * structured claims on import would corrupt knowledge.
 */
export function parseFrontmatter(markdown: string): ParsedMarkdown {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) {
    return { data: {}, content: markdown }
  }
  const match = markdown.match(FRONTMATTER_PATTERN)
  if (!match) throw new ValidationError('frontmatter is not terminated with ---')
  let data: unknown
  try {
    // maxAliasCount guards against YAML alias amplification (billion laughs).
    data = parseYaml(match[1]!, { maxAliasCount: 20 }) ?? {}
  } catch (error) {
    throw new ValidationError(`invalid YAML frontmatter: ${(error as Error).message}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ValidationError('frontmatter must be a YAML object')
  }
  return { data: data as Record<string, unknown>, content: markdown.slice(match[0].length) }
}

/**
 * Re-wrap a body with YAML frontmatter. Inverse of parseFrontmatter:
 * parse(serialize(data, content)).content === content, and empty data emits
 * no fence at all (a document without metadata stays fence-free).
 */
export function serializeFrontmatter(data: Record<string, unknown>, content: string): string {
  if (!Object.keys(data).length) return content
  // Exactly `---\n` after the fence — parseFrontmatter consumes precisely
  // that, so parse ∘ serialize is the identity on content (byte-stable
  // round-trip). yaml.stringify ends with exactly one newline; deterministic
  // key order is the caller's job (exports sort their claim lists first).
  return `---\n${stringifyYaml(data)}---\n${content}`
}

// Pinned stringify style — THE canonical WikiKit markdown formatting. Chosen
// once and frozen: changing any of these reformats every normalized document
// and breaks content-hash stability across versions.
const STRINGIFY_OPTIONS = {
  bullet: '-',
  emphasis: '*',
  strong: '*',
  fence: '`',
  fences: true,
  rule: '-',
  listItemIndent: 'one',
} as const

const normalizer = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkStringify, STRINGIFY_OPTIONS)

/**
 * Canonicalize markdown formatting (bullets, emphasis markers, spacing) while
 * preserving frontmatter verbatim as a yaml node. Idempotent:
 * normalize(normalize(x)) === normalize(x) — required, because normalized
 * output is what gets content-hashed.
 */
export function normalizeMarkdown(markdown: string): string {
  return String(normalizer.processSync(markdown))
}

const htmlPipeline = unified().use(rehypeParse).use(rehypeRemark).use(remarkGfm).use(remarkStringify, STRINGIFY_OPTIONS)

/**
 * Project an HTML page to markdown (URL ingest). rehype-remark drops what has
 * no markdown equivalent (scripts, styles, layout wrappers) — exactly right
 * for archiving the READABLE content of a page.
 */
export function htmlToMarkdown(html: string): string {
  return String(htmlPipeline.processSync(html)).trim()
}

const WIKI_LINK_PATTERN = /\[\[([a-z0-9][a-z0-9-]{0,126})\]\]/g

/**
 * Collect [[slug]] wiki links (Obsidian-compatible, plan §9), deduplicated in
 * first-appearance order. Only well-formed concept slugs match — [[Not A
 * Slug]] is prose, not a link.
 */
export function extractWikiLinks(markdown: string): string[] {
  const seen = new Set<string>()
  for (const match of markdown.matchAll(WIKI_LINK_PATTERN)) seen.add(match[1]!)
  return [...seen]
}

/**
 * Best-effort title: frontmatter `title` first, then the first ATX h1 in the
 * body, else null. Used by ingest to name sources when the caller sent none.
 */
export function extractTitle(markdown: string): string | null {
  const parsed = parseFrontmatter(markdown)
  const fromFrontmatter = parsed.data.title
  if (typeof fromFrontmatter === 'string' && fromFrontmatter.trim()) return fromFrontmatter.trim()
  const heading = parsed.content.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m)
  return heading ? heading[1]!.trim() : null
}
