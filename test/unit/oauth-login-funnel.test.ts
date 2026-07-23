// Browser login-funnel error contract — GET failures in the interactive
// funnel (authorize → login/start → callback) answer HUMANS with an HTML
// error page in the shared TOKENS shell, keep the RFC 6749 JSON envelope for
// Accept: application/json, hand the waiting MCP client an error=access_denied
// redirect wherever the client is validated and known, and mint a FRESH login
// state for every "Continue with SSO" click instead of rotating the nonce and
// PKCE verifier of the pending row (which broke the Back-button flow).
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import { createApp, type App } from '../../src/app.ts'
import { hashApiKey } from '../../src/http/auth.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { createLogger } from '../../src/logger.ts'
import * as realOidc from '../../src/oauth/oidc.ts'

const PEPPER = 'oauth-funnel-pepper'
const BOOTSTRAP = 'wk_test-bootstrap-key'
const CLIENT_ID = 'wkc_test-client'
const REDIRECT = 'https://client.example/callback'
const LOGIN_STATE = `wkl_${'a'.repeat(43)}`
const DENIAL = 'OIDC account is not allowed to access WikiKit'

const CLIENT_ROW = {
  client_id: CLIENT_ID,
  client_name: 'Test MCP client',
  redirect_uris: [REDIRECT],
  revoked_at: null,
}

interface StateRow {
  id: string
  client_id: string
  redirect_uri: string
  scopes: string[]
  code_challenge: string
  resource: string
  client_state: string | null
  provider_subject: string | null
  provider_email: string | null
  provider_id: string | null
  oidc_nonce: string | null
  oidc_code_verifier: string | null
}

function liveStateRow(overrides: Partial<StateRow> = {}): StateRow {
  return {
    id: '00000000-0000-0000-0000-00000000c001',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scopes: ['knowledge:read'],
    code_challenge: 'c'.repeat(43),
    resource: 'https://wikikit.test/mcp',
    client_state: 'client-state-1',
    provider_subject: null,
    provider_email: null,
    provider_id: null,
    oidc_nonce: null,
    oidc_code_verifier: null,
    ...overrides,
  }
}

/**
 * Minimal Db stub. The filtered lookup (consumed_at IS NULL) serves `live`;
 * the unfiltered recovery lookup serves `recoverable`; clients come from
 * `clients`. All inserts and updates are recorded for assertions.
 */
