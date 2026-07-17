// HTTP server lifecycle against a stubbed Db — request ids, auth gating
// (401 vs 403), zod 400s, body caps, ETag/304, drain behavior and the raw
// /mcp mount hook. Full DB-backed flows live in test/integration/http.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import { createApp, type App } from '../../src/app.ts'
import { hashApiKey } from '../../src/http/auth.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { createLogger } from '../../src/logger.ts'

const PEPPER = 'server-test-pepper'
const BOOTSTRAP = 'wk_test-bootstrap-key'
const READER_KEY = 'wk_test-reader-key-000000000000000000000000000'
const WRITER_KEY = 'wk_test-writer-key-000000000000000000000000000'

const SPACE = {
  id: '00000000-0000-0000-0000-00000000aaaa',
  slug: 'demo',
  name: 'Demo',
  settings: {},
  epoch: 7,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-02T00:00:00Z'),
}

const KEYS = [
  {
    id: '00000000-0000-0000-0000-00000000k001',
    name: 'reader',
    key_hash: hashApiKey(READER_KEY, PEPPER),
    scopes: ['knowledge:read'],
    space_id: null,
    revoked_at: null,
  },
  {
    id: '00000000-0000-0000-0000-00000000k002',
    name: 'writer',
    key_hash: hashApiKey(WRITER_KEY, PEPPER),
    scopes: ['knowledge:propose'],
    space_id: null,
    revoked_at: null,
  },
]

function stubDb(): Db {
  const db: Db = {
    async query() {
      return { rows: [], rowCount: 0 }
    },
    async tx(fn) {
      return fn(db)
    },
    async call() {
      return []
    },
    async emitEvent() {},
    async select(table: string, q: Record<string, unknown> = {}) {
      if (table === 'wk_api_keys') {
        const hash = String(q.key_hash ?? '').replace(/^eq\./, '')
        return KEYS.filter((k) => k.key_hash === hash) as never[]
      }
      if (table === 'wk_spaces') {
        if (q.slug !== undefined && q.slug !== `eq.${SPACE.slug}`) return []
        if (q.id !== undefined && q.id !== `eq.${SPACE.id}`) return []
        return [SPACE] as never[]
      }
      return []
    },
    async insert(_table, body) {
      const rows = Array.isArray(body) ? body : [body]
      return rows.map((row) => ({ id: '00000000-0000-0000-0000-00000000b001', ...row })) as never[]
    },
    async update() {
      return []
    },
    async remove() {},
  }
  return db
}

function testConfig(): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    databaseUrl: 'postgresql://stub',
    keyPepper: PEPPER,
    bootstrapApiKey: BOOTSTRAP,
    llmProvider: 'anthropic' as const,
    llmApiKey: '',
    llmApiKeyEnv: 'ANTHROPIC_API_KEY',
    anthropicBaseUrl: '',
    modelSynthesis: 'claude-sonnet-5',
    modelClassify: 'claude-haiku-4-5',
    modelAnswer: 'claude-sonnet-5',
    maxBodyBytes: 1024,
    maxIngestTokens: 100_000,
    ingestConcurrency: 1,
    ingestLeaseMs: 15 * 60 * 1000,
    ingestHeartbeatMs: 30_000,
    webhookPollMs: 60_000,
    webhookTimeoutMs: 1000,
    webhookMaxAttempts: 1,
    webhookCircuitThreshold: 5,
    webhookAllowPrivateTargets: true,
    trustProxy: false,
    mcpSessionTtlMs: 60_000,
    mcpMaxSessions: 10,
    logLevel: 'error',
    version: '1.2.3-test',
    llmConfigured: false,
  }
}

let app: App
let base: string

beforeAll(async () => {
  app = createApp(testConfig(), {
    database: { db: stubDb(), async close() {} },
    llm: createFakeProvider(),
    logger: createLogger({ level: 'error', write: () => {} }),
  })
  // Neutral probe path for the raw-mount MECHANISM: /mcp itself is now really
  // mounted by createApp (the composition-root wiring), so re-mounting it would
  // collide — that collision is exactly what the double-mount test below proves.
  app.mountRawHandler('/__raw_probe', async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('mcp-ok')
  })
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address() as { port: number }
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await app.close()
})

const auth = (key: string) => ({ authorization: `Bearer ${key}` })

