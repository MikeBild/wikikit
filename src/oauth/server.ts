// OAuth 2.1 authorization server for remote MCP clients (ChatGPT, Claude.ai,
// Cursor). API keys remain the operator login credential; this surface turns
// one successful, explicit consent into short-lived scoped OAuth tokens.
// Plaintext API keys, authorization codes and tokens are never persisted.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config, OidcProviderConfig } from '../config.ts'
import type { Db } from '../db/postgres.ts'
import type { Auth, Principal } from '../http/auth.ts'
import { hashApiKey } from '../http/auth.ts'
import type { RawHandler } from '../http/server.ts'
import type { Logger } from '../logger.ts'
import { cleanupOAuthRows, type OAuthCleanupReport } from './cleanup.ts'
import {
  isOidcIdentityAllowed,
  OIDC_SIGNUP_SCOPES,
  oidcIdentityScopeCeiling,
  type OidcIdentity,
} from './identity-policy.ts'
import { finishOidcLogin, startOidcLogin, verifyOidcIdentityToken } from './oidc.ts'
import { authHtmlResponse, renderApiKeyLogin, renderConsentPage, renderErrorPage, renderProviderChoice } from './ui.ts'

const OAUTH_SCOPES = [
  'knowledge:read',
  'knowledge:propose',
  'knowledge:review',
  'knowledge:approve',
  'offline_access',
] as const
/**
 * Scope set the /mcp 401 WWW-Authenticate challenge advertises: the FULL
 * knowledge permission set from scopes_supported, so MCP clients also offer
 * review/approve checkboxes on their consent surface (clamping to the
 * identity's actual ceiling stays in the consent logic). offline_access is a
 * token-mechanics scope, not a permission, and is deliberately not advertised.
 */
export const OAUTH_CHALLENGE_SCOPE = OAUTH_SCOPES.filter((scope) => scope !== 'offline_access').join(' ')
// A client must opt in to the review right. Adding support must never silently
// turn existing read/propose integrations into approvers on reconnect.
const DEFAULT_SCOPE = 'knowledge:read knowledge:propose offline_access'
const DCR_MAX_PER_MINUTE = 10
const MAX_FORM_BYTES = 32 * 1024
// Human-facing GET surfaces of the browser login funnel. Failures here render
// an HTML error page in the shared TOKENS shell; the JSON {error,
// error_description} envelope stays reserved for the non-browser endpoints
// (token/register/API) and for callers that ask for application/json.
const BROWSER_FUNNEL_PATHS = ['/v1/oauth/authorize', '/v1/identity/login/start', '/v1/identity/login/callback']
const NOT_AUTHORIZED_MESSAGE = 'Your account is not authorized for WikiKit. Contact the operator.'
const STATE_PROBLEM_MESSAGE = 'This sign-in attempt expired or was already used. Please sign in again.'

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
  principal_kind: 'api_key' | 'identity'
}

interface RefreshRow {
  id: string
  scopes: string[]
  resource: string
  principal_name: string
  principal_space_id: string | null
  principal_key_id: string
  principal_key_hash: string
  principal_kind: 'api_key' | 'identity'
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

interface OperatorSessionRow {
  id: string
  principal_kind: 'api_key' | 'identity'
  principal_key_id: string
  principal_key_hash: string
  principal_name: string
  principal_space_id: string | null
  provider_id: string | null
  provider_subject: string | null
  scopes: string[]
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

// Headers.forEach folds repeated set-cookie headers into one comma-joined
// value, which user agents cannot split safely — the consent response sets
// TWO cookies (CSRF + operator session), so set-cookie must be copied via
// getSetCookie() as distinct header values.
function writeResponseHeaders(res: ServerResponse, response: Response): void {
  const setCookies = response.headers.getSetCookie()
  if (setCookies.length) res.setHeader('set-cookie', setCookies)
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value)
  })
}

function oauthError(error: unknown): Response {
  const known = error instanceof OAuthError ? error : new OAuthError('server_error', 'authorization server error', 500)
  return json({ error: known.error, error_description: known.description }, known.status)
}

function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json')
}

function browserErrorMessage(error: OAuthError): string {
  if (error.error === 'access_denied') return NOT_AUTHORIZED_MESSAGE
  if (/state/i.test(error.description)) return STATE_PROBLEM_MESSAGE
  return error.description
}

