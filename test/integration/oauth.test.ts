// Full OAuth 2.1 + PKCE round-trip against real Postgres and the real MCP
// mount. This is the compatibility path ChatGPT uses: discovery -> DCR ->
// consent -> code exchange -> authenticated MCP -> refresh -> revoke.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createApp, type App } from '../../src/app.ts'
import { runMigrations } from '../../src/db/migrate.ts'
import { createLogger } from '../../src/logger.ts'
import { provisionIntegrationDatabase } from '../../scripts/start-local.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { cleanupOAuthRows } from '../../src/oauth/cleanup.ts'
import { hashApiKey } from '../../src/http/auth.ts'
import { readMcpJson } from '../helpers/mcp.ts'

const integration = process.env.RUN_INTEGRATION === '1'
const it = integration ? test : test.skip
const BOOTSTRAP = 'wk_itest-oauth-bootstrap'
const ISSUER = 'https://wikikit.test'
const RESOURCE = `${ISSUER}/mcp`
const REDIRECT = 'https://chatgpt.com/connector/oauth/wikikit-test'

setDefaultTimeout(120_000)

function config(databaseUrl: string): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 0,
    publicUrl: ISSUER,
    databaseUrl,
    keyPepper: 'itest-oauth-pepper',
    bootstrapApiKey: BOOTSTRAP,
    llmProvider: 'anthropic',
    llmApiKey: '',
    llmApiKeyEnv: 'ANTHROPIC_API_KEY',
    anthropicBaseUrl: '',
    modelSynthesis: 'test',
    modelClassify: 'test',
    modelAnswer: 'test',
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
    oauthAuthorizationCodeTtlMs: 10 * 60 * 1000,
    oauthAccessTokenTtlMs: 60 * 60 * 1000,
    oauthRefreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    oauthDynamicRegistrationEnabled: true,
    logLevel: 'error',
    version: '0.0.0-oauth-itest',
    llmConfigured: false,
  }
}

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values)
}

let app: App
let base: string

