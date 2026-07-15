// Acquire — the first pipeline stage (plan §4.1): turn an IngestRequest into
// an archivable source: raw content verbatim + a normalized markdown
// projection.
//
// Kinds and their raw/markdown pairing (CONTRACTS §1.2):
//   markdown → raw = the submitted body, markdown = identical to raw. The
//              content hash is over what the author sent, byte for byte —
//              normalizing before hashing would make idempotency depend on
//              our formatter version instead of on the author's content.
//   text     → raw = the submitted body, markdown = identical (plain text IS
//              valid markdown; inventing structure would fabricate content).
//   url      → raw = the fetched HTTP body verbatim (the archive must prove
//              what the page said), markdown = rehype-parse + rehype-remark
//              projection of the readable content.
//
// WHY fetch is injectable: URL acquisition is the pipeline's only network
// dependency besides the LLM. Tests inject a stub fetch and the whole ingest
// path runs deterministic and offline (same DI reasoning as the FakeProvider).
import { z } from 'zod'
import type { Config } from '../config.ts'
import { extractTitle, htmlToMarkdown } from '../markdown.ts'
import { assertDeliverableUrl } from '../secrets.ts'

/**
 * The IngestRequest boundary schema (zod v4 at every boundary). Exactly one
 * of markdown|text|url — the same refinement as HTTP's zIngestRequest
 * (CONTRACTS §5.3), duplicated here because the pipeline re-validates the
 * job's stored `input` jsonb when the worker picks it up: the DB row could
 * have been written by an older binary, so the worker never trusts it blindly.
 */
export const zIngestInput = z
  .object({
    markdown: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    url: z.url().optional(),
    title: z.string().max(500).optional(),
  })
  .refine((value) => [value.markdown, value.text, value.url].filter(Boolean).length === 1, {
    message: 'exactly one of markdown|text|url is required',
  })

export type IngestInput = z.input<typeof zIngestInput>

export interface AcquiredSource {
  kind: 'markdown' | 'text' | 'url'
  url: string | null
  title: string | null
  /** Archived verbatim — the sha256 idempotency anchor is computed over this. */
  raw: string
  /** Normalized markdown projection (identical to raw except for kind='url' HTML). */
  markdown: string
}

/**
 * Worker-side acquisition failure (unreachable URL, non-2xx, oversized body).
 * Deliberately NOT a DomainError: by the time a URL is fetched the HTTP
 * request was already answered 202, so this never maps to a response status —
 * it becomes the job's `error: {code, message}` and a wikikit.ingest.failed
 * event.
 */
export class AcquireError extends Error {
  readonly code = 'acquire_failed' as const
  constructor(message: string) {
    super(message)
    this.name = 'AcquireError'
  }
}

export interface Acquirer {
  acquire(input: IngestInput): Promise<AcquiredSource>
}

const FETCH_TIMEOUT_MS = 30_000

// Redirects are followed MANUALLY so every hop passes the SSRF check — with
// redirect:'follow' a public URL could 302 into 169.254.169.254 and the guard
// on the original URL would never see it. Five hops covers every legitimate
// canonicalization chain (http→https→www→final) without letting a hostile
// server walk us in circles.
const MAX_REDIRECTS = 5

// Best-effort <title> extraction from raw HTML — rehype-remark drops <head>,
// so the page title must be read before projection.
function htmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return null
  const title = match[1]!.replace(/\s+/g, ' ').trim()
  return title.length > 0 ? title.slice(0, 500) : null
}

