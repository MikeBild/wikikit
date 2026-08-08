// Drain behaviour of the RAW mounts — the plane that sits ahead of the ROUTES
// drain gate and therefore has to answer or refuse on its own (src/app.ts
// declares the policy, src/http/server.ts applies it).
//
// Driven through a real createApp and a real close(): close() is what flips
// `state.draining`, and it is also what removes the socket, so these tests go
// in through `app.handle` — the in-process entry that exists for exactly this.
// Setting `state.draining = true` by hand would test the gate without testing
// the shutdown path that turns it on.
import { describe, expect, test } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApp, type App } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import { createLogger } from '../../src/logger.ts'
import { createMetrics, type Metrics } from '../../src/metrics.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'

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
    async select() {
      return []
    },
    async insert() {
      return []
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
    keyPepper: 'drain-test-pepper',
    bootstrapApiKey: 'wk_test-bootstrap-key',
    environment: 'test',
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

interface MetricCall {
  method: string
  route: string
  status: number
}

/** The real metrics, with every httpRequest label recorded for assertion. */
function recordingMetrics(): { metrics: Metrics; calls: MetricCall[] } {
  const calls: MetricCall[] = []
  const base = createMetrics()
  return {
    calls,
    metrics: {
      ...base,
      httpRequest(method, route, status, durationMs) {
        calls.push({ method, route, status })
        base.httpRequest(method, route, status, durationMs)
      },
    },
  }
}

function makeApp(): { app: App; calls: MetricCall[] } {
  const { metrics, calls } = recordingMetrics()
  const app = createApp(testConfig(), {
    database: { db: stubDb(), async close() {} },
    llm: createFakeProvider(),
    logger: createLogger({ level: 'error', write: () => {} }),
    metrics,
  })
  return { app, calls }
}

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * One request through the real listener without a socket. Bodies are always
 * empty here — every case under test is decided before any handler reads one —
 * so the readers' `data`/`end` registration is answered with an immediate end.
 */
async function call(app: App, method: string, url: string, headers: Record<string, string> = {}): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: '' }
  const finished: Array<() => void> = []
  const req: IncomingMessage = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event: string, listener: () => void) {
      if (event === 'end') listener()
      return req
    },
    destroy() {},
  } as unknown as IncomingMessage
  // node's own `headersSent` is read-only, so the mock exposes it the same way
  // — a getter over the flag writeHead sets. The error path in handle() reads
  // it to decide between an envelope and a bare end().
  let headersSent = false
  const res: ServerResponse = {
    statusCode: 200,
    get headersSent() {
      return headersSent
    },
    writable: true,
    setHeader(name: string, value: string | string[]) {
      captured.headers[name.toLowerCase()] = Array.isArray(value) ? value.join('\n') : String(value)
    },
    getHeader(name: string) {
      return captured.headers[name.toLowerCase()]
    },
    writeHead(status: number, extra: Record<string, string> = {}) {
      res.statusCode = status
      headersSent = true
      for (const [name, value] of Object.entries(extra)) captured.headers[name.toLowerCase()] = String(value)
      return res
    },
    write(chunk: Buffer | string) {
      captured.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      return true
    },
    end(chunk?: Buffer | string) {
      if (chunk) captured.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      captured.status = res.statusCode
      for (const listener of finished) listener()
      return res
    },
    on(event: string, listener: () => void) {
      if (event === 'finish') finished.push(listener)
      return res
    },
    once() {
      return res
    },
  } as unknown as ServerResponse
  await app.handle(req, res)
  return captured
}

/** Paths whose caller is a program and whose refusal it can act on. */
const MACHINE_CREDENTIAL_PLANE: Array<[string, string]> = [
  ['GET', '/.well-known/oauth-protected-resource'],
  ['GET', '/.well-known/oauth-protected-resource/mcp'],
  ['GET', '/.well-known/oauth-authorization-server'],
  ['GET', '/v1/identity/providers'],
  ['POST', '/v1/identity/sessions'],
  ['POST', '/v1/oauth/register'],
  ['POST', '/v1/oauth/token'],
  ['POST', '/v1/oauth/revoke'],
]