function stubDb(options: {
  live?: StateRow | null
  recoverable?: Pick<StateRow, 'client_id' | 'redirect_uri' | 'client_state'> | null
  clients?: (typeof CLIENT_ROW)[]
}) {
  const inserts: { table: string; body: Record<string, unknown> }[] = []
  const updates: { table: string; body: Record<string, unknown> }[] = []
  const db: Db = {
    async query(sql: string) {
      if (sql.includes('FROM wk_oauth_login_states')) {
        if (sql.includes('consumed_at IS NULL')) {
          return { rows: (options.live ? [options.live] : []) as never[], rowCount: options.live ? 1 : 0 }
        }
        return {
          rows: (options.recoverable ? [options.recoverable] : []) as never[],
          rowCount: options.recoverable ? 1 : 0,
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
      if (table === 'wk_oauth_clients') return (options.clients ?? [CLIENT_ROW]) as never[]
      return []
    },
    async insert(table, body) {
      const rows = Array.isArray(body) ? body : [body]
      for (const row of rows) inserts.push({ table: String(table), body: row as Record<string, unknown> })
      return rows.map((row) => ({ id: '00000000-0000-0000-0000-00000000b001', ...row })) as never[]
    },
    async update(table, _filters, body) {
      updates.push({ table: String(table), body: body as Record<string, unknown> })
      return [body] as never[]
    },
    async remove() {},
  }
  return { db, inserts, updates }
}

function testConfig(): Config {
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
    oauthProviders: [
      { protocol: 'api_key', id: 'api-key', label: 'WikiKit API key' },
      {
        protocol: 'oidc',
        id: 'workforce',
        label: 'Workforce OIDC',
        issuer: 'https://issuer.example.test',
        clientId: 'wikikit-test',
        scopes: 'openid email profile',
        allowedEmails: ['mike@example.com'],
        allowedSubjects: [],
        allowedScopes: ['knowledge:read', 'knowledge:propose'],
      },
    ],
  }
}

const apps: App[] = []

async function boot(db: Db): Promise<string> {
  const app = createApp(testConfig(), {
    database: { db, async close() {} },
    llm: createFakeProvider(),
    logger: createLogger({ level: 'error', write: () => {} }),
  })
  apps.push(app)
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address() as { port: number }
  return `http://127.0.0.1:${address.port}`
}

let finishError: Error = new Error(DENIAL)

beforeAll(() => {
  // Deterministic OIDC edge: no discovery/network in unit tests. Restored to
  // the real module in afterAll so later test files see the genuine oidc.ts.
  mock.module('../../src/oauth/oidc.ts', () => ({
    ...realOidc,
    startOidcLogin: async (args: { state: string }) => ({
      authorizationUrl: `https://idp.example/authorize?state=${encodeURIComponent(args.state)}`,
      nonce: 'fresh-nonce',
      codeVerifier: 'fresh-verifier',
    }),
    finishOidcLogin: async () => {
      throw finishError
    },
  }))
})

afterAll(async () => {
  mock.module('../../src/oauth/oidc.ts', () => ({ ...realOidc }))
  for (const app of apps) await app.close()
})

describe('browser login funnel errors are HTML pages', () => {
  test('an unknown callback state renders the state-problem page with the client error redirect', async () => {
    const { db } = stubDb({
      live: null,
      recoverable: { client_id: CLIENT_ID, redirect_uri: REDIRECT, client_state: 'client-state-1' },
    })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/login/callback?state=${LOGIN_STATE}&code=xyz`)
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<h1>Sign-in failed</h1>')
    expect(html).toContain('This sign-in attempt expired or was already used. Please sign in again.')
    expect(html).toContain('>Sign in again</a>')
    expect(html).toContain(`href="${REDIRECT}?error=access_denied&amp;state=client-state-1"`)
  })

  test('an unrecoverable state renders the page without a retry action', async () => {
    const { db } = stubDb({ live: null, recoverable: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/login/callback?state=${LOGIN_STATE}&code=xyz`)
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('This sign-in attempt expired or was already used. Please sign in again.')
    expect(html).not.toContain('Sign in again</a>')
  })

  test('Accept: application/json still receives the RFC error envelope', async () => {
    const { db } = stubDb({ live: null, recoverable: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/login/callback?state=${LOGIN_STATE}&code=xyz`, {
      headers: { accept: 'application/json' },
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ error: 'invalid_request' })
  })

  test('an expired state on login/start renders the state-problem page', async () => {
    const { db } = stubDb({ live: null, recoverable: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/login/start?login_state=${LOGIN_STATE}`)
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('This sign-in attempt expired or was already used. Please sign in again.')
  })

  test('authorize request errors render HTML for browsers and JSON for JSON clients', async () => {
    const { db } = stubDb({ live: null, recoverable: null })
    const base = await boot(db)
    const url = `${base}/v1/oauth/authorize?response_type=token&client_id=${CLIENT_ID}`
    const browser = await fetch(url)
    expect(browser.status).toBe(400)
    expect(browser.headers.get('content-type')).toContain('text/html')
    expect(await browser.text()).toContain('<h1>Sign-in failed</h1>')
    const jsonClient = await fetch(url, { headers: { accept: 'application/json' } })
    expect(jsonClient.status).toBe(400)
    expect(await jsonClient.json()).toMatchObject({ error: 'unsupported_response_type' })
  })
})

describe('identity policy denial in the callback', () => {
  test('renders the not-authorized page, consumes the state and links the deny redirect', async () => {
    finishError = new Error(DENIAL)
    const { db, updates } = stubDb({
      live: liveStateRow({ provider_id: 'workforce', oidc_nonce: 'n1', oidc_code_verifier: 'v1' }),
    })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/login/callback?state=${LOGIN_STATE}&code=xyz`)
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<h1>Sign-in failed</h1>')
    expect(html).toContain('Your account is not authorized for WikiKit. Contact the operator.')
    expect(html).toContain(`href="${REDIRECT}?error=access_denied&amp;state=client-state-1"`)
    // Deny-path contract: the login state is consumed exactly like a consent deny.
    const consumed = updates.filter((entry) => entry.table === 'wk_oauth_login_states')
    expect(consumed).toHaveLength(1)
    expect(consumed[0]!.body).toHaveProperty('consumed_at')
  })

  test('a code-exchange failure consumes the state and renders the retry page', async () => {
    finishError = new Error('authorization code is invalid')
    const { db, updates } = stubDb({
      live: liveStateRow({ provider_id: 'workforce', oidc_nonce: 'n1', oidc_code_verifier: 'v1' }),
    })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/login/callback?state=${LOGIN_STATE}&code=xyz`)
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('This sign-in attempt expired or was already used. Please sign in again.')
    expect(html).toContain(`href="${REDIRECT}?error=access_denied&amp;state=client-state-1"`)
    expect(updates.filter((entry) => entry.table === 'wk_oauth_login_states')).toHaveLength(1)
  })
})

describe('every SSO click mints a fresh login state', () => {
  test('the pending row is never rewritten; a new state row carries nonce and verifier', async () => {
    const { db, inserts, updates } = stubDb({ live: liveStateRow() })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/login/start?login_state=${LOGIN_STATE}&provider=workforce`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(location).toStartWith('https://idp.example/authorize?state=wkl_')
    // The IdP state is a FRESH token, never the chooser state being reused.
    expect(location).not.toContain(LOGIN_STATE)
    const created = inserts.filter((entry) => entry.table === 'wk_oauth_login_states')
    expect(created).toHaveLength(1)
    const row = created[0]!.body
    expect(row.oidc_nonce).toBe('fresh-nonce')
    expect(row.oidc_code_verifier).toBe('fresh-verifier')
    expect(row.client_id).toBe(CLIENT_ID)
    expect(row.redirect_uri).toBe(REDIRECT)
    expect(row.client_state).toBe('client-state-1')
    expect(row.state_hash).not.toBe(hashApiKey(LOGIN_STATE, PEPPER))
    // The original chooser state stays untouched until its TTL (Back button).
    expect(updates.filter((entry) => entry.table === 'wk_oauth_login_states')).toHaveLength(0)
  })
})
