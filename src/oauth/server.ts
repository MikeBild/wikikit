// OAuth 2.1 authorization server for remote MCP clients (ChatGPT, Claude.ai,
// Cursor). API keys remain the operator login credential; this surface turns
// one successful, explicit consent into short-lived scoped OAuth tokens.
// Plaintext API keys, authorization codes and tokens are never persisted.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Config } from '../config.ts'
import type { Db } from '../db/postgres.ts'
import type { Auth, Principal } from '../http/auth.ts'
import { hashApiKey } from '../http/auth.ts'
import type { RawHandler } from '../http/server.ts'
import type { Logger } from '../logger.ts'
import { cleanupOAuthRows, type OAuthCleanupReport } from './cleanup.ts'
import { verifyFirebaseIdToken } from './firebase.ts'
import { finishOidcLogin, startOidcLogin } from './oidc.ts'

const OAUTH_SCOPES = [
  'knowledge:read',
  'knowledge:propose',
  'knowledge:review',
  'knowledge:approve',
  'offline_access',
] as const
// A client must opt in to the review right. Adding support must never silently
// turn existing read/propose integrations into approvers on reconnect.
const DEFAULT_SCOPE = 'knowledge:read knowledge:propose offline_access'
const DCR_MAX_PER_MINUTE = 10
const MAX_FORM_BYTES = 32 * 1024

interface ClientRow {
  client_id: string
  client_name: string
  redirect_uris: string[]
  revoked_at: Date | string | null
}

interface CodeRow {
  id: string
  scopes: string[]
  code_challenge: string
  principal_name: string
  principal_space_id: string | null
  principal_key_id: string
  principal_key_hash: string
  principal_kind: 'api_key' | 'firebase' | 'oidc'
}

interface RefreshRow {
  id: string
  scopes: string[]
  resource: string
  principal_name: string
  principal_space_id: string | null
  principal_key_id: string
  principal_key_hash: string
  principal_kind: 'api_key' | 'firebase' | 'oidc'
  family_id: string
  expires_at: Date | string
  revoked_at: Date | string | null
}

interface IdentityLoginStateRow {
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

class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description)
  }
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

// RFC 7636 §4.2 shape of an S256 code_challenge. Every path that persists a
// challenge validates against THIS — a non-PKCE client must be answered with
// invalid_request at the request boundary, never by the NOT NULL constraint
// on wk_oauth_authorization_codes exploding into a 500 at consent time.
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function safeEqualText(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest()
  const bh = createHash('sha256').update(b).digest()
  return ah.equals(bh)
}

function parseScopes(value: string | null | undefined): string[] {
  const scopes = [...new Set((value || DEFAULT_SCOPE).split(/\s+/).filter(Boolean))]
  if (!scopes.length || scopes.some((scope) => !(OAUTH_SCOPES as readonly string[]).includes(scope))) {
    throw new OAuthError('invalid_scope', 'requested scope is not supported')
  }
  return scopes
}