describe('MCP OAuth 2.1 (integration)', () => {
  beforeAll(async () => {
    if (!integration) return
    const databaseUrl = await provisionIntegrationDatabase('wikikit_test_oauth')
    const testConfig = config(databaseUrl)
    await runMigrations(testConfig)
    app = createApp(testConfig, {
      llm: createFakeProvider(),
      logger: createLogger({ level: 'error', write: () => {} }),
    })
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    const created = await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BOOTSTRAP}`, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'alpha', name: 'Alpha' }),
    })
    expect(created.status).toBe(201)
  })

  afterAll(async () => {
    if (integration) await app.close()
  })

  it('discovers, registers, consents, exchanges, calls MCP, refreshes and revokes', async () => {
    const resourceMetadata = await fetch(`${base}/.well-known/oauth-protected-resource`)
    expect(resourceMetadata.status).toBe(200)
    expect(await resourceMetadata.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: [
        'knowledge:read',
        'knowledge:propose',
        'knowledge:review',
        'knowledge:approve',
        'offline_access',
      ],
      bearer_methods_supported: ['header'],
    })

    const authorizationMetadata = await fetch(`${base}/.well-known/oauth-authorization-server`)
    expect(authorizationMetadata.status).toBe(200)
    expect(
      ((await authorizationMetadata.json()) as { code_challenge_methods_supported: string[] })
        .code_challenge_methods_supported,
    ).toEqual(['S256'])

    const unauthenticated = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oauth-itest', version: '1' } },
      }),
    })
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('www-authenticate')).toContain(`${ISSUER}/.well-known/oauth-protected-resource`)

    const registered = await fetch(`${base}/v1/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT test',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
    expect(registered.status).toBe(201)
    const { client_id: clientId } = (await registered.json()) as { client_id: string }

    const unsafe = await fetch(`${base}/v1/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://attacker.example/callback'] }),
    })
    expect(unsafe.status).toBe(400)

    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const authorize = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
      scope: 'knowledge:read knowledge:propose offline_access',
      state: 'state-123',
    }
    // Step 1: without an operator session the authorize GET renders the
    // API-key sign-in page carrying an opaque single-use login state — never
    // the client's redirect target and never an API key.
    const login = await fetch(`${base}/v1/oauth/authorize?${form(authorize)}`)
    expect(login.status).toBe(200)
    expect(login.headers.get('content-security-policy')).toContain("default-src 'none'")
    const loginHtml = await login.text()
    expect(loginHtml).toContain('Sign in to WikiKit')
    expect(loginHtml).not.toContain(BOOTSTRAP)
    const loginState = loginHtml.match(/name="login_state" value="(wkl_[A-Za-z0-9_-]{43})"/)?.[1]
    expect(loginState).toBeDefined()

    // Step 2: the API key is posted once to the login endpoint, which mints a
    // reusable operator session (cookie) and answers with the consent page.
    const signedIn = await fetch(`${base}/v1/identity/login/api-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ login_state: loginState!, api_key: BOOTSTRAP }),
    })
    expect(signedIn.status).toBe(200)
    const setCookies = signedIn.headers.getSetCookie()
    const csrfCookie = setCookies.find((cookie) => cookie.startsWith('wk_oauth_csrf='))?.split(';')[0]
    const operatorCookie = setCookies.find((cookie) => cookie.includes('wikikit_operator='))?.split(';')[0]
    expect(csrfCookie).toBeDefined()
    expect(operatorCookie).toBeDefined()
    const consentHtml = await signedIn.text()
    expect(consentHtml).toContain('ChatGPT test')
    expect(consentHtml).not.toContain(BOOTSTRAP)

    // Step 3: the decision POST carries CSRF token + operator session cookie.
    const decisionBody = form({
      csrf_token: decodeURIComponent(csrfCookie!.split('=')[1]!),
      login_state: loginState!,
      decision: 'approve',
    })
    for (const scope of ['knowledge:read', 'knowledge:propose', 'offline_access']) decisionBody.append('scope', scope)
    const approved = await fetch(`${base}/v1/oauth/authorize/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${csrfCookie}; ${operatorCookie}` },
      body: decisionBody,
      redirect: 'manual',
    })
    expect(approved.status).toBe(302)
    const callback = new URL(approved.headers.get('location')!)
    expect(callback.origin + callback.pathname).toBe(REDIRECT)
    expect(callback.searchParams.get('state')).toBe('state-123')
    const code = callback.searchParams.get('code')!

    const exchanged = await fetch(`${base}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    })
    expect(exchanged.status).toBe(200)
    const first = (await exchanged.json()) as { access_token: string; refresh_token: string; token_type: string }
    expect(first.access_token).toMatch(/^wko_[A-Za-z0-9_-]{43}$/)
    expect(first.refresh_token).toMatch(/^wkr_[A-Za-z0-9_-]{43}$/)
    expect(first.token_type).toBe('Bearer')

    const read = await fetch(`${base}/v1/spaces/alpha`, { headers: { authorization: `Bearer ${first.access_token}` } })
    expect(read.status).toBe(200)

    const initialized = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${first.access_token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'chatgpt-itest', version: '1' },
        },
      }),
    })
    expect(initialized.status).toBe(200)
    expect((await readMcpJson<{ result: { serverInfo: { name: string } } }>(initialized)).result.serverInfo.name).toBe(
      'wikikit',
    )

    const refreshed = await fetch(`${base}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token }),
    })
    expect(refreshed.status).toBe(200)
    const second = (await refreshed.json()) as { access_token: string; refresh_token: string }
    expect(second.access_token).not.toBe(first.access_token)
    expect(second.refresh_token).not.toBe(first.refresh_token)

    const replay = await fetch(`${base}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token }),
    })
    expect(replay.status).toBe(400)
    expect(
      (await fetch(`${base}/v1/spaces/alpha`, { headers: { authorization: `Bearer ${second.access_token}` } })).status,
    ).toBe(401)

    const revoked = await fetch(`${base}/v1/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ token: second.access_token, client_id: clientId }),
    })
    expect(revoked.status).toBe(200)
    expect(
      (await fetch(`${base}/v1/spaces/alpha`, { headers: { authorization: `Bearer ${second.access_token}` } })).status,
    ).toBe(401)
  })

  it('revoking the operator API key immediately invalidates its OAuth access and refresh tokens', async () => {
    const minted = await fetch(`${base}/v1/api-keys`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BOOTSTRAP}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'oauth-root-revocation', scopes: ['knowledge:read', 'knowledge:propose'] }),
    })
    expect(minted.status).toBe(201)
    const root = (await minted.json()) as { id: string; key: string }
    const clientId = `wkc_root_${randomBytes(8).toString('hex')}`
    const accessToken = `wko_${randomBytes(32).toString('base64url')}`
    const refreshToken = `wkr_${randomBytes(32).toString('base64url')}`
    const familyId = randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await app.database.db.insert('wk_oauth_clients', {
      client_id: clientId,
      client_name: 'root revocation fixture',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    })
    const shared = {
      client_id: clientId,
      scopes: ['knowledge:read', 'knowledge:propose'],
      resource: RESOURCE,
      principal_name: 'oauth-root-revocation',
      principal_key_id: root.id,
      principal_key_hash: hashApiKey(root.key, 'itest-oauth-pepper'),
      family_id: familyId,
      expires_at: expiresAt,
    }
    await app.database.db.insert('wk_oauth_access_tokens', {
      ...shared,
      token_hash: hashApiKey(accessToken, 'itest-oauth-pepper'),
    })
    await app.database.db.insert('wk_oauth_refresh_tokens', {
      ...shared,
      token_hash: hashApiKey(refreshToken, 'itest-oauth-pepper'),
    })
    expect(
      (await fetch(`${base}/v1/spaces/alpha`, { headers: { authorization: `Bearer ${accessToken}` } })).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${base}/v1/api-keys/${root.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${BOOTSTRAP}` },
        })
      ).status,
    ).toBe(200)
    expect(
      (await fetch(`${base}/v1/spaces/alpha`, { headers: { authorization: `Bearer ${accessToken}` } })).status,
    ).toBe(401)
    expect(
      (
        await fetch(`${base}/v1/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken }),
        })
      ).status,
    ).toBe(400)
  })

  it('starts the Firebase login bridge without exposing an operator API key', async () => {
    const firebaseApp = createApp(
      {
        ...config(app.config.databaseUrl),
        oauthLoginProvider: 'firebase',
        oauthFirebaseProjectId: 'subkit-auth-prod',
        oauthFirebaseLoginUrl: 'https://subkit-auth-prod.web.app',
        oauthAllowedEmails: ['mike@mikebild.com'],
      },
      { llm: createFakeProvider(), logger: createLogger({ level: 'error', write: () => {} }) },
    )
    await new Promise<void>((resolve) => firebaseApp.server.listen(0, '127.0.0.1', resolve))
    const firebaseBase = `http://127.0.0.1:${(firebaseApp.server.address() as { port: number }).port}`
    try {
      const registration = await fetch(`${firebaseBase}/v1/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Firebase bridge test', redirect_uris: [REDIRECT] }),
      })
      const { client_id } = (await registration.json()) as { client_id: string }
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const response = await fetch(
        `${firebaseBase}/v1/oauth/authorize?${form({
          response_type: 'code',
          client_id,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          resource: RESOURCE,
          scope: 'knowledge:read',
          state: 'firebase-state',
        })}`,
        { redirect: 'manual' },
      )
      // Firebase as the only login method: authorize hops to the internal
      // login starter, which then bounces to the Firebase-hosted page.
      expect(response.status).toBe(302)
      const starter = new URL(response.headers.get('location')!)
      expect(starter.origin).toBe(ISSUER)
      expect(starter.pathname).toBe('/v1/identity/login/start')
      const started = await fetch(`${firebaseBase}${starter.pathname}${starter.search}`, { redirect: 'manual' })
      expect(started.status).toBe(302)
      const location = new URL(started.headers.get('location')!)
      expect(location.origin).toBe('https://subkit-auth-prod.web.app')
      expect(location.searchParams.get('wikikit_oauth_callback')).toBe(`${ISSUER}/v1/identity/login/firebase/callback`)
      const loginState = location.searchParams.get('wikikit_oauth_state')!
      expect(loginState).toMatch(/^wkl_[A-Za-z0-9_-]{43}$/)
      expect(location.toString()).not.toContain(BOOTSTRAP)

      // The Firebase verifier is covered separately by jose's issuer/signature
      // validation. Here we model its successful, server-side result — the
      // authenticated login state AND the operator session the callback mints —
      // and exercise the failure-prone transition from consent to a PKCE code.
      await firebaseApp.database.db.insert('wk_oauth_identities', {
        provider_subject: 'firebase-test-subject',
        email: 'mike@mikebild.com',
      })
      await firebaseApp.database.db.update(
        'wk_oauth_login_states',
        { state_hash: `eq.${hashApiKey(loginState, 'itest-oauth-pepper')}` },
        {
          provider_id: 'firebase',
          provider_subject: 'firebase-test-subject',
          provider_email: 'mike@mikebild.com',
          authenticated_at: new Date().toISOString(),
        },
      )
      const operatorSessionToken = `wkos_${randomBytes(32).toString('base64url')}`
      await firebaseApp.database.db.insert('wk_oauth_operator_sessions', {
        token_hash: hashApiKey(operatorSessionToken, 'itest-oauth-pepper'),
        principal_kind: 'firebase',
        principal_key_id: 'firebase:firebase-test-subject',
        principal_key_hash: hashApiKey('firebase:firebase-test-subject', 'itest-oauth-pepper'),
        principal_name: 'mike@mikebild.com',
        principal_space_id: null,
        provider_id: 'firebase',
        provider_subject: 'firebase-test-subject',
        scopes: ['knowledge:read', 'knowledge:propose'],
        expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
        absolute_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      const csrf = randomBytes(32).toString('base64url')
      const approved = await fetch(`${firebaseBase}/v1/oauth/authorize/decision`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `wk_oauth_csrf=${encodeURIComponent(csrf)}; __Host-wikikit_operator=${encodeURIComponent(operatorSessionToken)}`,
        },
        body: form({ login_state: loginState, csrf_token: csrf, decision: 'approve' }),
        redirect: 'manual',
      })
      expect(approved.status).toBe(302)
      const callback = new URL(approved.headers.get('location')!)
      const code = callback.searchParams.get('code')!
      expect(code).toMatch(/^wka_/)
      const exchanged = await fetch(`${firebaseBase}/v1/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          grant_type: 'authorization_code',
          client_id,
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          resource: RESOURCE,
        }),
      })
      expect(exchanged.status).toBe(200)
      expect(((await exchanged.json()) as { access_token: string }).access_token).toMatch(/^wko_/)
    } finally {
      await firebaseApp.close()
    }
  })

  it('housekeeping retains replay evidence briefly and prunes expired OAuth rows in dependency order', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    const clientId = `wkc_cleanup_${randomBytes(8).toString('hex')}`
    const familyId = randomUUID()
    await app.database.db.insert('wk_oauth_clients', {
      client_id: clientId,
      client_name: 'expired cleanup fixture',
      redirect_uris: ['https://chatgpt.com/connector/oauth/cleanup'],
      token_endpoint_auth_method: 'none',
      created_at: old,
    })
    await app.database.db.insert('wk_oauth_authorization_codes', {
      code_hash: `code-${randomUUID()}`,
      client_id: clientId,
      redirect_uri: 'https://chatgpt.com/connector/oauth/cleanup',
      scopes: ['knowledge:read'],
      code_challenge: 'A'.repeat(43),
      resource: RESOURCE,
      principal_name: 'cleanup',
      principal_key_id: 'bootstrap',
      principal_key_hash: 'fixture',
      expires_at: old,
    })
    await app.database.db.insert('wk_oauth_access_tokens', {
      token_hash: `access-${randomUUID()}`,
      client_id: clientId,
      scopes: ['knowledge:read'],
      resource: RESOURCE,
      principal_name: 'cleanup',
      principal_key_id: 'bootstrap',
      principal_key_hash: 'fixture',
      family_id: familyId,
      expires_at: old,
    })
    await app.database.db.insert('wk_oauth_refresh_tokens', {
      token_hash: `refresh-${randomUUID()}`,
      client_id: clientId,
      scopes: ['knowledge:read'],
      resource: RESOURCE,
      principal_name: 'cleanup',
      principal_key_id: 'bootstrap',
      principal_key_hash: 'fixture',
      family_id: familyId,
      expires_at: old,
    })
    expect(await cleanupOAuthRows(app.database.db)).toEqual({
      accessTokens: 1,
      refreshTokens: 1,
      authorizationCodes: 1,
      loginStates: 0,
      operatorSessions: 0,
      unusedClients: 1,
    })
  })
})