// RFC 6749 §4.1.2.1 error redirect for the waiting OAuth client — the same
// shape the consent deny path issues, but as a URL the error page can link.
function clientErrorRedirectUrl(redirectUri: string, clientState: string | null): string {
  const target = new URL(redirectUri)
  target.searchParams.set('error', 'access_denied')
  if (clientState) target.searchParams.set('state', clientState)
  return target.toString()
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

function operatorCookie(config: Config, token: string, maxAge = 8 * 60 * 60): string {
  const secure = new URL(config.publicUrl).protocol === 'https:'
  const name = secure ? '__Host-wikikit_operator' : 'wikikit_operator'
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

function operatorToken(request: Request, config: Config): string {
  const secure = new URL(config.publicUrl).protocol === 'https:'
  return cookieValue(request, secure ? '__Host-wikikit_operator' : 'wikikit_operator') ?? ''
}

function withOperatorCookie(response: Response, config: Config, token: string, maxAge?: number): Response {
  response.headers.append('set-cookie', operatorCookie(config, token, maxAge))
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

function oidcProvider(config: Config, id: string | null | undefined): OidcProviderConfig | undefined {
  return config.oauthProviders?.find(
    (provider): provider is OidcProviderConfig => provider.protocol === 'oidc' && provider.id === id,
  )
}

function apiKeyLoginEnabled(config: Config): boolean {
  return !!config.oauthProviders?.some((provider) => provider.protocol === 'api_key')
}

function loginOptions(
  config: Pick<Config, 'oauthProviders'>,
): Array<{ id: string; protocol: 'api_key' | 'oidc'; label: string }> {
  return (config.oauthProviders ?? [])
    .map(({ id, protocol, label }) => ({ id, protocol, label }))
    .sort((left, right) => Number(left.protocol === 'api_key') - Number(right.protocol === 'api_key'))
}

export function publicLoginProviders(config: Pick<Config, 'oauthProviders'>): Array<{
  protocol: 'api_key' | 'oidc'
  id: string
  label: 'API key' | 'SSO'
  issuer?: string
}> {
  const configured = config.oauthProviders ?? []
  return loginOptions(config).map(({ id, protocol }) => {
    const provider = configured.find((candidate) => candidate.id === id)
    return {
      protocol,
      id,
      label: protocol === 'api_key' ? 'API key' : 'SSO',
      ...(provider?.protocol === 'oidc' ? { issuer: provider.issuer } : {}),
    }
  })
}

// Per-identity permission ceiling: the wk_oauth_identities row is the single
// AuthZ truth (0028). null = the identity is not (or no longer) admitted; a
// revoked row denies here regardless of the ENV allowlist.
async function identityCeiling(
  db: Db,
  config: Config,
  providerId: string | null,
  subject: string | null,
): Promise<string[] | null> {
  const provider = oidcProvider(config, providerId)
  if (!provider || !subject) return null
  const { rows } = await db.query<{ email: string | null; allowed_scopes: string[] | null; grant_source: string }>(
    `SELECT email, allowed_scopes, grant_source FROM wk_oauth_identities
      WHERE provider = $1 AND provider_subject = $2 AND revoked_at IS NULL
      LIMIT 1`,
    [provider.id, subject],
  )
  return oidcIdentityScopeCeiling(provider, subject, rows[0])
}

async function identityGrantIsCurrent(
  db: Db,
  config: Config,
  row: { principal_kind: string; principal_key_id: string },
): Promise<boolean> {
  if (row.principal_kind !== 'identity') return true
  const match = row.principal_key_id.match(/^identity:([a-z0-9][a-z0-9-]{0,62}):(.+)$/)
  if (!match) return false
  return (await identityCeiling(db, config, match[1]!, match[2]!)) !== null
}

// Admission decision for an authenticated OIDC login identity, including its
// registration in wk_oauth_identities. Returns the identity's permission
// ceiling, or null when the login must be denied. The DB row is the single
// AuthZ truth (0028):
//
// - revoked_at ALWAYS wins: a revoked row denies even an allowlisted
//   identity, and no login path ever clears it — re-admission is exclusively
//   the operator's explicit restore over the admin REST.
// - ENV allowlist = bootstrap-only, mirrored into the DB: an allowlisted
//   login upserts the row (ceiling := provider.allowedScopes,
//   grant_source := 'bootstrap') ONLY while the row is missing or still
//   'bootstrap'. Operator-managed rows ('admin'/'seed', and 'signup') keep
//   their stored ceiling — only email/last_seen_at are refreshed.
// - Already-registered identity (stored allowed_scopes): admitted through
//   its row regardless of the allowlist and of the signup switch position.
// - Unknown identity: the signup branch — admitted and registered at the
//   minimal knowledge:read ceiling only when WIKIKIT_OAUTH_ENABLE_SIGNUP is
//   true; denied otherwise (exact pre-signup behavior).
async function admitOidcCallbackIdentity(
  db: Db,
  config: Config,
  provider: OidcProviderConfig,
  identity: OidcIdentity,
): Promise<string[] | null> {
  const { rows } = await db.query<{
    allowed_scopes: string[] | null
    revoked_at: Date | string | null
    grant_source: string
  }>(
    `SELECT allowed_scopes, revoked_at, grant_source FROM wk_oauth_identities
      WHERE provider = $1 AND provider_subject = $2
      LIMIT 1`,
    [provider.id, identity.subject],
  )
  const registered = rows[0]
  if (registered?.revoked_at) return null
  if (
    isOidcIdentityAllowed(provider, identity.subject, identity.email) &&
    (!registered || registered.grant_source === 'bootstrap')
  ) {
    // The DO UPDATE re-checks revoked_at: a concurrent revoke must never be
    // resurrected by an in-flight login.
    await db.query(
      `INSERT INTO wk_oauth_identities (provider_subject, email, provider, last_seen_at, allowed_scopes, grant_source)
       VALUES ($1, $2, $3, now(), $4, 'bootstrap')
       ON CONFLICT (provider, provider_subject) DO UPDATE
         SET email = excluded.email, last_seen_at = excluded.last_seen_at,
             allowed_scopes = excluded.allowed_scopes, grant_source = 'bootstrap'
       WHERE wk_oauth_identities.revoked_at IS NULL`,
      [identity.subject, identity.email, provider.id, provider.allowedScopes],
    )
    return provider.allowedScopes
  }
  if (registered) {
    if (!registered.allowed_scopes?.length) return null
    await db.query(
      `UPDATE wk_oauth_identities SET email = $3, last_seen_at = now()
        WHERE provider = $1 AND provider_subject = $2 AND revoked_at IS NULL`,
      [provider.id, identity.subject, identity.email],
    )
    return registered.allowed_scopes
  }
  if (config.oauthSignupEnabled !== true) return null
  await db.query(
    `INSERT INTO wk_oauth_identities (provider_subject, email, provider, last_seen_at, allowed_scopes, grant_source)
     VALUES ($1, $2, $3, now(), $4, 'signup')
     ON CONFLICT (provider, provider_subject) DO NOTHING`,
    [identity.subject, identity.email, provider.id, [...OIDC_SIGNUP_SCOPES]],
  )
  return [...OIDC_SIGNUP_SCOPES]
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
    principalKind: 'api_key' | 'identity'
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

  async function currentOperator(request: Request): Promise<OperatorSessionRow | null> {
    const rawToken = operatorToken(request, config)
    if (!rawToken) return null
    const { rows } = await deps.db.query<OperatorSessionRow>(
      `SELECT id, principal_kind, principal_key_id, principal_key_hash, principal_name,
              principal_space_id, provider_id, provider_subject, scopes
         FROM wk_oauth_operator_sessions
        WHERE token_hash = $1 AND revoked_at IS NULL
          AND expires_at > now() AND absolute_expires_at > now()
        LIMIT 1`,
      [hashApiKey(rawToken, config.keyPepper)],
    )
    const session = rows[0]
    if (!session) return null
    if (session.principal_kind === 'api_key') {
      if (!bootstrapGrantIsCurrent(config, session)) {
        await deps.db.update(
          'wk_oauth_operator_sessions',
          { id: `eq.${session.id}` },
          { revoked_at: new Date().toISOString() },
          { returning: false },
        )
        return null
      }
      if (session.principal_key_id !== 'bootstrap') {
        const { rows: keys } = await deps.db.query<{ scopes: string[]; space_id: string | null; name: string }>(
          `SELECT scopes, space_id, name FROM wk_api_keys
            WHERE id::text = $1 AND key_hash = $2 AND revoked_at IS NULL
            LIMIT 1`,
          [session.principal_key_id, session.principal_key_hash],
        )
        if (!keys[0]) return null
        session.scopes = keys[0].scopes
        session.principal_space_id = keys[0].space_id
        session.principal_name = keys[0].name
      }
    } else {
      const ceiling = await identityCeiling(deps.db, config, session.provider_id, session.provider_subject)
      if (!ceiling) return null
      session.scopes = ceiling
    }
    await deps.db.query(
      `UPDATE wk_oauth_operator_sessions
          SET last_used_at = now(), expires_at = least(absolute_expires_at, now() + interval '8 hours')
        WHERE id = $1`,
      [session.id],
    )
    return session
  }

  async function createOperatorSession(args: {
    principalKind: 'api_key' | 'identity'
    principalKeyId: string
    principalKeyHash: string
    principalName: string
    principalSpaceId: string | null
    providerId?: string
    providerSubject?: string
    scopes: string[]
  }): Promise<{ row: OperatorSessionRow; token: string }> {
    const token = randomToken('wkos_')
    const now = Date.now()
    const [row] = await deps.db.insert<OperatorSessionRow>('wk_oauth_operator_sessions', {
      token_hash: hashApiKey(token, config.keyPepper),
      principal_kind: args.principalKind,
      principal_key_id: args.principalKeyId,
      principal_key_hash: args.principalKeyHash,
      principal_name: args.principalName,
      principal_space_id: args.principalSpaceId,
      provider_id: args.providerId ?? null,
      provider_subject: args.providerSubject ?? null,
      scopes: args.scopes,
      expires_at: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
      absolute_expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    })
    if (!row) throw new OAuthError('server_error', 'operator session could not be created', 500)
    return { row, token }
  }

  async function attachOperator(stateId: string, operator: OperatorSessionRow): Promise<void> {
    const changed = await deps.db.update(
      'wk_oauth_login_states',
      { id: `eq.${stateId}`, consumed_at: 'is.null' },
      {
        provider_id: operator.provider_id ?? 'api_key',
        provider_subject: operator.provider_subject ?? operator.principal_key_id,
        provider_email: operator.principal_name,
        authenticated_at: new Date().toISOString(),
      },
    )
    if (!changed.length) throw new OAuthError('invalid_request', 'authorization state expired or already used')
  }

  function offeredScopes(requested: string[], ceiling: string[]): string[] {
    const allowed = new Set(ceiling)
    const unrestricted = allowed.has('*') || allowed.has('admin')
    return requested.filter((scope) => scope === 'offline_access' || unrestricted || allowed.has(scope))
  }

  async function consentResponse(
    state: IdentityLoginStateRow,
    client: ClientRow,
    operator: OperatorSessionRow,
    rawState: string,
    setCookie?: string,
  ): Promise<Response> {
    const scopes = offeredScopes(state.scopes, operator.scopes)
    if (!scopes.includes('knowledge:read')) throw new OAuthError('access_denied', 'identity cannot read WikiKit', 403)
    const csrfToken = randomBytes(32).toString('base64url')
    const response = authHtmlResponse(
      renderConsentPage({
        clientName: client.client_name,
        identityLabel: operator.principal_name,
        targetLabel: operator.principal_space_id ? 'the permitted WikiKit space' : 'the permitted WikiKit spaces',
        offeredScopes: scopes,
        csrfToken,
        loginState: rawState,
      }),
    )
    response.headers.append(
      'set-cookie',
      `wk_oauth_csrf=${encodeURIComponent(csrfToken)}; HttpOnly; SameSite=Lax; Path=/v1/oauth/authorize; Max-Age=600${new URL(config.publicUrl).protocol === 'https:' ? '; Secure' : ''}`,
    )
    if (setCookie) response.headers.append('set-cookie', operatorCookie(config, setCookie))
    return response
  }

  async function loadLoginState(rawState: string): Promise<IdentityLoginStateRow | null> {
    if (!/^wkl_[A-Za-z0-9_-]{43}$/.test(rawState)) return null
    const { rows } = await deps.db.query<IdentityLoginStateRow>(
      `SELECT id, client_id, redirect_uri, scopes, code_challenge, resource, client_state,
              provider_subject, provider_email, provider_id, oidc_nonce, oidc_code_verifier
         FROM wk_oauth_login_states
        WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        LIMIT 1`,
      [hashApiKey(rawState, config.keyPepper)],
    )
    return rows[0] ?? null
  }

  // A dead login state renders a human-readable page instead of raw JSON.
  // When the row still physically exists (consumed or past TTL but not yet
  // swept), the waiting OAuth client is known and validated, so "Sign in
  // again" carries the RFC 6749 access_denied redirect back to the client's
  // redirect_uri — MCP connectors unblock instead of hanging on a callback
  // that will never come.
  async function loginStateErrorResponse(request: Request, rawState: string): Promise<Response> {
    if (wantsJson(request)) {
      return oauthError(new OAuthError('invalid_request', 'login state is expired, unknown or already used'))
    }
    let retryHref: string | undefined
    if (/^wkl_[A-Za-z0-9_-]{43}$/.test(rawState)) {
      const { rows } = await deps.db.query<{ client_id: string; redirect_uri: string; client_state: string | null }>(
        `SELECT client_id, redirect_uri, client_state
           FROM wk_oauth_login_states
          WHERE state_hash = $1
          LIMIT 1`,
        [hashApiKey(rawState, config.keyPepper)],
      )
      const row = rows[0]
      if (row) {
        const [client] = await deps.db.select<ClientRow>('wk_oauth_clients', {
          client_id: `eq.${row.client_id}`,
          limit: 1,
        })
        if (client && !client.revoked_at && client.redirect_uris.includes(row.redirect_uri)) {
          retryHref = clientErrorRedirectUrl(row.redirect_uri, row.client_state)
        }
      }
    }
    return authHtmlResponse(renderErrorPage({ message: STATE_PROBLEM_MESSAGE, retryHref }), 400)
  }

  function loginResponse(rawState: string): Response {
    const options = loginOptions(config)
    if (!options.length) throw new OAuthError('server_error', 'no OAuth login method is configured', 500)
    return authHtmlResponse(renderProviderChoice({ state: rawState, providers: options }))
  }

  async function createIdentitySession(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { provider_id?: unknown; identity_token?: unknown } | null
    const providerId = typeof body?.provider_id === 'string' ? body.provider_id : ''
    const identityToken = typeof body?.identity_token === 'string' ? body.identity_token : ''
    if (!providerId || !identityToken) {
      throw new OAuthError('invalid_request', 'provider_id and identity_token are required')
    }
    const provider = config.oauthProviders?.find((candidate) => candidate.id === providerId)
    if (!provider) throw new OAuthError('access_denied', 'identity provider is not configured', 403)
    if (provider.protocol === 'api_key') {
      throw new OAuthError('invalid_request', 'API key login does not accept identity assertions')
    }
    const identity = await verifyOidcIdentityToken({ provider, identityToken, allowUnknown: true }).catch(() => {
      throw new OAuthError('invalid_token', 'identity assertion was rejected', 401)
    })
    // Same admission contract as the browser callback: the DB row is the
    // single AuthZ truth, the ENV allowlist only bootstraps/mirrors it, and a
    // revoked row denies — no login path resurrects it.
    const ceiling = await admitOidcCallbackIdentity(deps.db, config, provider, identity)
    if (!ceiling) throw new OAuthError('access_denied', 'identity is not allowed to access WikiKit', 403)
    const issued = await deps.auth.createKey({
      name: `SSO ${identity.email ?? identity.subject}`,
      scopes: ceiling,
      spaceId: null,
    })
    const principalId = `wki_${createHash('sha256')
      .update(`${provider.id}\u0000${identity.subject}`)
      .digest('base64url')}`
    deps.logger.info('identity API key issued', { provider_id: provider.id, principal_id: principalId })
    return json({ api_key: issued.key, principal_id: principalId, context_id: null, email: identity.email })
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const base = config.publicUrl
    try {
      if (request.method === 'GET' && path === '/v1/identity/providers') {
        return json({ providers: publicLoginProviders(config) })
      }
      if (request.method === 'POST' && path === '/v1/identity/sessions') {
        return await createIdentitySession(request)
      }
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
        const loginState = randomToken('wkl_')
        const operator = await currentOperator(request)
        const [state] = await deps.db.insert<IdentityLoginStateRow>('wk_oauth_login_states', {
          state_hash: hashApiKey(loginState, config.keyPepper),
          client_id: loaded.client.client_id,
          redirect_uri: loaded.redirectUri,
          scopes: loaded.scopes,
          code_challenge: loaded.codeChallenge,
          resource: loaded.resource,
          client_state: url.searchParams.get('state'),
          provider_id: operator?.provider_id ?? (operator ? 'api_key' : null),
          provider_subject: operator?.provider_subject ?? operator?.principal_key_id ?? null,
          provider_email: operator?.principal_name ?? null,
          authenticated_at: operator ? new Date().toISOString() : null,
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        })
        if (!state) throw new OAuthError('server_error', 'authorization state could not be created', 500)
        if (operator) return await consentResponse(state, loaded.client, operator, loginState)
        const chooser = new URL('/v1/identity/login/start', config.publicUrl)
        chooser.searchParams.set('login_state', loginState)
        return new Response(null, {
          status: 302,
          headers: { location: chooser.toString(), 'cache-control': 'no-store' },
        })
      }
      if (request.method === 'POST' && path === '/v1/identity/login/start') {
        const params = new URLSearchParams(await request.text())
        const providerId = params.get('provider') || ''
        const configuredProvider = config.oauthProviders?.find(
          (provider) => provider.id === providerId && provider.protocol === 'api_key',
        )
        if (!configuredProvider || !apiKeyLoginEnabled(config)) {
          throw new OAuthError('not_found', 'identity provider is not available', 404)
        }
        const loginState = params.get('login_state') || ''
        const state = await loadLoginState(loginState)
        if (!state) throw new OAuthError('invalid_request', 'authorization state expired')
        const apiKey = params.get('api_key') || ''
        let principal: Principal
        try {
          principal = await deps.auth.authenticate(`Bearer ${apiKey}`)
          if (principal.keyId.startsWith('oauth:')) throw new Error('operator API key required')
        } catch {
          return authHtmlResponse(
            renderApiKeyLogin({
              state: loginState,
              providerId: configuredProvider.id,
              error: 'The API key is invalid or expired.',
            }),
            401,
          )
        }
        const session = await createOperatorSession({
          principalKind: 'api_key',
          principalKeyId: principal.keyId,
          principalKeyHash: hashApiKey(apiKey, config.keyPepper),
          principalName: principal.name,
          principalSpaceId: principal.spaceId,
          scopes: principal.scopes,
        })
        await attachOperator(state.id, session.row)
        const [client] = await deps.db.select<ClientRow>('wk_oauth_clients', {
          client_id: `eq.${state.client_id}`,
          limit: 1,
        })
        if (!client || client.revoked_at) throw new OAuthError('invalid_client', 'unknown or revoked client')
        return await consentResponse(state, client, session.row, loginState, session.token)
      }
      if (request.method === 'GET' && path === '/v1/identity/login/start') {
        const loginState = url.searchParams.get('login_state') || ''
        const providerId = url.searchParams.get('provider') || ''
        if (!/^wkl_[A-Za-z0-9_-]{43}$/.test(loginState))
          throw new OAuthError('invalid_request', 'valid login state is required')
        const configuredProvider = config.oauthProviders?.find((candidate) => candidate.id === providerId)
        const state = await loadLoginState(loginState)
        if (!state) return await loginStateErrorResponse(request, loginState)
        if (!providerId) return loginResponse(loginState)
        if (configuredProvider?.protocol === 'api_key') {
          return authHtmlResponse(renderApiKeyLogin({ state: loginState, providerId: configuredProvider.id }))
        }
        const provider = oidcProvider(config, providerId)
        if (!provider) throw new OAuthError('not_found', 'identity provider is not available', 404)
        // Every "Continue with SSO" click mints its OWN login state carrying
        // its own nonce and PKCE verifier. Overwriting the pending row would
        // break the Back-button flow: the first IdP callback fails its nonce
        // check the moment a second click rotates the stored values. The
        // chooser state is never touched and stays valid until its TTL.
        const ssoState = randomToken('wkl_')
        const started = await startOidcLogin({
          provider,
          redirectUri: `${config.publicUrl}/v1/identity/login/callback`,
          state: ssoState,
        }).catch(() => {
          throw new OAuthError('temporarily_unavailable', 'OIDC provider discovery is unavailable', 503)
        })
        const [ssoRow] = await deps.db.insert<IdentityLoginStateRow>('wk_oauth_login_states', {
          state_hash: hashApiKey(ssoState, config.keyPepper),
          client_id: state.client_id,
          redirect_uri: state.redirect_uri,
          scopes: state.scopes,
          code_challenge: state.code_challenge,
          resource: state.resource,
          client_state: state.client_state,
          provider_id: provider.id,
          oidc_nonce: started.nonce,
          oidc_code_verifier: started.codeVerifier,
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        })
        if (!ssoRow) throw new OAuthError('server_error', 'authorization state could not be created', 500)
        return new Response(null, {
          status: 302,
          headers: { location: started.authorizationUrl, 'cache-control': 'no-store' },
        })
      }
      if (request.method === 'GET' && path === '/v1/identity/login/callback') {
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
        const provider = oidcProvider(config, state?.provider_id)
        if (!state || !provider || !state.oidc_nonce || !state.oidc_code_verifier) {
          return await loginStateErrorResponse(request, loginState)
        }
        const [client] = await deps.db.select<ClientRow>('wk_oauth_clients', {
          client_id: `eq.${state.client_id}`,
          limit: 1,
        })
        if (!client || client.revoked_at) throw new OAuthError('invalid_client', 'unknown or revoked client')
        let identity: OidcIdentity
        try {
          // allowUnknown: the allowlist decision is NOT made inside the code
          // exchange — an unknown identity must reach the admission logic
          // below, where the signup branch runs before the rejection.
          identity = await finishOidcLogin({
            provider,
            redirectUri: `${config.publicUrl}/v1/identity/login/callback`,
            callbackUrl: url,
            state: loginState,
            nonce: state.oidc_nonce,
            codeVerifier: state.oidc_code_verifier,
            allowUnknown: true,
          })
        } catch (error) {
          // Identity-policy denial or code-exchange failure in the browser
          // funnel: the human gets a readable page, and — reusing the consent
          // deny-path contract — the validated waiting client gets the RFC
          // 6749 error=access_denied redirect behind "Sign in again", so MCP
          // clients never hang. The state is consumed like any denial.
          await deps.db.update(
            'wk_oauth_login_states',
            { id: `eq.${state.id}`, consumed_at: 'is.null' },
            { consumed_at: new Date().toISOString() },
            { returning: false },
          )
          const denied = error instanceof Error && /not allowed/.test(error.message)
          const retryHref = client.redirect_uris.includes(state.redirect_uri)
            ? clientErrorRedirectUrl(state.redirect_uri, state.client_state)
            : undefined
          return authHtmlResponse(
            renderErrorPage({ message: denied ? NOT_AUTHORIZED_MESSAGE : STATE_PROBLEM_MESSAGE, retryHref }),
            denied ? 403 : 400,
          )
        }
        // Admission + registration: allowlist first (unchanged), then the
        // already-registered signup identity, then — only with
        // WIKIKIT_OAUTH_ENABLE_SIGNUP — self-signup of a truly unknown
        // identity at the minimal knowledge:read ceiling.
        const ceiling = await admitOidcCallbackIdentity(deps.db, config, provider, identity)
        if (!ceiling) {
          // Exact pre-signup denial: consume the state like a consent deny
          // and answer the human with the styled not-authorized page; the
          // waiting OAuth client gets the RFC 6749 access_denied redirect
          // behind "Sign in again".
          await deps.db.update(
            'wk_oauth_login_states',
            { id: `eq.${state.id}`, consumed_at: 'is.null' },
            { consumed_at: new Date().toISOString() },
            { returning: false },
          )
          const retryHref = client.redirect_uris.includes(state.redirect_uri)
            ? clientErrorRedirectUrl(state.redirect_uri, state.client_state)
            : undefined
          return authHtmlResponse(renderErrorPage({ message: NOT_AUTHORIZED_MESSAGE, retryHref }), 403)
        }
        const authenticated = await deps.db.update(
          'wk_oauth_login_states',
          { id: `eq.${state.id}`, consumed_at: 'is.null' },
          {
            provider_subject: identity.subject,
            provider_email: identity.email,
            authenticated_at: new Date().toISOString(),
          },
        )
        if (!authenticated.length) return await loginStateErrorResponse(request, loginState)
        const session = await createOperatorSession({
          principalKind: 'identity',
          principalKeyId: `identity:${provider.id}:${identity.subject}`,
          principalKeyHash: hashApiKey(`identity:${provider.id}:${identity.subject}`, config.keyPepper),
          principalName: identity.email ?? identity.subject,
          principalSpaceId: null,
          providerId: provider.id,
          providerSubject: identity.subject,
          scopes: ceiling,
        })
        return await consentResponse(state, client, session.row, loginState, session.token)
      }
      if (request.method === 'POST' && path === '/v1/oauth/authorize/decision') {
        const params = new URLSearchParams(await request.text())
        const csrfToken = params.get('csrf_token') || ''
        const csrfCookie = cookieValue(request, 'wk_oauth_csrf') || ''
        if (!csrfToken || !csrfCookie || !safeEqualText(csrfToken, csrfCookie)) {
          throw new OAuthError('invalid_request', 'consent form CSRF validation failed')
        }
        const loginState = params.get('login_state') || ''
        const state = await loadLoginState(loginState)
        if (!state?.provider_subject) {
          throw new OAuthError('invalid_request', 'authorization state is no longer authenticated')
        }
        if (!PKCE_CHALLENGE.test(state.code_challenge)) {
          throw new OAuthError('invalid_request', 'a valid S256 PKCE code_challenge is required')
        }
        const operator = await currentOperator(request)
        const stateProvider = state.provider_id ?? ''
        const operatorProvider = operator?.provider_id ?? (operator ? 'api_key' : '')
        if (!operator || stateProvider !== operatorProvider) {
          throw new OAuthError('access_denied', 'operator session expired', 401)
        }
        const [client] = await deps.db.select<ClientRow>('wk_oauth_clients', {
          client_id: `eq.${state.client_id}`,
          limit: 1,
        })
        if (!client || client.revoked_at || !client.redirect_uris.includes(state.redirect_uri)) {
          throw new OAuthError('invalid_client', 'unknown or revoked client')
        }
        const decision = params.get('decision') ?? params.get('action')
        if (decision === 'switch_account') {
          await deps.db.update(
            'wk_oauth_operator_sessions',
            { id: `eq.${operator.id}`, revoked_at: 'is.null' },
            { revoked_at: new Date().toISOString() },
            { returning: false },
          )
          await deps.db.query(
            `UPDATE wk_oauth_login_states
                SET provider_subject = NULL, provider_email = NULL, provider_id = NULL,
                    oidc_nonce = NULL, oidc_code_verifier = NULL, authenticated_at = NULL
              WHERE id = $1 AND consumed_at IS NULL`,
            [state.id],
          )
          return withOperatorCookie(loginResponse(loginState), config, '', 0)
        }
        if (decision === 'deny') {
          await deps.db.update(
            'wk_oauth_login_states',
            { id: `eq.${state.id}`, consumed_at: 'is.null' },
            { consumed_at: new Date().toISOString() },
            { returning: false },
          )
          return clearCsrfCookie(
            redirectWith(state.redirect_uri, {
              error: 'access_denied',
              state: state.client_state ?? undefined,
            }),
            new URL(config.publicUrl).protocol === 'https:',
          )
        }
        const selected = [...new Set(params.getAll('scope'))]
        const ceiling = offeredScopes(state.scopes, operator.scopes)
        const scopes = selected.filter((scope) => ceiling.includes(scope))
        if (ceiling.includes('knowledge:read') && !scopes.includes('knowledge:read')) scopes.unshift('knowledge:read')
        if (!scopes.includes('knowledge:read')) throw new OAuthError('access_denied', 'no readable scope selected', 403)
        const code = randomToken('wka_')
        await deps.db.tx(async (tx) => {
          const changed = await tx.update(
            'wk_oauth_login_states',
            { id: `eq.${state.id}`, consumed_at: 'is.null' },
            { consumed_at: new Date().toISOString() },
          )
          if (!changed.length) throw new OAuthError('invalid_request', 'authorization state is already consumed')
          await tx.insert(
            'wk_oauth_authorization_codes',
            {
              code_hash: hashApiKey(code, config.keyPepper),
              client_id: client.client_id,
              redirect_uri: state.redirect_uri,
              scopes,
              code_challenge: state.code_challenge,
              resource: state.resource,
              principal_name: operator.principal_name,
              principal_space_id: operator.principal_space_id,
              principal_key_id: operator.principal_key_id,
              principal_key_hash: operator.principal_key_hash,
              principal_kind: operator.principal_kind,
              expires_at: new Date(Date.now() + (config.oauthAuthorizationCodeTtlMs ?? 10 * 60 * 1000)).toISOString(),
            },
            { returning: false },
          )
        })
        return clearCsrfCookie(
          redirectWith(state.redirect_uri, { code, state: state.client_state ?? undefined }),
          new URL(config.publicUrl).protocol === 'https:',
        )
      }
      if (request.method === 'POST' && path === '/v1/identity/logout') {
        const operator = await currentOperator(request)
        if (operator) {
          await deps.db.update(
            'wk_oauth_operator_sessions',
            { id: `eq.${operator.id}`, revoked_at: 'is.null' },
            { revoked_at: new Date().toISOString() },
            { returning: false },
          )
        }
        return withOperatorCookie(
          new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
          config,
          '',
          0,
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
                    a.principal_kind = 'identity'
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
                    r.principal_kind = 'identity'
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
      // Browser-funnel GETs answer humans with an HTML error page in the
      // shared shell; JSON remains for non-browser endpoints and for callers
      // that explicitly Accept: application/json.
      if (request.method === 'GET' && BROWSER_FUNNEL_PATHS.includes(path) && !wantsJson(request)) {
        const known =
          error instanceof OAuthError ? error : new OAuthError('server_error', 'authorization server error', 500)
        return authHtmlResponse(renderErrorPage({ message: browserErrorMessage(known) }), known.status)
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
      writeResponseHeaders(res, response)
      res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined)
    } catch (error) {
      const response = oauthError(error)
      res.statusCode = response.status
      writeResponseHeaders(res, response)
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