function isSafeRedirectUri(value: string): boolean {
  if (!value || value.length > 2048 || /[\r\n]/.test(value)) return false
  try {
    const url = new URL(value)
    if (url.hash || url.username || url.password) return false
    if (url.protocol === 'https:') return true
    if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return !['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'].includes(url.protocol)
  } catch {
    return false
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

function oauthError(error: unknown): Response {
  const known = error instanceof OAuthError ? error : new OAuthError('server_error', 'authorization server error', 500)
  return json({ error: known.error, error_description: known.description }, known.status)
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!,
  )
}

function html(body: string, status = 200, redirectOrigin?: string): Response {
  // CSP applies to a form submission's redirect chain too. The consent POST
  // is same-origin, but its successful OAuth response must be allowed to
  // redirect to the (already registered and validated) client redirect URI.
  // Keep the exception origin-scoped; the form itself can still only POST
  // back to WikiKit.
  const formAction = [`'self'`, ...(redirectOrigin ? [redirectOrigin] : [])].join(' ')
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}

function redirectWith(redirectUri: string, values: Record<string, string | undefined>): Response {
  const target = new URL(redirectUri)
  for (const [name, value] of Object.entries(values)) if (value !== undefined) target.searchParams.set(name, value)
  return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store' } })
}

async function readCappedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > maxBytes) {
        reject(new OAuthError('invalid_request', 'request body is too large', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function consentPage(args: {
  clientName: string
  params: URLSearchParams
  scopes: string[]
  error?: string
  csrfToken: string
  secureCookie: boolean
  loginState?: string
  redirectUri?: string
}): Response {
  const hidden = [...args.params.entries()]
    .filter(([name]) => name !== 'api_key' && name !== 'action')
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n')
  const scopeItems = args.scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join('')
  const error = args.error ? `<p class="error">${escapeHtml(args.error)}</p>` : ''
  const redirectUri = args.redirectUri ?? args.params.get('redirect_uri') ?? undefined
  const redirectOrigin = redirectUri ? new URL(redirectUri).origin : undefined
  const response = html(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize WikiKit</title><style>
body{font:16px/1.5 system-ui,sans-serif;background:#f4f4f1;color:#171713;margin:0;padding:2rem}
main{max-width:34rem;margin:4vh auto;background:#fff;border:1px solid #d8d8d0;border-radius:14px;padding:2rem;box-shadow:0 8px 30px #0001}
h1{margin-top:0}label{display:block;font-weight:650;margin:1.25rem 0 .4rem}input[type=password]{box-sizing:border-box;width:100%;padding:.8rem;border:1px solid #aaa;border-radius:8px}
.actions{display:flex;gap:.75rem;margin-top:1.5rem}button{padding:.7rem 1rem;border-radius:8px;border:1px solid #777;background:#fff;cursor:pointer}button.primary{background:#171713;color:#fff;border-color:#171713}.error{color:#a01818;font-weight:650}
small{color:#555}</style></head><body><main>
<h1>Authorize WikiKit</h1><p><strong>${escapeHtml(args.clientName)}</strong> requests these permissions:</p><ul>${scopeItems}</ul>${error}
<form method="post" action="/v1/oauth/authorize">${hidden}
<input type="hidden" name="csrf_token" value="${escapeHtml(args.csrfToken)}">
${args.loginState ? `<input type="hidden" name="login_state" value="${escapeHtml(args.loginState)}">` : ''}
${args.loginState ? '<p><strong>Signed in with your approved Google account.</strong></p>' : '<label for="api_key">WikiKit API key</label><input id="api_key" name="api_key" type="password" required autocomplete="off" spellcheck="false">'}
<small>${args.loginState ? 'WikiKit only receives a verified Google identity. The issued OAuth token is limited to the permissions above.' : 'The key is checked once and is never stored. The issued OAuth token is limited to the permissions above.'}</small>
<div class="actions"><button class="primary" type="submit" name="action" value="approve">Authorize</button><button type="submit" name="action" value="deny" formnovalidate>Deny</button></div>
</form></main></body></html>`,
    200,
    redirectOrigin,
  )
  response.headers.set(
    'set-cookie',
    `wk_oauth_csrf=${encodeURIComponent(args.csrfToken)}; HttpOnly; SameSite=Lax; Path=/v1/oauth/authorize; Max-Age=600${args.secureCookie ? '; Secure' : ''}`,
  )
  return response
}

function loginChoicePage(args: {
  state: string
  firebase: boolean
  oidc: Array<{ id: string; label: string }>
}): Response {
  const options = [...(args.firebase ? [{ id: 'firebase', label: 'Continue with Google' }] : []), ...args.oidc]
    .map(
      (provider) =>
        `<a class="provider" href="/v1/oauth/login?state=${encodeURIComponent(args.state)}&provider=${encodeURIComponent(provider.id)}">${escapeHtml(provider.label)}</a>`,
    )
    .join('')
  return html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to WikiKit</title><style>
body{font:16px/1.5 system-ui,sans-serif;background:#f4f4f1;color:#171713;margin:0;padding:2rem}main{max-width:34rem;margin:10vh auto;background:#fff;border:1px solid #d8d8d0;border-radius:14px;padding:2rem;box-shadow:0 8px 30px #0001}h1{margin:0 0 .4rem}.provider{display:block;margin:.75rem 0;padding:.85rem 1rem;border:1px solid #777;border-radius:8px;color:#171713;text-decoration:none;font-weight:650}.provider:hover{background:#f4f4f1}small{color:#555}</style></head><body><main>
<h1>Sign in to WikiKit</h1><p>Choose an approved identity provider to continue.</p>${options}<small>WikiKit only grants the permissions requested by your MCP client and allowed by this identity provider.</small>
</main></body></html>`,
  )
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

function clearCsrfCookie(response: Response, secure: boolean): Response {
  response.headers.set(
    'set-cookie',
    `wk_oauth_csrf=; HttpOnly; SameSite=Lax; Path=/v1/oauth/authorize; Max-Age=0${secure ? '; Secure' : ''}`,
  )
  return response
}

function resourceId(config: Config): string {
  return `${config.publicUrl}/mcp`
}

function bootstrapGrantIsCurrent(
  config: Config,
  row: { principal_key_id: string; principal_key_hash: string },
): boolean {
  return (
    row.principal_key_id !== 'bootstrap' ||
    (!!config.bootstrapApiKey &&
      safeEqualText(row.principal_key_hash, hashApiKey(config.bootstrapApiKey, config.keyPepper)))
  )
}

async function revokeFamily(db: Db, familyId: string, revokedAt: string): Promise<void> {
  await db.query(
    `UPDATE wk_oauth_access_tokens
        SET revoked_at = coalesce(revoked_at, $2)
      WHERE family_id = $1`,
    [familyId, revokedAt],
  )
  await db.query(
    `UPDATE wk_oauth_refresh_tokens
        SET revoked_at = coalesce(revoked_at, $2)
      WHERE family_id = $1`,
    [familyId, revokedAt],
  )
}

async function loadAuthorizationRequest(
  config: Config,
  db: Db,
  params: URLSearchParams,
): Promise<{ client: ClientRow; redirectUri: string; scopes: string[]; resource: string; codeChallenge: string }> {
  if (params.get('response_type') !== 'code')
    throw new OAuthError('unsupported_response_type', 'response_type must be code')
  const clientId = params.get('client_id') || ''
  const redirectUri = params.get('redirect_uri') || ''
  const challenge = params.get('code_challenge') || ''
  if (!clientId || !redirectUri || !PKCE_CHALLENGE.test(challenge)) {
    throw new OAuthError('invalid_request', 'client_id, redirect_uri and a valid PKCE challenge are required')
  }
  if (params.get('code_challenge_method') !== 'S256') {
    throw new OAuthError('invalid_request', 'code_challenge_method must be S256')
  }
  const [client] = await db.select<ClientRow>('wk_oauth_clients', { client_id: `eq.${clientId}`, limit: 1 })
  if (!client || client.revoked_at) throw new OAuthError('invalid_client', 'unknown or revoked client')
  if (!client.redirect_uris.includes(redirectUri))
    throw new OAuthError('invalid_request', 'redirect_uri is not registered')
  const resource = params.get('resource') || resourceId(config)
  if (resource !== resourceId(config))
    throw new OAuthError('invalid_target', 'resource does not identify this MCP server')
  return { client, redirectUri, scopes: parseScopes(params.get('scope')), resource, codeChallenge: challenge }
}

function firebaseEnabled(config: Config): boolean {
  return (
    (config.oauthLoginProvider === 'firebase' || config.oauthLoginProvider === 'federated') &&
    !!config.oauthFirebaseProjectId &&
    !!config.oauthFirebaseLoginUrl
  )
}

function oidcEnabled(config: Config): boolean {
  return (
    (config.oauthLoginProvider === 'oidc' || config.oauthLoginProvider === 'federated') &&
    !!config.oauthOidcProviders?.length
  )
}

function interactiveLoginEnabled(config: Config): boolean {
  return firebaseEnabled(config) || oidcEnabled(config)
}

function providerAllowedScopes(config: Config, providerId: string | null): string[] {
  if (providerId === 'firebase') return config.oauthAllowedScopes ?? ['knowledge:read', 'knowledge:propose']
  return (config.oauthOidcProviders || []).find((provider) => provider.id === providerId)?.allowedScopes ?? []
}

function firebaseLoginUrl(config: Config, loginState: string): string {
  const base = config.oauthFirebaseLoginUrl
  if (!base || !config.oauthFirebaseProjectId || !config.oauthAllowedEmails?.length) {
    throw new OAuthError('server_error', 'Firebase OAuth login is not configured', 500)
  }
  const target = new URL(base)
  // The state is opaque and single-use. No MCP redirect URI or OAuth client
  // data crosses the Firebase-hosted page.
  target.searchParams.set('wikikit_oauth_callback', `${config.publicUrl}/v1/oauth/firebase/callback`)
  target.searchParams.set('wikikit_oauth_state', loginState)
  return target.toString()
}

async function firebaseGrantIsCurrent(
  db: Db,
  config: Config,
  row: { principal_kind: string; principal_key_id: string },
): Promise<boolean> {
  if (row.principal_kind !== 'firebase') return true
  const subject = row.principal_key_id.startsWith('firebase:') ? row.principal_key_id.slice('firebase:'.length) : ''
  if (!subject || !config.oauthAllowedEmails?.length) return false
  const { rows } = await db.query<{ email: string }>(
    `SELECT email FROM wk_oauth_identities
      WHERE provider = 'firebase' AND provider_subject = $1 AND revoked_at IS NULL
      LIMIT 1`,
    [subject],
  )
  return !!rows[0] && config.oauthAllowedEmails.includes(rows[0].email.toLowerCase())
}

async function identityGrantIsCurrent(
  db: Db,
  config: Config,
  row: { principal_kind: string; principal_key_id: string },
): Promise<boolean> {
  if (row.principal_kind === 'firebase') return firebaseGrantIsCurrent(db, config, row)
  if (row.principal_kind !== 'oidc') return true
  const match = row.principal_key_id.match(/^oidc:([a-z0-9][a-z0-9-]{0,62}):(.+)$/)
  if (!match) return false
  const provider = config.oauthOidcProviders?.find((candidate) => candidate.id === match[1])
  if (!provider) return false
  const { rows } = await db.query<{ email: string }>(
    `SELECT email FROM wk_oauth_identities
      WHERE provider = $1 AND provider_subject = $2 AND revoked_at IS NULL
      LIMIT 1`,
    [provider.id, match[2]],
  )
  return !!rows[0] && provider.allowedEmails.includes(rows[0].email.toLowerCase())
}

async function issueTokens(
  config: Config,
  db: Db,
  args: {
    clientId: string
    scopes: string[]
    resource: string
    principalName: string
    principalSpaceId: string | null
    principalKeyId: string
    principalKeyHash: string
    principalKind: 'api_key' | 'firebase' | 'oidc'
    familyId?: string
  },
): Promise<Record<string, unknown>> {
  const accessToken = randomToken('wko_')
  const familyId = args.familyId ?? randomUUID()
  const accessTtlMs = config.oauthAccessTokenTtlMs ?? 60 * 60 * 1000
  await db.insert(
    'wk_oauth_access_tokens',
    {
      token_hash: hashApiKey(accessToken, config.keyPepper),
      client_id: args.clientId,
      scopes: args.scopes,
      resource: args.resource,
      principal_name: args.principalName,
      principal_space_id: args.principalSpaceId,
      principal_key_id: args.principalKeyId,
      principal_key_hash: args.principalKeyHash,
      principal_kind: args.principalKind,
      family_id: familyId,
      expires_at: new Date(Date.now() + accessTtlMs).toISOString(),
    },
    { returning: false },
  )
  const response: Record<string, unknown> = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(accessTtlMs / 1000),
    scope: args.scopes.join(' '),
  }
  if (args.scopes.includes('offline_access')) {
    const refreshToken = randomToken('wkr_')
    await db.insert(
      'wk_oauth_refresh_tokens',
      {
        token_hash: hashApiKey(refreshToken, config.keyPepper),
        client_id: args.clientId,
        scopes: args.scopes,
        resource: args.resource,
        principal_name: args.principalName,
        principal_space_id: args.principalSpaceId,
        principal_key_id: args.principalKeyId,
        principal_key_hash: args.principalKeyHash,
        principal_kind: args.principalKind,
        family_id: familyId,
        expires_at: new Date(Date.now() + (config.oauthRefreshTokenTtlMs ?? 30 * 24 * 60 * 60 * 1000)).toISOString(),
      },
      { returning: false },
    )
    response.refresh_token = refreshToken
  }
  return response
}

export interface OAuthMount {
  handler: RawHandler
  cleanup(): Promise<OAuthCleanupReport>
  stop(): void
}

export function createOAuthMount(config: Config, deps: { db: Db; auth: Auth; logger: Logger }): OAuthMount {
  const dcrBuckets = new Map<string, { count: number; resetAt: number }>()

  function dcrAllowed(req: Request): boolean {
    const address = config.trustProxy
      ? (req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-wikikit-remote-address') ??
        'unknown')
      : (req.headers.get('x-wikikit-remote-address') ?? 'unknown')
    const now = Date.now()
    const current = dcrBuckets.get(address)
    if (!current || current.resetAt <= now) {
      if (dcrBuckets.size >= 10_000) {
        for (const [key, value] of dcrBuckets) if (value.resetAt <= now) dcrBuckets.delete(key)
        if (dcrBuckets.size >= 10_000) return false
      }
      dcrBuckets.set(address, { count: 1, resetAt: now + 60_000 })
      return true
    }
    if (current.count >= DCR_MAX_PER_MINUTE) return false
    current.count += 1
    return true
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const base = config.publicUrl
    try {
      if (
        request.method === 'GET' &&
        ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)
      ) {
        return json({
          resource: resourceId(config),
          authorization_servers: [base],
          scopes_supported: [...OAUTH_SCOPES],
          bearer_methods_supported: ['header'],
        })
      }
      if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        return json({
          issuer: base,
          authorization_endpoint: `${base}/v1/oauth/authorize`,
          token_endpoint: `${base}/v1/oauth/token`,
          registration_endpoint: `${base}/v1/oauth/register`,
          revocation_endpoint: `${base}/v1/oauth/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: [...OAUTH_SCOPES],
        })
      }
      if (request.method === 'POST' && path === '/v1/oauth/register') {
        if (config.oauthDynamicRegistrationEnabled === false)
          throw new OAuthError('registration_not_supported', 'dynamic registration is disabled')
        if (!dcrAllowed(request)) throw new OAuthError('too_many_requests', 'registration rate limit exceeded', 429)
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        const redirectUris = body?.redirect_uris
        if (
          !Array.isArray(redirectUris) ||
          redirectUris.length < 1 ||
          redirectUris.length > 5 ||
          redirectUris.some((uri) => typeof uri !== 'string' || !isSafeRedirectUri(uri))
        ) {
          throw new OAuthError('invalid_client_metadata', 'redirect_uris must contain 1-5 safe callback URLs')
        }
        if (body?.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
          throw new OAuthError('invalid_client_metadata', 'only token_endpoint_auth_method=none is supported')
        }
        if (
          Array.isArray(body?.grant_types) &&
          body.grant_types.some((grant) => !['authorization_code', 'refresh_token'].includes(String(grant)))
        ) {
          throw new OAuthError('invalid_client_metadata', 'unsupported grant type')
        }
        if (Array.isArray(body?.response_types) && body.response_types.some((type) => type !== 'code')) {
          throw new OAuthError('invalid_client_metadata', 'only response_type=code is supported')
        }
        const clientId = `wkc_${randomBytes(24).toString('base64url')}`
        const clientName =
          typeof body?.client_name === 'string' && body.client_name.trim()
            ? body.client_name.trim().slice(0, 255)
            : 'MCP client'
        await deps.db.insert('wk_oauth_clients', {
          client_id: clientId,
          client_name: clientName,
          redirect_uris: redirectUris,
          token_endpoint_auth_method: 'none',
        })
        return json(
          {
            client_id: clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            client_name: clientName,
            redirect_uris: redirectUris,
            response_types: ['code'],
            grant_types: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_method: 'none',
          },
          201,
        )
      }
      if (request.method === 'GET' && path === '/v1/oauth/authorize') {
        const loaded = await loadAuthorizationRequest(config, deps.db, url.searchParams)
        if (interactiveLoginEnabled(config)) {
          const loginState = randomToken('wkl_')
          await deps.db.insert('wk_oauth_login_states', {
            state_hash: hashApiKey(loginState, config.keyPepper),
            client_id: loaded.client.client_id,
            redirect_uri: loaded.redirectUri,
            scopes: loaded.scopes,
            code_challenge: loaded.codeChallenge, // validated by loadAuthorizationRequest
            resource: loaded.resource,
            client_state: url.searchParams.get('state'),
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          })
          const oidcProviders = oidcEnabled(config) ? config.oauthOidcProviders || [] : []
          if (firebaseEnabled(config) && !oidcProviders.length) {
            return new Response(null, {
              status: 302,
              headers: { location: firebaseLoginUrl(config, loginState), 'cache-control': 'no-store' },
            })
          }
          if (!firebaseEnabled(config) && oidcProviders.length === 1) {
            const target = new URL(`${config.publicUrl}/v1/oauth/login`)
            target.searchParams.set('state', loginState)
            target.searchParams.set('provider', oidcProviders[0]!.id)
            return new Response(null, {
              status: 302,
              headers: { location: target.toString(), 'cache-control': 'no-store' },
            })
          }
          return loginChoicePage({
            state: loginState,
            firebase: firebaseEnabled(config),
            oidc: oidcProviders.map((provider) => ({ id: provider.id, label: `Continue with ${provider.label}` })),
          })
        }
        return consentPage({
          clientName: loaded.client.client_name,
          params: url.searchParams,
          scopes: loaded.scopes,
          csrfToken: randomBytes(32).toString('base64url'),
          secureCookie: new URL(config.publicUrl).protocol === 'https:',
        })
      }
      if (request.method === 'GET' && path === '/v1/oauth/login') {
        const loginState = url.searchParams.get('state') || ''
        const providerId = url.searchParams.get('provider') || ''
        if (!/^wkl_[A-Za-z0-9_-]{43}$/.test(loginState))
          throw new OAuthError('invalid_request', 'valid login state is required')
        if (providerId === 'firebase' && firebaseEnabled(config)) {
          return new Response(null, {
            status: 302,
            headers: { location: firebaseLoginUrl(config, loginState), 'cache-control': 'no-store' },
          })
        }
        const provider = (config.oauthOidcProviders || []).find((candidate) => candidate.id === providerId)
        if (!provider || !oidcEnabled(config))
          throw new OAuthError('not_found', 'identity provider is not available', 404)
        const started = await startOidcLogin({
          provider,
          redirectUri: `${config.publicUrl}/v1/oauth/oidc/callback`,
          state: loginState,
        }).catch(() => {
          throw new OAuthError('temporarily_unavailable', 'OIDC provider discovery is unavailable', 503)
        })
        const changed = await deps.db.update(
          'wk_oauth_login_states',
          { state_hash: `eq.${hashApiKey(loginState, config.keyPepper)}`, consumed_at: 'is.null' },
          { provider_id: provider.id, oidc_nonce: started.nonce, oidc_code_verifier: started.codeVerifier },
        )
        if (!changed.length) throw new OAuthError('invalid_request', 'OAuth login state is expired or already used')
        return new Response(null, {
          status: 302,
          headers: { location: started.authorizationUrl, 'cache-control': 'no-store' },
        })
      }
      if (request.method === 'POST' && path === '/v1/oauth/firebase/callback') {
        if (!firebaseEnabled(config)) throw new OAuthError('not_found', 'Firebase OAuth login is disabled', 404)
        const params = new URLSearchParams(await request.text())
        const loginState = params.get('wikikit_oauth_state') || ''
        const idToken = params.get('id_token') || ''
        if (!/^wkl_[A-Za-z0-9_-]{43}$/.test(loginState) || !idToken) {
          throw new OAuthError('invalid_request', 'a valid Firebase OAuth login state and ID token are required')
        }
        const identity = await verifyFirebaseIdToken({
          token: idToken,
          projectId: config.oauthFirebaseProjectId || '',
          allowedEmails: config.oauthAllowedEmails || [],
        }).catch((error) => {
          throw new OAuthError(
            'access_denied',
            error instanceof Error ? error.message : 'Firebase login was rejected',
            403,
          )
        })
        const stateHash = hashApiKey(loginState, config.keyPepper)
        const { rows } = await deps.db.query<IdentityLoginStateRow>(
          `UPDATE wk_oauth_login_states
              SET provider_subject = $2, provider_email = $3, provider_id = 'firebase', authenticated_at = now()
            WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
              AND (provider_id IS NULL OR provider_id = 'firebase')
            RETURNING id, client_id, redirect_uri, scopes, code_challenge, resource, client_state,
                      provider_subject, provider_email, provider_id, oidc_nonce, oidc_code_verifier`,
          [stateHash, identity.subject, identity.email],
        )
        const state = rows[0]
        if (!state) throw new OAuthError('invalid_request', 'Firebase OAuth login state is expired or already used')
        await deps.db.query(
          `INSERT INTO wk_oauth_identities (provider_subject, email, provider, last_seen_at)
           VALUES ($1, $2, 'firebase', now())
           ON CONFLICT (provider, provider_subject) DO UPDATE
             SET email = excluded.email, last_seen_at = excluded.last_seen_at, revoked_at = null`,
          [identity.subject, identity.email],
        )
        const [client] = await deps.db.select<ClientRow>('wk_oauth_clients', {
          client_id: `eq.${state.client_id}`,
          limit: 1,
        })
        if (!client || client.revoked_at) throw new OAuthError('invalid_client', 'unknown or revoked client')
        return consentPage({
          clientName: client.client_name,
          params: new URLSearchParams(),
          scopes: state.scopes,
          csrfToken: randomBytes(32).toString('base64url'),
          secureCookie: new URL(config.publicUrl).protocol === 'https:',
          loginState,
          redirectUri: state.redirect_uri,
        })
      }
      if (request.method === 'GET' && path === '/v1/oauth/oidc/callback') {
        const loginState = url.searchParams.get('state') || ''
        if (!/^wkl_[A-Za-z0-9_-]{43}$/.test(loginState))
          throw new OAuthError('invalid_request', 'a valid OIDC login state is required')
        const { rows } = await deps.db.query<IdentityLoginStateRow>(
          `SELECT id, client_id, redirect_uri, scopes, code_challenge, resource, client_state,
                  provider_subject, provider_email, provider_id, oidc_nonce, oidc_code_verifier
             FROM wk_oauth_login_states
            WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
            LIMIT 1`,
          [hashApiKey(loginState, config.keyPepper)],
        )
        const state = rows[0]
        const provider = state?.provider_id
          ? (config.oauthOidcProviders || []).find((candidate) => candidate.id === state.provider_id)
          : undefined
        if (!state || !provider || !state.oidc_nonce || !state.oidc_code_verifier) {
          throw new OAuthError('invalid_request', 'OIDC login state is expired or invalid')
        }
        const identity = await finishOidcLogin({
          provider,
          redirectUri: `${config.publicUrl}/v1/oauth/oidc/callback`,
          callbackUrl: url,
          state: loginState,
          nonce: state.oidc_nonce,
          codeVerifier: state.oidc_code_verifier,
        }).catch((error) => {
          throw new OAuthError('access_denied', error instanceof Error ? error.message : 'OIDC login was rejected', 403)
        })
        const authenticated = await deps.db.update(
          'wk_oauth_login_states',
          { id: `eq.${state.id}`, consumed_at: 'is.null' },
          {
            provider_subject: identity.subject,
            provider_email: identity.email,
            authenticated_at: new Date().toISOString(),
          },
        )
        if (!authenticated.length) throw new OAuthError('invalid_request', 'OIDC login state was already consumed')
        await deps.db.query(
          `INSERT INTO wk_oauth_identities (provider_subject, email, provider, last_seen_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (provider, provider_subject) DO UPDATE
             SET email = excluded.email, last_seen_at = excluded.last_seen_at, revoked_at = null`,
          [identity.subject, identity.email, provider.id],
        )
        const [client] = await deps.db.select<ClientRow>('wk_oauth_clients', {
          client_id: `eq.${state.client_id}`,
          limit: 1,
        })
        if (!client || client.revoked_at) throw new OAuthError('invalid_client', 'unknown or revoked client')
        return consentPage({
          clientName: client.client_name,
          params: new URLSearchParams(),
          scopes: state.scopes,
          csrfToken: randomBytes(32).toString('base64url'),
          secureCookie: new URL(config.publicUrl).protocol === 'https:',
          loginState,
          redirectUri: state.redirect_uri,
        })
      }
      if (request.method === 'POST' && path === '/v1/oauth/authorize') {
        const params = new URLSearchParams(await request.text())
        const csrfToken = params.get('csrf_token') || ''
        const csrfCookie = cookieValue(request, 'wk_oauth_csrf') || ''
        if (!csrfToken || !csrfCookie || !safeEqualText(csrfToken, csrfCookie)) {
          throw new OAuthError('invalid_request', 'consent form CSRF validation failed')
        }
        let loaded: { client: ClientRow; redirectUri: string; scopes: string[]; resource: string }
        let codeChallenge = ''
        let principal: Principal | null = null
        let principalKeyHash = ''
        let principalKind: 'api_key' | 'firebase' | 'oidc' = 'api_key'
        let identityStateId: string | null = null
        let callbackState: string | undefined = params.get('state') ?? undefined
        if (interactiveLoginEnabled(config)) {
          const loginState = params.get('login_state') || ''
          if (!/^wkl_[A-Za-z0-9_-]{43}$/.test(loginState))
            throw new OAuthError('invalid_request', 'interactive OAuth login state is required')
          const { rows } = await deps.db.query<IdentityLoginStateRow>(
            `SELECT s.id, s.client_id, s.redirect_uri, s.scopes, s.code_challenge, s.resource, s.client_state,
                    s.provider_subject, s.provider_email, s.provider_id, s.oidc_nonce, s.oidc_code_verifier
               FROM wk_oauth_login_states s
               JOIN wk_oauth_clients c ON c.client_id = s.client_id
              WHERE s.state_hash = $1 AND s.consumed_at IS NULL AND s.expires_at > now()
                AND s.authenticated_at IS NOT NULL AND c.revoked_at IS NULL
              LIMIT 1`,
            [hashApiKey(loginState, config.keyPepper)],
          )
          const state = rows[0]
          if (!state?.provider_subject || !state.provider_email)
            throw new OAuthError('invalid_request', 'interactive OAuth login is no longer valid')
          const [client] = await deps.db.select<ClientRow>('wk_oauth_clients', {
            client_id: `eq.${state.client_id}`,
            limit: 1,
          })
          if (!client || client.revoked_at) throw new OAuthError('invalid_client', 'unknown or revoked client')
          // Pre-federation Firebase states have no provider_id. They remain
          // valid during a rolling deploy and are unambiguously Firebase when
          // this mount exposes Firebase as its only interactive provider.
          const providerId = state.provider_id || (firebaseEnabled(config) ? 'firebase' : '')
          const providerScopes = providerAllowedScopes(config, providerId)
          if (!providerScopes.length)
            throw new OAuthError('access_denied', 'identity provider is no longer authorized', 403)
          loaded = { client, redirectUri: state.redirect_uri, scopes: state.scopes, resource: state.resource }
          principal = {
            keyId:
              providerId === 'firebase'
                ? `firebase:${state.provider_subject}`
                : `oidc:${providerId}:${state.provider_subject}`,
            name: state.provider_email,
            scopes: providerScopes,
            spaceId: null,
          }
          principalKeyHash = hashApiKey(principal.keyId, config.keyPepper)
          principalKind = providerId === 'firebase' ? 'firebase' : 'oidc'
          identityStateId = state.id
          callbackState = state.client_state ?? undefined
          codeChallenge = state.code_challenge || ''
        } else {
          const request = await loadAuthorizationRequest(config, deps.db, params)
          loaded = request
          codeChallenge = request.codeChallenge
        }
        if (params.get('action') === 'deny') {
          if (identityStateId) {
            await deps.db.update(
              'wk_oauth_login_states',
              { id: `eq.${identityStateId}`, consumed_at: 'is.null' },
              { consumed_at: new Date().toISOString() },
            )
          }
          return clearCsrfCookie(
            redirectWith(loaded.redirectUri, {
              error: 'access_denied',
              state: callbackState,
            }),
            new URL(config.publicUrl).protocol === 'https:',
          )
        }
        if (!principal) {
          const apiKey = params.get('api_key') || ''
          principalKeyHash = hashApiKey(apiKey, config.keyPepper)
          try {
            principal = await deps.auth.authenticate(`Bearer ${apiKey}`)
            if (principal.keyId.startsWith('oauth:')) throw new Error('an operator API key is required')
            for (const scope of loaded.scopes) {
              if (scope !== 'offline_access')
                deps.auth.requireScope(
                  principal,
                  scope as 'knowledge:read' | 'knowledge:propose' | 'knowledge:review' | 'knowledge:approve',
                )
            }
          } catch {
            return consentPage({
              clientName: loaded.client.client_name,
              params,
              scopes: loaded.scopes,
              error: 'The API key is invalid or lacks one of the requested scopes.',
              csrfToken,
              secureCookie: new URL(config.publicUrl).protocol === 'https:',
            })
          }
        }
        for (const scope of loaded.scopes)
          if (scope !== 'offline_access')
            deps.auth.requireScope(
              principal,
              scope as 'knowledge:read' | 'knowledge:propose' | 'knowledge:review' | 'knowledge:approve',
            )
        // Request-boundary PKCE guard for BOTH branches: whether the challenge
        // came from the consent form (re-validated by loadAuthorizationRequest)
        // or a stored login state (possibly written by an older binary without
        // one), an invalid challenge is the CLIENT's error — 400
        // invalid_request, never a 500 from the codes table's NOT NULL
        // constraint at consent time.
        if (!PKCE_CHALLENGE.test(codeChallenge)) {
          throw new OAuthError('invalid_request', 'a valid S256 PKCE code_challenge is required')
        }
        const code = randomToken('wka_')
        await deps.db.tx(async (tx) => {
          if (identityStateId) {
            const changed = await tx.update(
              'wk_oauth_login_states',
              { id: `eq.${identityStateId}`, consumed_at: 'is.null' },
              { consumed_at: new Date().toISOString() },
            )
            if (!changed.length)
              throw new OAuthError('invalid_request', 'interactive OAuth login state is already consumed')
          }
          await tx.insert(
            'wk_oauth_authorization_codes',
            {
              code_hash: hashApiKey(code, config.keyPepper),
              client_id: loaded.client.client_id,
              redirect_uri: loaded.redirectUri,
              scopes: loaded.scopes,
              code_challenge: codeChallenge,
              resource: loaded.resource,
              principal_name: principal.name,
              principal_space_id: principal.spaceId,
              principal_key_id: principal.keyId,
              principal_key_hash: principalKeyHash,
              principal_kind: principalKind,
              expires_at: new Date(Date.now() + (config.oauthAuthorizationCodeTtlMs ?? 10 * 60 * 1000)).toISOString(),
            },
            { returning: false },
          )
        })
        return clearCsrfCookie(
          redirectWith(loaded.redirectUri, { code, state: callbackState }),
          new URL(config.publicUrl).protocol === 'https:',
        )
      }
      if (request.method === 'POST' && path === '/v1/oauth/token') {
        const params = new URLSearchParams(await request.text())
        const grantType = params.get('grant_type')
        const clientId = params.get('client_id') || ''
        if (!clientId) throw new OAuthError('invalid_request', 'client_id is required')
        if (grantType === 'authorization_code') {
          const code = params.get('code') || ''
          const verifier = params.get('code_verifier') || ''
          const redirectUri = params.get('redirect_uri') || ''
          const resource = params.get('resource') || resourceId(config)
          if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !redirectUri) {
            throw new OAuthError('invalid_request', 'code, redirect_uri and a valid code_verifier are required')
          }
          if (resource !== resourceId(config))
            throw new OAuthError('invalid_target', 'resource does not identify this MCP server')
          const tokens = await deps.db.tx(async (tx) => {
            const { rows } = await tx.query<CodeRow>(
              `SELECT a.id, a.scopes, a.code_challenge, a.principal_name, a.principal_space_id,
                      a.principal_key_id, a.principal_key_hash, a.principal_kind
                 FROM wk_oauth_authorization_codes a
                 JOIN wk_oauth_clients c ON c.client_id = a.client_id
                WHERE a.code_hash = $1 AND a.client_id = $2 AND a.redirect_uri = $3
                  AND a.resource = $4 AND a.consumed_at IS NULL AND a.expires_at > now()
                  AND c.revoked_at IS NULL
                  AND (
                    a.principal_kind IN ('firebase', 'oidc')
                    OR a.principal_key_id = 'bootstrap'
                    OR EXISTS (
                      SELECT 1 FROM wk_api_keys k
                       WHERE k.id::text = a.principal_key_id
                         AND k.key_hash = a.principal_key_hash
                         AND k.revoked_at IS NULL
                    )
                  )
                FOR UPDATE OF a`,
              [hashApiKey(code, config.keyPepper), clientId, redirectUri, resource],
            )
            const row = rows[0]
            if (
              !row ||
              !bootstrapGrantIsCurrent(config, row) ||
              !(await identityGrantIsCurrent(tx, config, row)) ||
              !safeEqualText(pkceChallenge(verifier), row.code_challenge)
            ) {
              throw new OAuthError('invalid_grant', 'authorization code is invalid, expired or already used')
            }
            await tx.update(
              'wk_oauth_authorization_codes',
              { id: `eq.${row.id}` },
              { consumed_at: new Date().toISOString() },
              { returning: false },
            )
            const tokens = await issueTokens(config, tx, {
              clientId,
              scopes: row.scopes,
              resource,
              principalName: row.principal_name,
              principalSpaceId: row.principal_space_id,
              principalKeyId: row.principal_key_id,
              principalKeyHash: row.principal_key_hash,
              principalKind: row.principal_kind,
            })
            return tokens
          })
          return json(tokens)
        }
        if (grantType === 'refresh_token') {
          const refreshToken = params.get('refresh_token') || ''
          if (!refreshToken) throw new OAuthError('invalid_request', 'refresh_token is required')
          const outcome = await deps.db.tx(async (tx) => {
            const { rows } = await tx.query<RefreshRow>(
              `SELECT r.id, r.scopes, r.resource, r.principal_name, r.principal_space_id,
                      r.principal_key_id, r.principal_key_hash, r.principal_kind, r.family_id,
                      r.expires_at, r.revoked_at
                 FROM wk_oauth_refresh_tokens r
                 JOIN wk_oauth_clients c ON c.client_id = r.client_id
                WHERE r.token_hash = $1 AND r.client_id = $2
                  AND c.revoked_at IS NULL
                  AND (
                    r.principal_kind IN ('firebase', 'oidc')
                    OR r.principal_key_id = 'bootstrap'
                    OR EXISTS (
                      SELECT 1 FROM wk_api_keys k
                       WHERE k.id::text = r.principal_key_id
                         AND k.key_hash = r.principal_key_hash
                         AND k.revoked_at IS NULL
                    )
                  )
                FOR UPDATE OF r`,
              [hashApiKey(refreshToken, config.keyPepper), clientId],
            )
            const row = rows[0]
            if (!row || !bootstrapGrantIsCurrent(config, row) || !(await identityGrantIsCurrent(tx, config, row))) {
              throw new OAuthError('invalid_grant', 'refresh token is invalid, expired or already used')
            }
            const now = new Date()
            const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)
            if (row.revoked_at) {
              await revokeFamily(tx, row.family_id, now.toISOString())
              return {
                error: new OAuthError(
                  'invalid_grant',
                  'refresh token replay detected; the complete token family was revoked',
                ),
              } as const
            }
            if (expiresAt <= now) {
              return { error: new OAuthError('invalid_grant', 'refresh token is expired') } as const
            }
            const requested = params.get('scope') ? parseScopes(params.get('scope')) : row.scopes
            if (requested.some((scope) => !row.scopes.includes(scope)))
              throw new OAuthError('invalid_scope', 'refresh cannot add scopes')
            await tx.update(
              'wk_oauth_refresh_tokens',
              { id: `eq.${row.id}` },
              { revoked_at: new Date().toISOString() },
              { returning: false },
            )
            const tokens = await issueTokens(config, tx, {
              clientId,
              scopes: requested,
              resource: row.resource,
              principalName: row.principal_name,
              principalSpaceId: row.principal_space_id,
              principalKeyId: row.principal_key_id,
              principalKeyHash: row.principal_key_hash,
              principalKind: row.principal_kind,
              familyId: row.family_id,
            })
            return { tokens } as const
          })
          if ('error' in outcome) throw outcome.error
          return json(outcome.tokens)
        }
        throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
      }
      if (request.method === 'POST' && path === '/v1/oauth/revoke') {
        const token = new URLSearchParams(await request.text()).get('token') || ''
        if (token && config.keyPepper) {
          const tokenHash = hashApiKey(token, config.keyPepper)
          const revokedAt = new Date().toISOString()
          await deps.db.query(
            `UPDATE wk_oauth_access_tokens SET revoked_at = coalesce(revoked_at, $2) WHERE token_hash = $1`,
            [tokenHash, revokedAt],
          )
          const { rows } = await deps.db.query<{ family_id: string }>(
            `UPDATE wk_oauth_refresh_tokens
                SET revoked_at = coalesce(revoked_at, $2)
              WHERE token_hash = $1
              RETURNING family_id`,
            [tokenHash, revokedAt],
          )
          if (rows[0]) await revokeFamily(deps.db, rows[0].family_id, revokedAt)
        }
        return json({})
      }
      return json({ error: 'not_found' }, 404)
    } catch (error) {
      if (!(error instanceof OAuthError)) {
        deps.logger.error('oauth request failed', {
          path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return oauthError(error)
    }
  }

  const handler: RawHandler = async (req, res) => {
    try {
      const method = req.method ?? 'GET'
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry))
        else headers.set(name, value)
      }
      // Internal transport metadata for DCR rate limiting. Overwrite any
      // client-supplied value so it cannot be spoofed.
      headers.set('x-wikikit-remote-address', req.socket.remoteAddress ?? 'unknown')
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readCappedBody(req, MAX_FORM_BYTES)
      headers.delete('content-length')
      headers.delete('transfer-encoding')
      const request = new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`, {
        method,
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
      } as RequestInit)
      const response = await handle(request)
      res.statusCode = response.status
      response.headers.forEach((value, name) => res.setHeader(name, value))
      res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined)
    } catch (error) {
      const response = oauthError(error)
      res.statusCode = response.status
      response.headers.forEach((value, name) => res.setHeader(name, value))
      res.end(Buffer.from(await response.arrayBuffer()))
    }
  }

  // Same cadence as Subkit's operational sweep. The timer is unref'd so it
  // never pins tests or a graceful shutdown; App.close() still clears it.
  const cleanupTimer = setInterval(
    () => {
      cleanupOAuthRows(deps.db)
        .then((report) => deps.logger.info('oauth housekeeping completed', { ...report }))
        .catch((error) =>
          deps.logger.error('oauth housekeeping failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
    },
    60 * 60 * 1000,
  )
  cleanupTimer.unref()

  return {
    handler,
    cleanup: () => cleanupOAuthRows(deps.db),
    stop: () => clearInterval(cleanupTimer),
  }
}
