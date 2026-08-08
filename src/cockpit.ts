// The cockpit's static plane — the built SPA, served by the process itself.
//
// WHY WikiKit serves it and not a CDN: WikiKit is one process an operator runs
// next to the knowledge base it holds. A console that needs a second deployment
// is a console that is out of date on the day it matters, and a console on a
// different origin needs CORS, a bearer token in JavaScript and a second place
// to leak it from. Same origin, same process, same version — the bundle and the
// API it calls cannot disagree, because they ship as one artifact.
//
// Deliberately NOT authenticated. The bundle contains no knowledge: it renders a
// sign-in prompt the moment GET /v1/session answers `{session: null}`. Gating
// the shell would buy nothing and would cost the ability to load the console
// before a session exists — which is exactly when a reviewer needs it.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EMBEDDED_COCKPIT } from './cockpit-embedded.ts'
import type { Logger } from './logger.ts'

/**
 * Resolved from this module, never from the working directory: a compiled
 * binary unpacks its payload and starts from there, so a cwd-relative path
 * would only ever work when run from a checkout.
 */
const MODULE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const COCKPIT_DIR = join(MODULE_ROOT, 'assets', 'cockpit')
export const COCKPIT_PREFIX = '/cockpit'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

// Vite fingerprints every asset it emits, so those may be cached forever
// (CUI-MOUNT-2). index.html is the one unfingerprinted file and must never be:
// it is the only thing that names the current bundle, so a cached copy pins a
// browser to a deploy that no longer exists.
const IMMUTABLE = 'public, max-age=31536000, immutable'
const NEVER = 'no-cache'

/**
 * Stricter than anything else WikiKit serves. The console is entirely
 * first-party: it loads no font, no analytics and no CDN, and it talks to
 * exactly one origin — its own. `connect-src 'self'` is what makes the "no
 * token in JavaScript" promise enforceable rather than aspirational: even a
 * script that got hold of something would have nowhere to send it.
 *
 * script-src carries NO 'unsafe-inline'. The one inline block the console has
 * — the pre-paint theme script in index.html (CUI-THEME-3, CUI-MOUNT-4) — is
 * admitted by its sha256 hash, computed from the bytes actually being served.
 * 'unsafe-inline' would have kept CSP as a comment rather than a control: it is
 * precisely the directive that lets injected markup run.
 */
export function cockpitCsp(inlineScriptHashes: readonly string[] = []): string {
  const scriptSrc = ["script-src 'self'", ...inlineScriptHashes.map((hash) => `'${hash}'`)].join(' ')
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** The policy with no inline script admitted — the 503 shell serves no script at all. */
export const COCKPIT_CSP = cockpitCsp()

/**
 * The sha256-base64 CSP source for every inline `<script>` in a document.
 *
 * Computed from the SERVED bytes rather than declared at build time: a hash
 * that can drift from the file it authorises is a broken console one deploy
 * later, and this way the two cannot disagree.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = []
  for (const match of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    hashes.push(
      `sha256-${createHash('sha256')
        .update(match[1] ?? '', 'utf8')
        .digest('base64')}`,
    )
  }
  return hashes
}

interface Asset {
  body: Buffer
  etag: string
  contentType: string
}

export interface Cockpit {
  /** True when a bundle was built into this deployment. */
  available(): boolean
  /** Raw prefix handler — mounted outside ROUTES, so it stays off the OpenAPI surface (§5.2). */
  handler(req: IncomingMessage, res: ServerResponse): void
}

export interface CockpitOptions {
  /** Overridable so a test can serve a fixture tree instead of the real build. */
  dir?: string
}

function extensionOf(relativePath: string): string {
  const dot = relativePath.lastIndexOf('.')
  return dot < 0 ? '' : relativePath.slice(dot)
}

