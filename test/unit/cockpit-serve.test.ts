// The cockpit's static plane: what /cockpit answers, and with which headers.
//
// These are the properties an operator's browser depends on and that nothing
// else in the repository states: the SPA fallback (so a client-side route is
// not a 404), the caching split (so a deploy is not invisible behind a cached
// index.html), the traversal guard (so the mount is not a file server for the
// whole disk), and the CSP — whose script-src hash is computed from the bytes
// being served, which is the only version of that header that cannot go stale.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { cockpitCsp, createCockpit, inlineScriptHashes, COCKPIT_PREFIX } from '../../src/cockpit.ts'
import { createLogger } from '../../src/logger.ts'

const SHELL = `<!doctype html><html lang="en"><head><script>var a=1</script></head><body></body></html>`

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wikikit-cockpit-'))
  writeFileSync(join(dir, 'index.html'), SHELL)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'main-abc123.js'), 'console.log(1)')
  return dir
}

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
}

/** A response that records nothing — for the loop that only cares about memory. */
function sink(): ServerResponse {
  return { writeHead: () => undefined, end: () => undefined } as unknown as ServerResponse
}

/** Drives the raw handler without a socket, the way the HTTP server does. */
function get(dir: string | undefined, url: string, headers: Record<string, string> = {}, method = 'GET'): Captured {
  const cockpit = createCockpit(
    { logger: createLogger({ level: 'error', write: () => {} }) },
    dir ? { dir } : { dir: join(tmpdir(), 'wikikit-cockpit-absent') },
  )
  const captured: Captured = { status: 0, headers: {}, body: '' }
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      captured.status = status
      for (const [name, value] of Object.entries(headers)) captured.headers[name.toLowerCase()] = String(value)
      return res
    },
    end(chunk?: Buffer | string) {
      if (chunk) captured.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    },
  } as unknown as ServerResponse
  cockpit.handler({ url, method, headers } as unknown as IncomingMessage, res)
  return captured
}