describe('the raw mounts while the process drains', () => {
  test('/mcp refuses in JSON-RPC, on every method, with a 503 for the load balancer', async () => {
    const { app } = makeApp()
    const before = await call(app, 'POST', '/mcp', { 'content-type': 'application/json' })
    // Whatever the transport answers an unhandshaken POST, it is not a refusal.
    expect(before.status).not.toBe(503)

    await app.close()

    for (const method of ['POST', 'GET', 'DELETE']) {
      const res = await call(app, method, '/mcp')
      expect(res.status, method).toBe(503)
      expect(res.headers['content-type'], method).toContain('application/json')
      // The frame an MCP client can read. A bare HTTP envelope here is a parse
      // error at the client, which reads as "broken", not as "retry".
      expect(JSON.parse(res.body), method).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'server is draining — re-run initialize against another instance' },
        id: null,
      })
    }
  })

  test('the machine credential plane refuses with the ordinary draining envelope', async () => {
    const { app } = makeApp()
    await app.close()

    for (const [method, path] of MACHINE_CREDENTIAL_PLANE) {
      const res = await call(app, method, path)
      expect(res.status, path).toBe(503)
      const body = JSON.parse(res.body) as { code: string; error: string; request_id: string }
      expect(body.code, path).toBe('draining')
      // Same envelope, same correlation key as a refused REST route.
      expect(body.request_id, path).toBe(res.headers['x-request-id'] ?? '(missing)')
    }
  })

  test('the human sign-in funnel and the console keep answering, unchanged', async () => {
    const { app } = makeApp()
    const consoleBefore = await call(app, 'GET', '/cockpit/')
    const sessionBefore = await call(app, 'GET', '/v1/session')
    expect(sessionBefore.status).toBe(200)
    expect(JSON.parse(sessionBefore.body)).toEqual({ session: null })

    await app.close()

    // The whoami the console reads before it renders anything: a drained
    // instance still says "nobody is signed in" rather than nothing at all.
    const sessionAfter = await call(app, 'GET', '/v1/session')
    expect(sessionAfter.status).toBe(sessionBefore.status)
    expect(sessionAfter.body).toBe(sessionBefore.body)

    // The console itself — byte-identical to what it served a moment earlier,
    // whether this build carries a bundle or answers its own "not built" 503.
    const consoleAfter = await call(app, 'GET', '/cockpit/')
    expect(consoleAfter.status).toBe(consoleBefore.status)
    expect(consoleAfter.body).toBe(consoleBefore.body)
    expect(consoleAfter.body).not.toContain('"code":"draining"')

    // The rest of the funnel a browser walks through mid-sign-in. Each answers
    // something of its own — a redirect, a chooser page, a funnel error — and
    // the assertion that matters is only that none of them is the refusal.
    for (const [method, path] of [
      ['GET', '/v1/identity/cockpit-login'],
      ['GET', '/v1/identity/login/start'],
      ['GET', '/v1/identity/login/callback'],
      ['POST', '/v1/identity/logout'],
      ['GET', '/v1/oauth/authorize'],
      ['POST', '/v1/oauth/authorize/decision'],
    ] as Array<[string, string]>) {
      const res = await call(app, method, path)
      expect(res.status, path).not.toBe(503)
    }
  })

  test('a matched REST route still refuses, and the probes still answer', async () => {
    const { app } = makeApp()
    await app.close()

    const api = await call(app, 'GET', '/v1/spaces/demo')
    expect(api.status).toBe(503)
    expect((JSON.parse(api.body) as { code: string }).code).toBe('draining')

    expect((await call(app, 'GET', '/health')).status).toBe(200)
    const ready = await call(app, 'GET', '/ready')
    expect(ready.status).toBe(503)
    expect(JSON.parse(ready.body)).toEqual({ status: 'draining', version: '1.2.3-test' })
  })

  test('a drain refusal is attributable in the metrics; an unknown path is deliberately not', async () => {
    const { app, calls } = makeApp()
    const missBefore = await call(app, 'GET', '/nope')
    expect(missBefore.status).toBe(404)

    await app.close()

    await call(app, 'POST', '/mcp')
    await call(app, 'POST', '/v1/oauth/token')
    await call(app, 'GET', '/v1/spaces/demo')
    const missAfter = await call(app, 'GET', '/nope')

    // Each refusing mount is counted under its OWN label at 503, so "how much
    // did this instance turn away while draining" is a question /metrics can
    // answer per plane.
    expect(calls).toContainEqual({ method: 'POST', route: '/mcp', status: 503 })
    expect(calls).toContainEqual({ method: 'POST', route: '/v1/oauth/token', status: 503 })
    expect(calls).toContainEqual({ method: 'GET', route: '/v1/spaces/{space}', status: 503 })

    // And an unknown path is the same event draining or not — nothing was
    // refused, so nothing new appears. A reader after drain volume reads the
    // 503 series above, never a delta in this bucket.
    expect(missAfter.status).toBe(404)
    expect(calls.filter((entry) => entry.route === '(unmatched)')).toEqual([
      { method: 'GET', route: '(unmatched)', status: 404 },
      { method: 'GET', route: '(unmatched)', status: 404 },
    ])
  })

  test('the metrics label is the one dispatch decided with, not a second reading of req.url', async () => {
    const { app, calls } = makeApp()
    // A proxy may send the absolute-form request line, and a path may carry dot
    // segments. `new URL(...)` resolves both; the split the finish hook used to
    // do resolves neither, so these were served as one route and counted as
    // another.
    await call(app, 'GET', 'http://internal.example/v1/spaces/demo')
    await call(app, 'GET', '/v1/spaces/../spaces/demo')
    await app.close()

    expect(calls).toEqual([
      { method: 'GET', route: '/v1/spaces/{space}', status: 401 },
      { method: 'GET', route: '/v1/spaces/{space}', status: 401 },
    ])
  })
})