describe('http server', () => {
  test('every response carries a 12-hex x-request-id', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{12}$/)
  })

  test('/ready serves the exact deploy-gate shape', async () => {
    const res = await fetch(`${base}/ready`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready', version: '1.2.3-test' })
  })

  test('unknown route → 404 envelope whose request_id matches the header', async () => {
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string; request_id: string }
    expect(body.code).toBe('not_found')
    expect(body.request_id).toBe(res.headers.get('x-request-id') ?? '(missing)')
  })

  test('missing key → 401 unauthorized; X-API-Key is accepted as an alternative', async () => {
    const bare = await fetch(`${base}/v1/spaces/demo`)
    expect(bare.status).toBe(401)
    expect(((await bare.json()) as { code: string }).code).toBe('unauthorized')

    const viaHeader = await fetch(`${base}/v1/spaces/demo`, { headers: { 'x-api-key': READER_KEY } })
    expect(viaHeader.status).toBe(200)
  })

  test('known key without the scope → 403 insufficient_scope (401 ≠ 403)', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/ingest`, {
      method: 'POST',
      headers: { ...auth(READER_KEY), 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# x' }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('insufficient_scope')
  })

  test('space read resolves the slug and serializes the space', async () => {
    const res = await fetch(`${base}/v1/spaces/demo`, { headers: auth(BOOTSTRAP) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.slug).toBe('demo')
    expect(body.epoch).toBe(7)
    expect(body.created_at).toBe('2026-01-01T00:00:00.000Z')
  })

  test('unknown space slug → 404 not_found', async () => {
    const res = await fetch(`${base}/v1/spaces/ghost`, { headers: auth(BOOTSTRAP) })
    expect(res.status).toBe(404)
  })

  test('concept list sets ETag from the space epoch and honors If-None-Match', async () => {
    const first = await fetch(`${base}/v1/spaces/demo/concepts`, { headers: auth(READER_KEY) })
    expect(first.status).toBe(200)
    expect(first.headers.get('etag')).toBe('"7"')
    expect(((await first.json()) as { epoch: number }).epoch).toBe(7)

    const second = await fetch(`${base}/v1/spaces/demo/concepts`, {
      headers: { ...auth(READER_KEY), 'if-none-match': '"7"' },
    })
    expect(second.status).toBe(304)

    const stale = await fetch(`${base}/v1/spaces/demo/concepts`, {
      headers: { ...auth(READER_KEY), 'if-none-match': '"6"' },
    })
    expect(stale.status).toBe(200)
  })

  test('query-string validation failure → 400 bad_request envelope', async () => {
    const res = await fetch(`${base}/v1/spaces/demo/search`, { headers: auth(READER_KEY) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe('bad_request')
    expect(body.error).toContain('q')
  })

  test('malformed JSON body → 400; oversized body → 413 body_too_large', async () => {
    const bad = await fetch(`${base}/v1/spaces/demo/query`, {
      method: 'POST',
      headers: auth(READER_KEY),
      body: '{nope',
    })
    expect(bad.status).toBe(400)

    const big = await fetch(`${base}/v1/spaces/demo/ingest`, {
      method: 'POST',
      headers: auth(WRITER_KEY),
      body: JSON.stringify({ markdown: 'x'.repeat(4096) }),
    }).catch(() => null)
    // Bun's fetch may surface the destroyed socket as an error OR deliver the
    // 413 depending on write timing — both prove the cap fired.
    if (big) {
      expect(big.status).toBe(413)
      expect(((await big.json()) as { code: string }).code).toBe('body_too_large')
    }
  })

  test('LLM route without a key → 503 llm_not_configured is NOT hit with FakeProvider (configured)', async () => {
    // FakeProvider reports configured:true; the stub db returns no search
    // hits, so the fake answers not_in_knowledge_base — proving /query flows
    // end-to-end through answerQuestion. (503 llm_not_configured is covered
    // by integration with a real Anthropic provider minus key.)
    const res = await fetch(`${base}/v1/spaces/demo/query`, {
      method: 'POST',
      headers: auth(READER_KEY),
      body: JSON.stringify({ question: 'anything?' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { not_in_knowledge_base: boolean }
    expect(body.not_in_knowledge_base).toBe(true)
  })

  test('a raw mount bypasses ROUTES and OpenAPI but shares the port', async () => {
    const res = await fetch(`${base}/__raw_probe`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('mcp-ok')

    // /mcp is a raw mount too (real, from createApp) and must never appear as a
    // documented REST path.
    const spec = (await (await fetch(`${base}/openapi.json`)).json()) as { paths: Record<string, unknown> }
    expect(Object.keys(spec.paths).some((p) => p.startsWith('/mcp'))).toBe(false)
  })

  test('openapi.json is served live with the running version', async () => {
    const res = await fetch(`${base}/openapi.json`)
    expect(res.status).toBe(200)
    const spec = (await res.json()) as { openapi: string; info: { version: string } }
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.version).toBe('1.2.3-test')
  })

  test('metrics expose request counters labeled by route template', async () => {
    const res = await fetch(`${base}/metrics`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('wikikit_http_requests_total')
    expect(text).toContain('route="/v1/spaces/{space}"')
  })

  test('llms.txt endpoints always answer 200 text/plain', async () => {
    for (const path of ['/llms.txt', '/llms-full.txt']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')
      expect((await res.text()).length).toBeGreaterThan(0)
    }
  })

  test('draining: probes stay up, API refuses with 503 draining, /ready flips', async () => {
    app.state.draining = true
    try {
      const api = await fetch(`${base}/v1/spaces/demo`, { headers: auth(READER_KEY) })
      expect(api.status).toBe(503)
      expect(((await api.json()) as { code: string }).code).toBe('draining')

      const ready = await fetch(`${base}/ready`)
      expect(ready.status).toBe(503)
      expect(await ready.json()).toEqual({ status: 'draining', version: '1.2.3-test' })

      expect((await fetch(`${base}/health`)).status).toBe(200)
    } finally {
      app.state.draining = false
    }
  })

  test('double raw mount on one path throws (composition bug, not runtime 500)', () => {
    expect(() => app.mountRawHandler('/mcp', async () => {})).toThrow('already mounted')
  })
})
