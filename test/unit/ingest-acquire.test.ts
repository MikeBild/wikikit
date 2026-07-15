// acquire.ts — markdown/text passthrough, URL fetch with HTML→markdown
// projection, and the failure modes that become job errors. Fully offline:
// fetch is injected (the same DI seam production uses).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from '../../src/config.ts'
import { AcquireError, createAcquirer, zIngestInput } from '../../src/ingest/acquire.ts'

const fixtures = join(dirname(dirname(fileURLToPath(import.meta.url))), 'fixtures', 'sources')
const articleHtml = readFileSync(join(fixtures, 'article.html'), 'utf8')
const noteMd = readFileSync(join(fixtures, 'note.md'), 'utf8')

// webhookAllowPrivateTargets:true = the dev posture (WIKIKIT_WEBHOOK_ALLOW_PRIVATE
// defaults to !production): the SSRF address block is off, so these tests stay
// fully offline (no DNS). The strict posture is exercised separately below with
// IP-literal URLs, which node's dns.lookup resolves without the network.
const config = { maxBodyBytes: 10 * 1024 * 1024, webhookAllowPrivateTargets: true } as Config
const strictConfig = { maxBodyBytes: 10 * 1024 * 1024, webhookAllowPrivateTargets: false } as Config

function stubFetch(body: string, init: { status?: number; contentType?: string } = {}): typeof fetch {
  return (async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: { 'content-type': init.contentType ?? 'text/html; charset=utf-8' },
    })) as unknown as typeof fetch
}

describe('zIngestInput', () => {
  test('accepts exactly one of markdown|text|url', () => {
    expect(zIngestInput.safeParse({ markdown: '# x' }).success).toBe(true)
    expect(zIngestInput.safeParse({ text: 'x' }).success).toBe(true)
    expect(zIngestInput.safeParse({ url: 'https://example.com/a' }).success).toBe(true)
  })

  test('rejects zero or multiple bodies and bad urls', () => {
    expect(zIngestInput.safeParse({}).success).toBe(false)
    expect(zIngestInput.safeParse({ markdown: '# x', text: 'y' }).success).toBe(false)
    expect(zIngestInput.safeParse({ url: 'not-a-url' }).success).toBe(false)
  })
})

describe('markdown passthrough', () => {
  test('raw and markdown are the submitted body, byte for byte', async () => {
    const acquirer = createAcquirer(config)
    const acquired = await acquirer.acquire({ markdown: noteMd })
    expect(acquired.kind).toBe('markdown')
    expect(acquired.raw).toBe(noteMd)
    expect(acquired.markdown).toBe(noteMd)
    expect(acquired.url).toBeNull()
  })

  test('title falls back to frontmatter, caller-provided title wins', async () => {
    const acquirer = createAcquirer(config)
    expect((await acquirer.acquire({ markdown: noteMd })).title).toBe('OKF Evaluation Note')
    expect((await acquirer.acquire({ markdown: noteMd, title: 'Custom' })).title).toBe('Custom')
    expect((await acquirer.acquire({ markdown: '# Heading Title\n\nbody' })).title).toBe('Heading Title')
    expect((await acquirer.acquire({ markdown: 'no structure at all' })).title).toBeNull()
  })
})

describe('text passthrough', () => {
  test('no structural title probing on plain text', async () => {
    const acquirer = createAcquirer(config)
    const acquired = await acquirer.acquire({ text: '# looks like a heading but is prose' })
    expect(acquired.kind).toBe('text')
    expect(acquired.title).toBeNull()
    expect(acquired.raw).toBe(acquired.markdown)
  })
})

