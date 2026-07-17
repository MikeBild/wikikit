// Auth over the wire against a real Postgres: key lifecycle (mint → use →
// revoke), 401 vs 403, space-scoped keys, scope-implication rules and the
// self-escalation guard on /v1/api-keys.
// Gated behind RUN_INTEGRATION=1; scripts/start-local.ts provisions the container.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createApp, type App } from '../../src/app.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { createLogger } from '../../src/logger.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip

setDefaultTimeout(120_000)

const BOOTSTRAP = 'wk_itest-auth-bootstrap'

function integrationConfig(databaseUrl: string): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    databaseUrl,
    keyPepper: 'itest-auth-pepper',
    bootstrapApiKey: BOOTSTRAP,
    llmProvider: 'anthropic' as const,
    llmApiKey: '',
    llmApiKeyEnv: 'ANTHROPIC_API_KEY',
    anthropicBaseUrl: '',
    modelSynthesis: 'claude-sonnet-5',
    modelClassify: 'claude-haiku-4-5',
    modelAnswer: 'claude-sonnet-5',
    maxBodyBytes: 1024 * 1024,
    maxIngestTokens: 100_000,
    ingestConcurrency: 1,
    webhookPollMs: 60_000,
    webhookTimeoutMs: 1000,
    webhookMaxAttempts: 1,
    webhookCircuitThreshold: 5,
    webhookAllowPrivateTargets: true,
    trustProxy: false,
    mcpSessionTtlMs: 60_000,
    mcpMaxSessions: 10,
    logLevel: 'error',
    version: '0.0.0-itest',
    llmConfigured: false,
  }
}

let app: App
let base: string

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
const json = (key: string) => ({ ...bearer(key), 'content-type': 'application/json' })

async function mintKey(body: Record<string, unknown>, withKey = BOOTSTRAP): Promise<{ id: string; key: string }> {
  const res = await fetch(`${base}/v1/api-keys`, { method: 'POST', headers: json(withKey), body: JSON.stringify(body) })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; key: string }
}

