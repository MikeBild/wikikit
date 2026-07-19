// OAuth authorize boundary — PKCE validation against a stubbed Db. The prod
// incident this guards: a consent POST without a (valid) code_challenge
// reached the wk_oauth_authorization_codes INSERT and its NOT NULL constraint
// answered with a 500. A non-PKCE client is a client error: 400
// invalid_request at the request boundary, on BOTH the api_key consent branch
// and the interactive login-state branch. The full happy-path round trip
// lives in test/integration/oauth.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import { createApp, type App } from '../../src/app.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { createLogger } from '../../src/logger.ts'

const PEPPER = 'oauth-test-pepper'
const BOOTSTRAP = 'wk_test-bootstrap-key'
const CLIENT_ID = 'wkc_test-client'
const REDIRECT = 'https://client.example/callback'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' // valid S256 shape (43 chars)
const LOGIN_STATE = `wkl_${'a'.repeat(43)}`

const CLIENT_ROW = {
  client_id: CLIENT_ID,
  client_name: 'Test MCP client',
  redirect_uris: [REDIRECT],
  revoked_at: null,
}

/** Minimal Db stub: serves the OAuth client + login state, records inserts. */
function stubDb(loginState: { code_challenge: string } | null) {
  const inserts: { table: string; body: Record<string, unknown> }[] = []
  const db: Db = {
    async query(sql: string) {
      if (sql.includes('FROM wk_oauth_login_states') && loginState) {
        return {
          rows: [
            {
              id: '00000000-0000-0000-0000-00000000c001',
              client_id: CLIENT_ID,
              redirect_uri: REDIRECT,
              scopes: ['knowledge:read'],
              code_challenge: loginState.code_challenge,
              resource: 'https://wikikit.test/mcp',
              client_state: null,
              provider_subject: 'firebase-user-1',
              provider_email: 'mike@example.com',
              provider_id: 'firebase',
              oidc_nonce: null,
              oidc_code_verifier: null,
            },
          ] as never[],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    },
    async tx(fn) {
      return fn(db)
    },
    async call() {
      return []
    },
    async emitEvent() {},
    async select(table: string) {
      if (table === 'wk_oauth_clients') return [CLIENT_ROW] as never[]
      return []
    },
    async insert(table, body) {
      const rows = Array.isArray(body) ? body : [body]
      for (const row of rows) inserts.push({ table: String(table), body: row as Record<string, unknown> })
      return rows.map((row) => ({ id: '00000000-0000-0000-0000-00000000b001', ...row })) as never[]
    },
    async update(_table, _filters, body) {
      return [body] as never[]
    },
    async remove() {},
  }
  return { db, inserts }
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: 'https://wikikit.test',
    databaseUrl: 'postgresql://stub',
    keyPepper: PEPPER,
    bootstrapApiKey: BOOTSTRAP,
    environment: 'test',
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
    ...overrides,
  }
}

async function boot(config: Config, db: Db): Promise<{ app: App; base: string }> {
  const app = createApp(config, {
    database: { db, async close() {} },
    llm: createFakeProvider(),
    logger: createLogger({ level: 'error', write: () => {} }),
  })
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address() as { port: number }
  return { app, base: `http://127.0.0.1:${address.port}` }
}

function consentPost(base: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${base}/v1/oauth/authorize`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: 'wk_oauth_csrf=csrf-tok',
    },
    body: new URLSearchParams({ csrf_token: 'csrf-tok', action: 'approve', ...form }).toString(),
    redirect: 'manual',
  })
}

describe('POST /v1/oauth/authorize — api_key consent branch', () => {
  const { db, inserts } = stubDb(null)
  let app: App
  let base: string

  beforeAll(async () => {
    ;({ app, base } = await boot(testConfig(), db))
  })
  afterAll(async () => {
    await app.close()
  })

  test('a non-PKCE consent POST is a 400 invalid_request, never a 500 from the codes table', async () => {
    const res = await consentPost(base, {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      api_key: BOOTSTRAP,
      // no code_challenge / code_challenge_method at all
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_request' })
    expect(inserts.filter((entry) => entry.table === 'wk_oauth_authorization_codes')).toEqual([])
  })

  test('a valid PKCE consent POST still issues the code (the guard does not over-block)', async () => {
    const res = await consentPost(base, {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      api_key: BOOTSTRAP,
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain(`${REDIRECT}?code=wka_`)
    const staged = inserts.find((entry) => entry.table === 'wk_oauth_authorization_codes')!
    expect(staged.body.code_challenge).toBe(CHALLENGE)
  })
})

describe('POST /v1/oauth/authorize — interactive login-state branch', () => {
  // A login-state row WITHOUT a code challenge (e.g. written by an older
  // binary): consent must answer invalid_request, not insert NULL.
  const { db, inserts } = stubDb({ code_challenge: '' })
  let app: App
  let base: string

  beforeAll(async () => {
    ;({ app, base } = await boot(
      testConfig({
        oauthLoginProvider: 'firebase',
        oauthFirebaseProjectId: 'test-project',
        oauthFirebaseLoginUrl: 'https://login.example/oauth',
        oauthAllowedEmails: ['mike@example.com'],
      }),
      db,
    ))
  })
  afterAll(async () => {
    await app.close()
  })

  test('a login state without a valid PKCE challenge is a 400 invalid_request', async () => {
    const res = await consentPost(base, { login_state: LOGIN_STATE })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_request' })
    expect(inserts.filter((entry) => entry.table === 'wk_oauth_authorization_codes')).toEqual([])
  })
})