describe('serving the bundle', () => {
  test('a fingerprinted asset is immutable; the shell never is', () => {
    const dir = fixture()
    const asset = get(dir, `${COCKPIT_PREFIX}/assets/main-abc123.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(asset.headers['content-type']).toContain('application/javascript')

    // index.html is the only file that names the current bundle. A cached copy
    // pins a browser to a deploy that no longer exists.
    const shell = get(dir, `${COCKPIT_PREFIX}/`)
    expect(shell.headers['cache-control']).toBe('no-cache')
  })

  test('an unknown path under the prefix falls back to the shell — it is a client route', () => {
    const dir = fixture()
    const deep = get(dir, `${COCKPIT_PREFIX}/changes/2f8a1c00-0000-0000-0000-000000000000`)
    expect(deep.status).toBe(200)
    expect(deep.headers['content-type']).toContain('text/html')
    expect(deep.body).toBe(SHELL)
    // And it must not be cached as though it were that route's own document.
    expect(deep.headers['cache-control']).toBe('no-cache')
  })

  test('a traversal resolves outside the bundle and is refused, not served', () => {
    const dir = fixture()
    const escape = get(dir, `${COCKPIT_PREFIX}/../../../etc/passwd`)
    // Falls back to the shell rather than reading the target: the check is on
    // the NORMALISED path, so every encoding of ../ lands here.
    expect(escape.body).toBe(SHELL)
  })

  test('a sibling directory whose name merely STARTS with the bundle is not served', () => {
    // `startsWith(dir)` without a separator admitted `<assets>/cockpit-old`,
    // which is exactly what a rollback leaves next to `<assets>/cockpit`.
    // Escaping three levels up (above) never reached it; one level does.
    const dir = fixture()
    const sibling = `${dir}-old`
    mkdirSync(sibling)
    writeFileSync(join(sibling, 'leak.txt'), 'SECRET-SIBLING-CONTENT')

    for (const path of [
      `${COCKPIT_PREFIX}/../${basename(sibling)}/leak.txt`,
      `${COCKPIT_PREFIX}/x/../../${basename(sibling)}/leak.txt`,
    ]) {
      const escape = get(dir, path)
      expect(escape.body, path).toBe(SHELL)
      expect(escape.body, path).not.toContain('SECRET')
    }
  })

  test('a path naming an Object.prototype member is a client route, not a 500', () => {
    // EMBEDDED_COCKPIT is a plain object literal, so `EMBEDDED_COCKPIT['constructor']`
    // resolves an INHERITED function and Buffer.from(fn) throws — turning a
    // path any anonymous caller can request into a 500 with a stack trace,
    // repeatable forever. It must be what it looks like: an unknown path.
    const dir = fixture()
    for (const name of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      const answer = get(dir, `${COCKPIT_PREFIX}/${name}`)
      expect(answer.status, name).toBe(200)
      expect(answer.body, name).toBe(SHELL)
    }
  })

  test('an unknown path leaves nothing behind — a miss is not cached', () => {
    // This mount runs before auth. Caching misses keyed by the requested path
    // made every distinct `/cockpit/<random>` a permanent Map entry that
    // nothing evicts: unbounded memory an anonymous caller controls.
    const dir = fixture()
    const cockpit = createCockpit({ logger: createLogger({ level: 'error', write: () => {} }) }, { dir })
    const before = process.memoryUsage().heapUsed
    for (let index = 0; index < 20_000; index += 1) {
      cockpit.handler(
        { url: `${COCKPIT_PREFIX}/miss-${index}`, method: 'GET', headers: {} } as unknown as IncomingMessage,
        sink(),
      )
    }
    const grew = process.memoryUsage().heapUsed - before
    // 20k distinct absolute paths retained would be several MB; a few hundred
    // kB of ordinary churn is not what this is looking for.
    expect(grew).toBeLessThan(4 * 1024 * 1024)
  })

  test('answers 304 to a matching If-None-Match', () => {
    const dir = fixture()
    const first = get(dir, `${COCKPIT_PREFIX}/assets/main-abc123.js`)
    const etag = first.headers.etag!
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/)
    const second = get(dir, `${COCKPIT_PREFIX}/assets/main-abc123.js`, { 'if-none-match': etag })
    expect(second.status).toBe(304)
    expect(second.body).toBe('')
  })

  test('refuses every method but GET and HEAD', () => {
    const dir = fixture()
    const posted = get(dir, `${COCKPIT_PREFIX}/`, {}, 'POST')
    expect(posted.status).toBe(405)
    expect(posted.headers.allow).toBe('GET, HEAD')
  })

  test('says so plainly when no bundle was built into the deployment', () => {
    const missing = get(undefined, `${COCKPIT_PREFIX}/`)
    expect(missing.status).toBe(503)
    expect(missing.body).toContain('build:cockpit')
    // A 503 from this mount is still a response to a browser.
    expect(missing.headers['x-frame-options']).toBe('DENY')
    expect(missing.headers['content-security-policy']).toContain("default-src 'self'")
  })
})

describe('the content security policy', () => {
  test('admits the inline theme script by the hash of the bytes actually served', () => {
    const dir = fixture()
    const shell = get(dir, `${COCKPIT_PREFIX}/`)
    const expected = `sha256-${createHash('sha256').update('var a=1', 'utf8').digest('base64')}`
    expect(shell.headers['content-security-policy']).toContain(`'${expected}'`)
  })

  test("carries no 'unsafe-inline' in script-src — that is the directive that lets injected markup run", () => {
    const dir = fixture()
    const policy = get(dir, `${COCKPIT_PREFIX}/`).headers['content-security-policy']!
    const scriptSrc = policy.split('; ').find((directive) => directive.startsWith('script-src'))!
    expect(scriptSrc).not.toContain('unsafe-inline')
  })

  test('confines the console to its own origin', () => {
    // connect-src 'self' is what makes "no token in JavaScript" enforceable
    // rather than aspirational: a script that got hold of something would have
    // nowhere to send it.
    const policy = cockpitCsp()
    expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("base-uri 'none'")
    expect(policy).toContain("default-src 'self'")
  })

  test('hashes every inline script and ignores the ones with a src', () => {
    const hashes = inlineScriptHashes(
      '<script src="/cockpit/assets/main.js"></script><script>one()</script><script>two()</script>',
    )
    expect(hashes).toHaveLength(2)
    expect(hashes[0]).toBe(`sha256-${createHash('sha256').update('one()', 'utf8').digest('base64')}`)
  })
})

describe('the contract marker', () => {
  test('the built shell announces the digest of the token bytes it implements', () => {
    // CUI-MARK-1. Derived at build time from contract/cockpit-ui.css, never
    // hand-typed — a number somebody types cannot notice that the bytes
    // underneath it changed.
    const built = join(process.cwd(), 'assets', 'cockpit', 'index.html')
    let html: string
    try {
      html = readFileSync(built, 'utf8')
    } catch {
      throw new Error('assets/cockpit/index.html is missing — run `bun run build:cockpit`')
    }
    const digest = createHash('sha256')
      .update(readFileSync(join(process.cwd(), 'contract', 'cockpit-ui.css'), 'utf8'))
      .digest('hex')
      .slice(0, 12)
    expect(html).toContain('<meta name="cockpit-ui-contract" content="cockpit-ui" />')
    expect(html).toContain(`<meta name="cockpit-ui-digest" content="sha256-${digest}" />`)
  })
})