describe('auth over the wire (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const url = await provisionIntegrationDatabase('wikikit_test_auth')
    const config = integrationConfig(url)
    await runMigrations(config)
    app = createApp(config, {
      llm: createFakeProvider(),
      logger: createLogger({ level: 'error', write: () => {} }),
    })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`

    for (const slug of ['alpha', 'beta']) {
      const res = await fetch(`${base}/v1/spaces`, {
        method: 'POST',
        headers: json(BOOTSTRAP),
        body: JSON.stringify({ slug, name: slug }),
      })
      expect(res.status).toBe(201)
    }
  })

  afterAll(async () => {
    if (!integration) return
    await app.close()
  })

  it('401 for missing/garbage keys; bootstrap env key authenticates with * scope', async () => {
    expect((await fetch(`${base}/v1/spaces/alpha`)).status).toBe(401)
    expect((await fetch(`${base}/v1/spaces/alpha`, { headers: bearer('wk_garbage') })).status).toBe(401)
    expect((await fetch(`${base}/v1/spaces/alpha`, { headers: bearer(BOOTSTRAP) })).status).toBe(200)
  })

  it('space-scoped key: own space 200, foreign space 403 insufficient_scope (not 404)', async () => {
    const { key } = await mintKey({ name: 'alpha-reader', scopes: ['knowledge:read'], space: 'alpha' })
    expect((await fetch(`${base}/v1/spaces/alpha`, { headers: bearer(key) })).status).toBe(200)

    const foreign = await fetch(`${base}/v1/spaces/beta`, { headers: bearer(key) })
    expect(foreign.status).toBe(403)
    expect(((await foreign.json()) as { code: string }).code).toBe('insufficient_scope')
  })

  it('space scoping guards global-id lookups too (proposals of a foreign space)', async () => {
    // Stage a proposal in beta with a global writer...
    const writer = await mintKey({ name: 'writer', scopes: ['knowledge:propose'] })
    const staged = await fetch(`${base}/v1/spaces/beta/proposals`, {
      method: 'POST',
      headers: json(writer.key),
      body: JSON.stringify({
        title: 'Beta knowledge',
        input_hash: 'b'.repeat(64),
        concepts: [{ slug: 'beta-c', title: 'Beta C', markdown: '# beta', claims: [], relations: [] }],
      }),
    })
    expect(staged.status).toBe(201)
    const { proposal_id } = (await staged.json()) as { proposal_id: string }

    // ...then an alpha-scoped reader must not see it through /v1/proposals/{id}.
    const alphaReader = await mintKey({ name: 'alpha-reader-2', scopes: ['knowledge:read'], space: 'alpha' })
    const res = await fetch(`${base}/v1/proposals/${proposal_id}`, { headers: bearer(alphaReader.key) })
    expect(res.status).toBe(403)
  })

  it('scope matrix: read cannot propose/approve; admin implies knowledge scopes', async () => {
    const reader = await mintKey({ name: 'matrix-reader', scopes: ['knowledge:read'] })
    const propose = await fetch(`${base}/v1/spaces/alpha/ingest`, {
      method: 'POST',
      headers: json(reader.key),
      body: JSON.stringify({ markdown: '# x' }),
    })
    expect(propose.status).toBe(403)

    const approver = await mintKey({ name: 'matrix-approver', scopes: ['knowledge:approve'] })
    // approve scope alone cannot administrate:
    const admin = await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: json(approver.key),
      body: JSON.stringify({ slug: 'gamma', name: 'Gamma' }),
    })
    expect(admin.status).toBe(403)

    const adminKey = await mintKey({ name: 'matrix-admin', scopes: ['admin'] })
    // admin implies knowledge:read...
    expect((await fetch(`${base}/v1/spaces/alpha`, { headers: bearer(adminKey.key) })).status).toBe(200)
    // ...and admin routes themselves.
    const mintedByAdmin = await fetch(`${base}/v1/api-keys`, {
      method: 'POST',
      headers: json(adminKey.key),
      body: JSON.stringify({ name: 'sub', scopes: ['knowledge:read'] }),
    })
    expect(mintedByAdmin.status).toBe(201)
  })

  it('a space-scoped admin key cannot mint keys beyond its own space', async () => {
    const alphaAdmin = await mintKey({ name: 'alpha-admin', scopes: ['admin'], space: 'alpha' })

    const own = await fetch(`${base}/v1/api-keys`, {
      method: 'POST',
      headers: json(alphaAdmin.key),
      body: JSON.stringify({ name: 'alpha-sub', scopes: ['knowledge:read'], space: 'alpha' }),
    })
    expect(own.status).toBe(201)

    for (const body of [
      { name: 'escalate-global', scopes: ['knowledge:read'] }, // all-spaces key
      { name: 'escalate-foreign', scopes: ['knowledge:read'], space: 'beta' },
    ]) {
      const res = await fetch(`${base}/v1/api-keys`, {
        method: 'POST',
        headers: json(alphaAdmin.key),
        body: JSON.stringify(body),
      })
      expect(res.status, body.name).toBe(403)
    }
  })

  it('revoked keys stop authenticating (401, not 403)', async () => {
    const { id, key } = await mintKey({ name: 'short-lived', scopes: ['knowledge:read'] })
    expect((await fetch(`${base}/v1/spaces/alpha`, { headers: bearer(key) })).status).toBe(200)

    await app.database.db.update('wk_api_keys', { id: `eq.${id}` }, { revoked_at: new Date().toISOString() })

    const res = await fetch(`${base}/v1/spaces/alpha`, { headers: bearer(key) })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('unauthorized')
  })

  it('last_used_at telemetry is recorded on authenticated use', async () => {
    const { id, key } = await mintKey({ name: 'telemetry', scopes: ['knowledge:read'] })
    await fetch(`${base}/v1/spaces/alpha`, { headers: bearer(key) })
    // fire-and-forget update: give it a beat
    await new Promise((resolve) => setTimeout(resolve, 250))
    const [row] = await app.database.db.select<{ last_used_at: string | null }>('wk_api_keys', { id: `eq.${id}` })
    expect(row!.last_used_at).not.toBeNull()
  })
})