export function createCockpit(deps: { logger: Logger }, options: CockpitOptions = {}): Cockpit {
  const dir = options.dir ?? COCKPIT_DIR
  // Read once, keep forever: the bundle is immutable for the lifetime of the
  // process (it ships inside the artifact), so re-stat-ing on every request
  // would buy nothing but syscalls.
  //
  // Only HITS are cached. Caching misses too was the obvious symmetry and it
  // was wrong: this mount runs before auth, so every distinct
  // `/cockpit/<random>` an anonymous caller invents would add a permanent Map
  // entry keyed by its absolute path, with nothing to evict it — trading one
  // bounded syscall for unbounded memory somebody else controls. A miss costs
  // a stat on a path that is not there, which is what a stat is for.
  const cache = new Map<string, Asset>()

  function read(path: string, relativePath: string): Asset | null {
    const cached = cache.get(path)
    if (cached) return cached
    // On-disk first, embedded second. On disk is what a developer running
    // `bun run build:cockpit` sees without restarting; embedded is what a
    // compiled binary has, because a single-file binary has no assets/ next to
    // it. Same precedence as docs-embedded.ts, for the same reason.
    let body: Buffer | null = null
    try {
      if (statSync(path).isFile()) body = readFileSync(path)
    } catch {
      body = null
    }
    // `Object.hasOwn`, not a truthiness check: EMBEDDED_COCKPIT is a plain
    // object literal, so `EMBEDDED_COCKPIT['constructor']` resolves an
    // INHERITED function and `Buffer.from(fn, 'base64')` throws. That turned
    // `GET /cockpit/constructor` — a path any anonymous caller can request —
    // into a 500 with a stack trace in the error log, repeatable forever
    // because the throw happens before the miss is cached.
    let encoded: string | undefined
    if (!body && !options.dir && Object.hasOwn(EMBEDDED_COCKPIT, relativePath)) {
      encoded = EMBEDDED_COCKPIT[relativePath]
      if (typeof encoded === 'string') body = Buffer.from(encoded, 'base64')
    }
    if (!body) return null
    const asset: Asset = {
      body,
      // A content hash, not an mtime: two deploys of the same bundle must
      // produce the same ETag, and an mtime does not survive being unpacked
      // from a binary payload.
      etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`,
      contentType: TYPES[extensionOf(relativePath)] ?? 'application/octet-stream',
    }
    cache.set(path, asset)
    return asset
  }

  const index = () => read(join(dir, 'index.html'), 'index.html')

  // Derived once from the shell being served, then reused on every response —
  // hashing a 2 kB document per request would be a cost with no answer to it.
  let csp: string | null = null
  function policy(): string {
    if (csp === null) {
      const shell = index()
      csp = shell ? cockpitCsp(inlineScriptHashes(shell.body.toString('utf8'))) : COCKPIT_CSP
    }
    return csp
  }

  let warned = false

  return {
    available: () => Boolean(index()),

    handler(req, res) {
      const pathname = (req.url ?? '/').split('?')[0]!
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed\n')
        return
      }

      const shell = index()
      if (!shell) {
        if (!warned) {
          warned = true
          // Once per process, not once per request: a missing bundle is a
          // deploy mistake somebody has to see, and a line per asset request
          // would bury it.
          deps.logger.warn('cockpit.bundle_missing', { dir })
        }
        // Same security headers as a served page: a 503 from this mount is
        // still a response to a browser, and the headers that matter here are
        // the ones that matter on every other answer from it.
        res.writeHead(503, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': NEVER,
          'content-security-policy': COCKPIT_CSP,
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
        })
        res.end('the cockpit was not built into this deployment — run `bun run build:cockpit`\n')
        return
      }

      const relative = pathname.slice(COCKPIT_PREFIX.length).replace(/^\/+/, '')
      // normalize() collapses any ../ BEFORE the prefix check, so a traversal
      // attempt resolves outside the bundle directory and is rejected rather
      // than served. Checking the raw string for '..' instead would miss every
      // encoding of it.
      // `dir + sep`, not `dir`: a bare prefix check also admits a SIBLING
      // directory whose name starts with the bundle's — `/cockpit/../cockpit-old/x`
      // normalises to `<assets>/cockpit-old/x`, which `startsWith(<assets>/cockpit)`
      // happily accepts. Harmless in a compiled binary, which has no assets/ on
      // disk at all; not harmless next to whatever a rollback left behind.
      const target = normalize(join(dir, relative))
      const inside = target === dir || target.startsWith(`${dir}${sep}`)
      const asset = relative && inside ? read(target, relative) : null

      // The SPA fallback (CUI-MOUNT-3): /cockpit/changes/abc is a client route,
      // not a file. Anything that is not a real asset gets the shell, and the
      // router in the browser decides what it means.
      const entry = asset ?? shell
      const headers: Record<string, string> = {
        'content-type': entry.contentType,
        'cache-control': asset ? IMMUTABLE : NEVER,
        etag: entry.etag,
        'content-security-policy': policy(),
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      }

      if (req.headers['if-none-match'] === entry.etag) {
        res.writeHead(304, headers)
        res.end()
        return
      }

      res.writeHead(200, { ...headers, 'content-length': String(entry.body.length) })
      res.end(req.method === 'HEAD' ? undefined : entry.body)
    },
  }
}