describe('url acquisition', () => {
  test('archives the HTML verbatim and projects readable markdown', async () => {
    const acquirer = createAcquirer(config, { fetchImpl: stubFetch(articleHtml) })
    const acquired = await acquirer.acquire({ url: 'https://example.com/okf' })
    expect(acquired.kind).toBe('url')
    expect(acquired.url).toBe('https://example.com/okf')
    // raw = the page as fetched (the archive must prove what it said).
    expect(acquired.raw).toBe(articleHtml)
    // markdown = readable projection: headings survive, script/style do not.
    expect(acquired.markdown).toContain('# Open Knowledge Format')
    expect(acquired.markdown).toContain('## Status')
    expect(acquired.markdown).not.toContain('tracking pixel')
    expect(acquired.markdown).not.toContain('font-family')
    // <title> is read from the raw HTML (rehype-remark drops <head>).
    expect(acquired.title).toBe('Open Knowledge Format — Status Update')
  })

  test('markdown/plain content types pass through without HTML mangling', async () => {
    const acquirer = createAcquirer(config, { fetchImpl: stubFetch(noteMd, { contentType: 'text/markdown' }) })
    const acquired = await acquirer.acquire({ url: 'https://example.com/note.md' })
    expect(acquired.raw).toBe(noteMd)
    expect(acquired.markdown).toBe(noteMd)
    expect(acquired.title).toBe('OKF Evaluation Note')
  })

  test('non-2xx responses fail with acquire_failed', async () => {
    const acquirer = createAcquirer(config, { fetchImpl: stubFetch('gone', { status: 404 }) })
    const attempt = acquirer.acquire({ url: 'https://example.com/missing' })
    await expect(attempt).rejects.toBeInstanceOf(AcquireError)
    await attempt.catch((error) => expect((error as AcquireError).code).toBe('acquire_failed'))
  })

  test('network errors are wrapped, never leaked raw', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const acquirer = createAcquirer(config, { fetchImpl: failing })
    await expect(acquirer.acquire({ url: 'https://example.com/x' })).rejects.toThrow('fetch failed')
  })

  test('rejects non-http(s) schemes (SSRF-by-scheme guard)', async () => {
    const acquirer = createAcquirer(config, { fetchImpl: stubFetch(articleHtml) })
    // zod's z.url() accepts any scheme — the acquirer enforces http(s) itself.
    await expect(acquirer.acquire({ url: 'file:///etc/passwd' })).rejects.toThrow('unsupported URL scheme')
  })

  test('enforces the body-size ceiling on fetched content', async () => {
    const tiny = { maxBodyBytes: 64 } as Config
    const acquirer = createAcquirer(tiny, { fetchImpl: stubFetch(articleHtml) })
    await expect(acquirer.acquire({ url: 'https://example.com/big' })).rejects.toThrow('WIKIKIT_MAX_BODY_BYTES')
  })

  test('empty fetched bodies fail instead of archiving nothing', async () => {
    const acquirer = createAcquirer(config, { fetchImpl: stubFetch('   ') })
    await expect(acquirer.acquire({ url: 'https://example.com/empty' })).rejects.toThrow('empty')
  })
})

describe('url acquisition — SSRF guard (strict posture)', () => {
  // IP-literal hosts keep these offline: dns.lookup of a literal returns the
  // literal itself, so the block table is exercised without any network.
  test('refuses loopback, RFC1918 and cloud-metadata targets before fetching', async () => {
    let fetched = 0
    const counting = (async () => {
      fetched += 1
      return new Response('x')
    }) as unknown as typeof fetch
    const acquirer = createAcquirer(strictConfig, { fetchImpl: counting })
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:5432/',
      'https://10.0.0.8/internal',
      'https://192.168.1.1/admin',
    ]) {
      const attempt = acquirer.acquire({ url })
      await expect(attempt).rejects.toBeInstanceOf(AcquireError)
      await attempt.catch((error) => expect((error as Error).message).toContain('disallowed'))
    }
    expect(fetched).toBe(0) // rejected BEFORE any bytes leave the process
  })

  test('public http:// pages remain ingestable in strict mode (only the address class is blocked)', async () => {
    const acquirer = createAcquirer(strictConfig, { fetchImpl: stubFetch(noteMd, { contentType: 'text/markdown' }) })
    const acquired = await acquirer.acquire({ url: 'http://8.8.8.8/note.md' })
    expect(acquired.kind).toBe('url')
    expect(acquired.raw).toBe(noteMd)
  })

  test('a redirect hop into a private address is refused (redirects are walked manually)', async () => {
    const seen: string[] = []
    const redirecting = (async (input: unknown) => {
      seen.push(String(input))
      if (seen.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })
      }
      return new Response('should never be reached')
    }) as unknown as typeof fetch
    const acquirer = createAcquirer(strictConfig, { fetchImpl: redirecting })
    const attempt = acquirer.acquire({ url: 'https://8.8.8.8/article' })
    await expect(attempt).rejects.toBeInstanceOf(AcquireError)
    await attempt.catch((error) => expect((error as Error).message).toContain('disallowed'))
    expect(seen).toEqual(['https://8.8.8.8/article']) // the private hop was never fetched
  })

  test('legitimate redirects are followed with per-hop validation (relative Location resolved)', async () => {
    const seen: string[] = []
    const redirecting = (async (input: unknown) => {
      seen.push(String(input))
      if (seen.length === 1) return new Response(null, { status: 301, headers: { location: '/moved.md' } })
      return new Response(noteMd, { status: 200, headers: { 'content-type': 'text/markdown' } })
    }) as unknown as typeof fetch
    const acquirer = createAcquirer(strictConfig, { fetchImpl: redirecting })
    const acquired = await acquirer.acquire({ url: 'https://8.8.8.8/old.md' })
    expect(seen).toEqual(['https://8.8.8.8/old.md', 'https://8.8.8.8/moved.md'])
    expect(acquired.raw).toBe(noteMd)
    // The archived url is what the CALLER submitted, not the final hop.
    expect(acquired.url).toBe('https://8.8.8.8/old.md')
  })

  test('redirect loops are cut off instead of walked forever', async () => {
    const looping = (async (input: unknown) =>
      new Response(null, { status: 302, headers: { location: String(input) } })) as unknown as typeof fetch
    const acquirer = createAcquirer(strictConfig, { fetchImpl: looping })
    await expect(acquirer.acquire({ url: 'https://8.8.8.8/loop' })).rejects.toThrow('too many redirects')
  })
})