export function createAcquirer(config: Config, deps: { fetchImpl?: typeof fetch } = {}): Acquirer {
  const fetchImpl = deps.fetchImpl ?? fetch

  // SSRF gate per hop (CONTRACTS house rule; plan review lens: URL ingest AND
  // webhooks). Reuses the webhook validator: scheme + credentials always, and
  // in strict mode (production posture) DNS-resolve-and-block for private/
  // link-local/metadata targets. allowHttp:true because public http:// pages
  // are legitimate ingest sources — only the ADDRESS class is restricted.
  // WIKIKIT_WEBHOOK_ALLOW_PRIVATE is the one operator switch for "this
  // deployment may talk to private targets" — dev keeps localhost fixtures
  // working, production defaults strict. Wrapped into AcquireError because by
  // the time a URL is fetched the HTTP request was already answered 202 (see
  // AcquireError doc) — this becomes the job's error, never a response status.
  async function assertFetchable(url: string): Promise<void> {
    // http(s) only: file:, data: and friends would let a URL ingest read the
    // server's own filesystem — the classic SSRF-by-scheme hole. Checked
    // before the validator so the message names the scheme problem precisely.
    if (!/^https?:\/\//i.test(url)) throw new AcquireError(`unsupported URL scheme: ${url}`)
    try {
      await assertDeliverableUrl(url, { allowInsecure: config.webhookAllowPrivateTargets, allowHttp: true })
    } catch (error) {
      throw new AcquireError(`refusing to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function fetchUrl(url: string, providedTitle: string | undefined): Promise<AcquiredSource> {
    // Manual redirect walk: every hop — the original URL and each Location —
    // is re-validated, so a redirect can never smuggle the fetch into an
    // address the direct URL would have been refused for. (Residual DNS
    // rebinding window documented on assertDeliverableUrl.)
    let current = url
    let response: Response
    for (let hop = 0; ; hop++) {
      await assertFetchable(current)
      try {
        response = await fetchImpl(current, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { accept: 'text/html, text/markdown;q=0.9, text/plain;q=0.8' },
          redirect: 'manual',
        })
      } catch (error) {
        throw new AcquireError(`fetch failed for ${current}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (response.status < 300 || response.status >= 400) break
      const location = response.headers.get('location')
      if (!location) throw new AcquireError(`fetch failed for ${current}: HTTP ${response.status} without Location`)
      if (hop + 1 > MAX_REDIRECTS) throw new AcquireError(`too many redirects fetching ${url}`)
      try {
        current = new URL(location, current).toString()
      } catch {
        throw new AcquireError(`invalid redirect target from ${current}: ${location}`)
      }
    }
    if (!response.ok) throw new AcquireError(`fetch failed for ${current}: HTTP ${response.status}`)

    const raw = await response.text()
    // Same ceiling as the HTTP body limit: a URL must not smuggle in a payload
    // the direct-body path would have rejected with 413.
    if (Buffer.byteLength(raw, 'utf8') > config.maxBodyBytes) {
      throw new AcquireError(`fetched content exceeds WIKIKIT_MAX_BODY_BYTES (${config.maxBodyBytes})`)
    }
    if (raw.trim().length === 0) throw new AcquireError(`fetched content is empty: ${url}`)

    const contentType = response.headers.get('content-type') ?? ''
    // Markdown/plain responses pass through — running prose through the HTML
    // pipeline would mangle it. Anything else is treated as HTML: that is the
    // overwhelmingly common case, and rehype-parse is forgiving of tag soup.
    const isHtml = contentType.includes('html') || (!contentType.includes('markdown') && !contentType.includes('plain'))
    const markdown = isHtml ? htmlToMarkdown(raw) : raw
    if (markdown.trim().length === 0) throw new AcquireError(`no readable content extracted from ${url}`)

    return {
      kind: 'url',
      url,
      title: providedTitle ?? (isHtml ? htmlTitle(raw) : null) ?? extractTitle(markdown),
      raw,
      markdown,
    }
  }

  return {
    async acquire(args: IngestInput): Promise<AcquiredSource> {
      const input = zIngestInput.parse(args)

      if (input.url !== undefined) return fetchUrl(input.url, input.title)

      if (input.markdown !== undefined) {
        return {
          kind: 'markdown',
          url: null,
          // Title fallback probes the document itself (frontmatter title,
          // then first h1) — cheap, structural, no LLM.
          title: input.title ?? extractTitle(input.markdown),
          raw: input.markdown,
          markdown: input.markdown,
        }
      }

      // Plain text: no structural title probe — a leading '#' in prose is
      // prose, not a heading, so only the caller-provided title counts.
      return { kind: 'text', url: null, title: input.title ?? null, raw: input.text!, markdown: input.text! }
    },
  }
}
