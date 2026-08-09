// OAuth 2.1 authorization server for remote MCP clients (ChatGPT, Claude.ai,
// Cursor). API keys remain the operator login credential; this surface turns
// one successful, explicit consent into short-lived scoped OAuth tokens.
// Plaintext API keys, authorization codes and tokens are never persisted.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config, OidcProviderConfig } from '../config.ts'
import { OPERATOR_SESSION_ABSOLUTE_TTL_DEFAULT_MS, OPERATOR_SESSION_IDLE_MS } from '../config.ts'
import type { Db } from '../db/postgres.ts'
import type { Auth, Principal } from '../http/auth.ts'
import { cutScopesToCeiling, hashApiKey } from '../http/auth.ts'
import type { RawHandler } from '../http/server.ts'
import type { Logger } from '../logger.ts'
import { COCKPIT_PREFIX } from '../cockpit.ts'
import { cleanupOAuthRows, type OAuthCleanupReport } from './cleanup.ts'
import { isOidcIdentityAllowed, OIDC_SIGNUP_SCOPES, type OidcIdentity } from './identity-policy.ts'
import { finishOidcLogin, startOidcLogin, verifyOidcIdentityToken } from './oidc.ts'
import {
  authHtmlResponse,
  renderApiKeyLogin,
  renderConsentPage,
  renderErrorPage,
  renderProviderChoice,
  withScheme,
  type LoginPurpose,
} from './ui.ts'

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
/**
 * Ceiling on cockpit sign-in states one remote address may mint per minute.
 *
 * Deliberately looser than the DCR ceiling. A dynamic registration comes from
 * one machine; a cockpit sign-in comes from a person, and with `trustProxy`
 * off every operator behind the same reverse proxy or office NAT shares ONE
 * bucket key — a ten-a-minute limit would lock a team out of their own console
 * on a Monday morning. Twenty is far above what humans produce (a sign-in is a
 * single redirect, and even a stubborn back-button loop is a handful) and far
 * below what makes unauthenticated row creation worth doing: at most two
 * hundred live ten-minute states per address.
 */
export const COCKPIT_LOGIN_MAX_PER_MINUTE = 20
const MAX_FORM_BYTES = 32 * 1024
// Human-facing GET surfaces of the browser login funnel. Failures here render
// an HTML error page in the shared TOKENS shell; the JSON {error,
// error_description} envelope stays reserved for the non-browser endpoints
// (token/register/API) and for callers that ask for application/json.
const BROWSER_FUNNEL_PATHS = [
  '/v1/oauth/authorize',
  '/v1/identity/login/start',
  '/v1/identity/login/callback',
  '/v1/identity/cockpit-login',
]
const NOT_AUTHORIZED_MESSAGE = 'Your account is not authorized for WikiKit. Contact the operator.'
const STATE_PROBLEM_MESSAGE = 'This sign-in attempt expired or was already used. Please sign in again.'
// Deliberately free of the word "state": browserErrorMessage rewrites any
// description matching /state/i into STATE_PROBLEM_MESSAGE, and telling a
// throttled operator their sign-in expired would send them straight back into
// the loop that throttled them.
const TOO_MANY_LOGINS_MESSAGE = 'Too many sign-in attempts from this address. Wait a minute and try again.'

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
  /**
   * Which funnel this state belongs to (0032). 'oauth' carries a validated
   * authorization request and ends at consent; 'cockpit' carries nowhere but
   * where to come back to, and ends at a session cookie. A CHECK constraint
   * makes the two column shapes mutually exclusive — the columns below are
   * non-null for 'oauth' rows only.
   */
  purpose: 'oauth' | 'cockpit'
  return_to: string | null
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
  /**
   * The row's idle deadline as it stands AFTER this read renewed it — already
   * clamped to `absolute_expires_at` by the UPDATE that wrote it.
   *
   * Carried on the row rather than recomputed as `now() + 8h` in JavaScript
   * because it is what the browser cookie's Max-Age is derived from: the clamp
   * lives in one SQL expression, and reading its result back is the only way
   * the cookie cannot be handed a life the row does not have.
   */
  expires_at: Date | string
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

// Anything that must never reach a `location:` header this server builds out of
// somebody else's query string. See safeCockpitReturnTo for why the bar is
// printable ASCII rather than just CR/LF.
const UNSAFE_IN_LOCATION = /[^\x20-\x7e]/

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

/**
 * Whether an unsafe request came from this document's own origin.
 *
 * This is the CSRF control for everything the operator session cookie
 * authenticates. A token in a header was the alternative, and it was rejected:
 * the token has to reach JavaScript to be sent, which is the one property the
 * cookie was chosen to avoid. `Origin` is set by the browser on every unsafe
 * method, cannot be forged by page script, and a request with no Origin at all
 * is not a browser — so it is refused rather than waved through.
 */
export function isSameOrigin(request: Request, config: Pick<Config, 'publicUrl'>): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  let sent: string
  try {
    sent = new URL(origin).origin
  } catch {
    return false
  }
  // Compared against the CONFIGURED public origin, not the request's own URL:
  // the Request here is reconstructed from the Host header over a plaintext
  // hop behind the TLS proxy, so its scheme is always http: while the browser
  // sends https:. The host header form is accepted too, which is what a
  // developer hitting 127.0.0.1 directly sends.
  if (sent === new URL(config.publicUrl).origin) return true
  try {
    return sent === new URL(request.url).origin
  } catch {
    return false
  }
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
    if (key !== name) continue
    const raw = rest.join('=')
    // A cookie is bytes somebody else wrote, and `decodeURIComponent('%')`
    // throws. Unguarded, a single malformed cookie took down every HTML
    // response in the browser funnel with a 500 — sign-in for the console AND
    // for every MCP client — and the theme cookie is deliberately readable and
    // writable by script, so any page on the same registrable domain could set
    // one. A value that will not decode is used as sent; nothing downstream
    // trusts it beyond an equality check.
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
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

function operatorCookie(config: Config, token: string, maxAge = OPERATOR_SESSION_IDLE_MS / 1000): string {
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

/**
 * Seconds of life left in a session row, for the cookie that stands for it.
 *
 * Zero when the row is already at (or past) its deadline, which as a Max-Age
 * means "delete this cookie" — the honest answer for a session whose absolute
 * cap lands within the second. An unparseable timestamp lands there too rather
 * than emitting `Max-Age=NaN`, which browsers read as a session cookie and
 * would quietly grant the row MORE life than it has.
 */
function operatorCookieMaxAge(session: Pick<OperatorSessionRow, 'expires_at'>): number {
  const expires = session.expires_at instanceof Date ? session.expires_at : new Date(session.expires_at)
  const remaining = Math.floor((expires.getTime() - Date.now()) / 1000)
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0
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
// AuthZ truth (0028, NOT NULL since 0030) — the stored allowed_scopes array
// IS the ceiling. null = the identity is not (or no longer) admitted; a
// revoked row (or an empty ceiling) denies here regardless of the ENV
// allowlist.
async function identityCeiling(
  db: Db,
  config: Config,
  providerId: string | null,
  subject: string | null,
): Promise<string[] | null> {
  const provider = oidcProvider(config, providerId)
  if (!provider || !subject) return null
  const { rows } = await db.query<{ allowed_scopes: string[] }>(
    `SELECT allowed_scopes FROM wk_oauth_identities
      WHERE provider = $1 AND provider_subject = $2 AND revoked_at IS NULL
      LIMIT 1`,
    [provider.id, subject],
  )
  const ceiling = rows[0]?.allowed_scopes
  return ceiling?.length ? ceiling : null
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
    allowed_scopes: string[]
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
    if (registered.allowed_scopes.length === 0) return null
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
  /**
   * Resolve the browser operator-session cookie to a Principal, for REST
   * routes called by the cockpit on this same origin.
   *
   * This is the console's ONLY credential. The alternative — mint an API key
   * and keep it in JavaScript — puts a long-lived secret somewhere any script
   * on the page can read and any extension can exfiltrate; an HttpOnly cookie
   * cannot be read at all. `enforceOrigin` is true for methods that change
   * something: SameSite=Lax still lets a cross-site GET carry the cookie, so
   * the writes check where the request came from.
   *
   * Returns null for "no cookie, or the cookie no longer means anything" —
   * never throws, so the caller falls through to the ordinary 401 and the
   * error a header client sees does not change shape.
   */
  authenticateSession(req: IncomingMessage, enforceOrigin: boolean): Promise<Principal | null>
  cleanup(): Promise<OAuthCleanupReport>
  stop(): void
}

export function createOAuthMount(config: Config, deps: { db: Db; auth: Auth; logger: Logger }): OAuthMount {
  /**
   * Every per-remote-address minute bucket on this mount, in one store keyed by
   * `<bucket> <address>`.
   *
   * One Map per limit was the alternative and it was rejected: the part worth
   * having exactly once is not the counting, it is the 10_000-entry eviction
   * below — the guard that stops the rate limiter from becoming the memory
   * exhaustion it exists to prevent. Two stores means two chances to forget it.
   * The bucket name is part of the key so two limits over the same address
   * cannot spend each other's budget.
   */
  const rateBuckets = new Map<string, { count: number; resetAt: number }>()

  // With trustProxy on, the left-most X-Forwarded-For hop is the client the
  // edge saw; with it off, the only address that cannot be spoofed is the one
  // the handler stamped from the socket.
  function remoteAddress(req: Request): string {
    return config.trustProxy
      ? (req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
          req.headers.get('x-wikikit-remote-address') ??
          'unknown')
      : (req.headers.get('x-wikikit-remote-address') ?? 'unknown')
  }

  function rateAllowed(req: Request, bucket: string, limitPerMinute: number): boolean {
    const key = `${bucket} ${remoteAddress(req)}`
    const now = Date.now()
    const current = rateBuckets.get(key)
    if (!current || current.resetAt <= now) {
      if (rateBuckets.size >= 10_000) {
        for (const [entry, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(entry)
        if (rateBuckets.size >= 10_000) return false
      }
      rateBuckets.set(key, { count: 1, resetAt: now + 60_000 })
      return true
    }
    if (current.count >= limitPerMinute) return false
    current.count += 1
    return true
  }

  async function currentOperator(request: Request): Promise<OperatorSessionRow | null> {
    const rawToken = operatorToken(request, config)
    if (!rawToken) return null
    const { rows } = await deps.db.query<OperatorSessionRow>(
      `SELECT id, principal_kind, principal_key_id, principal_key_hash, principal_name,
              principal_space_id, provider_id, provider_subject, scopes, expires_at
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
        const { rows: keys } = await deps.db.query<{
          scopes: string[]
          space_id: string | null
          name: string
          identity_provider: string | null
          identity_subject: string | null
        }>(
          `SELECT scopes, space_id, name, identity_provider, identity_subject FROM wk_api_keys
            WHERE id::text = $1 AND key_hash = $2 AND revoked_at IS NULL
            LIMIT 1`,
          [session.principal_key_id, session.principal_key_hash],
        )
        if (!keys[0]) return null
        session.scopes = keys[0].scopes
        // An SSO-minted key pasted into the API-key login funnel stays
        // subordinate to its identity grant (0029): dead grant = dead
        // session, and the consent ceiling is cut live like authenticate.
        if (keys[0].identity_provider && keys[0].identity_subject) {
          const ceiling = await identityCeiling(deps.db, config, keys[0].identity_provider, keys[0].identity_subject)
          if (!ceiling) return null
          session.scopes = cutScopesToCeiling(keys[0].scopes, ceiling)
        }
        session.principal_space_id = keys[0].space_id
        session.principal_name = keys[0].name
      }
    } else {
      const ceiling = await identityCeiling(deps.db, config, session.provider_id, session.provider_subject)
      if (!ceiling) return null
      session.scopes = ceiling
    }
    // `least(absolute_expires_at, …)` is the whole of the absolute cap: no
    // read, however busy, can push the idle deadline past it. The clamp is the
    // COLUMN, never a constant, which is what makes the invariant independent
    // of WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS — whatever ceiling the
    // mint stamped on this row is the ceiling this statement respects.
    // RETURNING the result rather than assuming `now() + 8h` is what lets the
    // cookie be re-stamped from the row (see GET /v1/session) without ever
    // outliving it — the last renewal before the cap simply hands the browser
    // whatever is left.
    const { rows: renewed } = await deps.db.query<{ expires_at: Date | string }>(
      `UPDATE wk_oauth_operator_sessions
          SET last_used_at = now(), expires_at = least(absolute_expires_at, now() + interval '8 hours')
        WHERE id = $1
        RETURNING expires_at`,
      [session.id],
    )
    if (renewed[0]) session.expires_at = renewed[0].expires_at
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
      expires_at: new Date(now + OPERATOR_SESSION_IDLE_MS).toISOString(),
      // The operator's ceiling, stamped into the row rather than consulted on
      // every read: a session keeps the deadline it was born with, so changing
      // the variable governs sessions minted afterwards and never silently
      // lengthens one somebody is already holding. The `??` is the same shape
      // the refresh-token TTL uses above — the field is optional on the configs
      // tests inject — but it spends the loader's OWN default constant rather
      // than retyping the number, so this line cannot come to disagree with
      // src/config.ts about what an unconfigured installation gets.
      absolute_expires_at: new Date(
        now + (config.oauthOperatorSessionAbsoluteTtlMs ?? OPERATOR_SESSION_ABSOLUTE_TTL_DEFAULT_MS),
      ).toISOString(),
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
    // knowledge:approve implies knowledge:review (requireScope has always
    // enforced it) — the consent offer must agree, or an approve-ceiling
    // identity never gets the review checkbox it is entitled to tick.
    return requested.filter(
      (scope) =>
        scope === 'offline_access' ||
        unrestricted ||
        allowed.has(scope) ||
        (scope === 'knowledge:review' && allowed.has('knowledge:approve')),
    )
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
      `SELECT id, purpose, return_to, client_id, redirect_uri, scopes, code_challenge, resource, client_state,
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
      const { rows } = await deps.db.query<{
        client_id: string | null
        redirect_uri: string
        client_state: string | null
      }>(
        `SELECT client_id, redirect_uri, client_state
           FROM wk_oauth_login_states
          WHERE state_hash = $1
          LIMIT 1`,
        [hashApiKey(rawState, config.keyPepper)],
      )
      const row = rows[0]
      // A cockpit state has no client_id, so there is no client to hand an
      // access_denied redirect back to — the page offers a plain retry instead.
      if (row?.client_id) {
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

  function loginResponse(rawState: string, purpose: LoginPurpose = 'oauth'): Response {
    const options = loginOptions(config)
    if (!options.length) throw new OAuthError('server_error', 'no OAuth login method is configured', 500)
    return authHtmlResponse(renderProviderChoice({ state: rawState, providers: options, purpose }))
  }

  /**
   * Where the cockpit funnel is allowed to send a browser afterwards.
   *
   * A same-origin PATH, never a URL: an absolute value — even one that happens
   * to name this origin — is an open redirect waiting for a parser
   * disagreement, and the cockpit only ever wants to land back on one of its
   * own routes. `//evil.example` is a protocol-relative URL that a naive
   * "starts with /" check would wave through, so it is rejected explicitly.
   *
   * The printable-ASCII rule subsumes the CR/LF rule this used to carry alone.
   * CR and LF were rejected as the header-injection pair; the rest of the range
   * has to go for a duller reason that hurts the operator more. Node's
   * `res.setHeader` refuses any code point outside tab, `\x20-\x7e` and
   * latin-1, and it refuses by THROWING — while `finishCockpitLogin` stamps
   * `consumed_at` BEFORE building the redirect. So a link mailed to an operator
   * carrying `?return_to=/cockpit/%00` ended their sign-in on a 500 with a
   * single-use state already spent, and the page explained nothing. The latin-1
   * window node happens to tolerate goes too: the console builds `return_to`
   * from `location.pathname`/`location.search`, which the browser has already
   * percent-encoded, so a raw non-ASCII byte arriving here is not a deep link
   * anybody typed. Rejection is never an error — it is the cockpit root, so the
   * operator still lands signed in, one navigation from where they were going.
   */
  function safeCockpitReturnTo(value: string | null | undefined): string {
    const candidate = value ?? ''
    if (!candidate.startsWith(COCKPIT_PREFIX)) return `${COCKPIT_PREFIX}/`
    if (candidate.startsWith('//') || UNSAFE_IN_LOCATION.test(candidate) || candidate.length > 2048)
      return `${COCKPIT_PREFIX}/`
    // '/cockpitfoo' is not under the cockpit; '/cockpit' and '/cockpit/…' are.
    const next = candidate.charAt(COCKPIT_PREFIX.length)
    if (next && next !== '/' && next !== '?') return `${COCKPIT_PREFIX}/`
    return candidate
  }

  /**
   * The cockpit funnel's terminus: consume the login state, set the operator
   * session cookie, send the browser back where it came from.
   *
   * No consent screen, deliberately. Consent exists so a THIRD party can be
   * shown what it is about to be granted; the cockpit is this installation's
   * own console on this installation's own origin, and a consent screen for
   * one's own console is a screen that teaches people to click through consent
   * screens.
   */
  async function finishCockpitLogin(state: IdentityLoginStateRow, sessionToken: string): Promise<Response> {
    const consumed = await deps.db.update(
      'wk_oauth_login_states',
      { id: `eq.${state.id}`, consumed_at: 'is.null' },
      { consumed_at: new Date().toISOString() },
    )
    // Single-use: without a consent step to defer to, the state has done its
    // whole job the moment the session exists. A replayed state must not mint
    // a second session.
    if (!consumed.length) throw new OAuthError('invalid_request', 'sign-in state expired or was already used')
    return withOperatorCookie(
      new Response(null, {
        status: 302,
        headers: { location: safeCockpitReturnTo(state.return_to), 'cache-control': 'no-store' },
      }),
      config,
      sessionToken,
    )
  }

  /** What GET /v1/session answers with — the console's whole idea of who it is talking to. */
  function sessionPayload(operator: OperatorSessionRow): Record<string, unknown> {
    return {
      name: operator.principal_name,
      kind: operator.principal_kind,
      scopes: operator.scopes,
      space_id: operator.principal_space_id,
      provider_id: operator.provider_id,
    }
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
    // The key is BOUND to the identity grant (0029): DELETE
    // /v1/identities/{provider}/{subject} revokes it, and authenticate cuts
    // its scope snapshot live against the grant's current ceiling — an SSO
    // session key never outlives or outranks the identity behind it.
    const issued = await deps.auth.createKey({
      name: `SSO ${identity.email ?? identity.subject}`,
      scopes: ceiling,
      spaceId: null,
      identity: { provider: provider.id, subject: identity.subject },
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
      // The console asks this on every load, before it renders anything. It
      // NEVER answers 401: "nobody is signed in" is an answer, not a failure,
      // and a 401 here would make every browser devtools console red on the one
      // screen where nothing is wrong. The console branches on `session: null`.
      if (request.method === 'GET' && path === '/v1/session') {
        const operator = await currentOperator(request)
        const response = json({ session: operator ? sessionPayload(operator) : null })
        if (!operator) return response
        // The renewal the browser can see. `currentOperator` just slid the
        // ROW's idle deadline, as it does on every authenticated read — but the
        // cookie's Max-Age was written once, at login, and nothing re-wrote it
        // outside the login/consent/logout paths. So an operator working
        // continuously was hard-signed-out eight hours after signing in, by
        // their own browser dropping a cookie whose session was still alive:
        // signed out mid-review, the failure this product can least afford.
        //
        // Re-stamping the SAME token with the row's current deadline is what
        // makes the documented eight-hour IDLE limit true on the browser side
        // too, and this is the natural place for it — /v1/session is the whoami
        // the console reads before it renders anything. It cannot extend the
        // absolute cap: the Max-Age comes from the value
        // `least(absolute_expires_at, …)` just wrote, never from a fresh clock.
        return withOperatorCookie(response, config, operatorToken(request, config), operatorCookieMaxAge(operator))
      }
      if (request.method === 'DELETE' && path === '/v1/session') {
        // Same-origin only. The session cookie is SameSite=Lax, which a
        // cross-site GET can still carry — so the one method that destroys
        // something checks where the request came from rather than trusting
        // the cookie's own rules.
        if (!isSameOrigin(request, config)) {
          throw new OAuthError('invalid_request', 'sign-out must come from this origin', 403)
        }
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
      // The cockpit's one sign-in door. It mints a login state carrying only a
      // return address and hands the browser to the same chooser every other
      // sign-in uses, so there is exactly one place that knows how to prove who
      // somebody is.
      if (request.method === 'GET' && path === '/v1/identity/cockpit-login') {
        const returnTo = safeCockpitReturnTo(url.searchParams.get('return_to'))
        const operator = await currentOperator(request)
        // Already signed in: no reason to walk somebody through a chooser to
        // arrive back where they already had the right to be.
        if (operator) {
          return new Response(null, { status: 302, headers: { location: returnTo, 'cache-control': 'no-store' } })
        }
        // Past this line every request INSERTs a row, and this is the only
        // login-state-minting path with no client, no credential and no consent
        // behind it — the cheapest row in the system to create from the
        // outside, and one the housekeeping sweep only collects hourly. Same
        // per-address bucket the DCR endpoint uses, under its own name and its
        // own limit.
        //
        // Charged AFTER the already-signed-in short-circuit above on purpose:
        // an operator bouncing around their own console never spends a slot,
        // because a session they already hold costs no row at all.
        if (!rateAllowed(request, 'cockpit-login', COCKPIT_LOGIN_MAX_PER_MINUTE)) {
          throw new OAuthError('too_many_requests', TOO_MANY_LOGINS_MESSAGE, 429)
        }
        const loginState = randomToken('wkl_')
        const [state] = await deps.db.insert<IdentityLoginStateRow>('wk_oauth_login_states', {
          state_hash: hashApiKey(loginState, config.keyPepper),
          purpose: 'cockpit',
          return_to: returnTo,
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        })
        if (!state) throw new OAuthError('server_error', 'sign-in state could not be created', 500)
        const chooser = new URL('/v1/identity/login/start', config.publicUrl)
        chooser.searchParams.set('login_state', loginState)
        return new Response(null, {
          status: 302,
          headers: { location: chooser.toString(), 'cache-control': 'no-store' },
        })
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
        if (!rateAllowed(request, 'register', DCR_MAX_PER_MINUTE))
          throw new OAuthError('too_many_requests', 'registration rate limit exceeded', 429)
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
              purpose: state.purpose,
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
        // The cockpit funnel ends here: there is no client to name and no
        // consent to collect, only a session and a return address.
        if (state.purpose === 'cockpit') return await finishCockpitLogin(state, session.token)
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
        if (!providerId) return loginResponse(loginState, state.purpose)
        if (configuredProvider?.protocol === 'api_key') {
          return authHtmlResponse(
            renderApiKeyLogin({ state: loginState, providerId: configuredProvider.id, purpose: state.purpose }),
          )
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
          // The child state inherits which funnel it belongs to. Without this
          // the callback would find an 'oauth' row with no client and try to
          // render consent for a console that never asked for it.
          purpose: state.purpose,
          return_to: state.return_to,
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
          `SELECT id, purpose, return_to, client_id, redirect_uri, scopes, code_challenge, resource, client_state,
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
        // A cockpit state has no client to look up and nowhere to redirect an
        // OAuth error to — "Sign in again" on its failure pages is a plain
        // retry, not an RFC 6749 access_denied hand-back.
        const cockpitFunnel = state.purpose === 'cockpit'
        const [client] = cockpitFunnel
          ? []
          : await deps.db.select<ClientRow>('wk_oauth_clients', {
              client_id: `eq.${state.client_id}`,
              limit: 1,
            })
        if (!cockpitFunnel && (!client || client.revoked_at)) {
          throw new OAuthError('invalid_client', 'unknown or revoked client')
        }
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
          const retryHref = client?.redirect_uris.includes(state.redirect_uri)
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
          const retryHref = client?.redirect_uris.includes(state.redirect_uri)
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
        if (cockpitFunnel) return await finishCockpitLogin(state, session.token)
        return await consentResponse(state, client!, session.row, loginState, session.token)
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

  /**
   * Render the funnel in the scheme the operator already chose in the console.
   *
   * The cookie is written by the cockpit's theme store and is deliberately NOT
   * HttpOnly — it carries a colour preference and nothing else, and the script
   * that sets it is the same script that reads localStorage one line earlier.
   * Absence means "follow the OS", which is what the funnel's media query
   * already does, so an unset cookie changes nothing.
   *
   * `vary: cookie` because two operators on the same proxy must not be served
   * each other's scheme.
   */
  async function themed(request: Request, response: Response): Promise<Response> {
    if (!response.headers.get('content-type')?.startsWith('text/html')) return response
    const raw = cookieValue(request, 'wk-cockpit-theme')
    const scheme = raw === 'dark' ? 'dark' : raw === 'light' ? 'light' : null
    response.headers.append('vary', 'cookie')
    if (!scheme) return response
    const html = withScheme(await response.text(), scheme)
    return new Response(html, { status: response.status, headers: response.headers })
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
      const response = await themed(request, await handle(request))
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

  /**
   * The cookie plane's entry point for ordinary REST routes (see OAuthMount).
   *
   * Only the headers this needs are lifted out of the node request — cookie
   * and origin — rather than reconstructing a whole Request with a body that
   * the route handler still has to read.
   */
  async function authenticateSession(req: IncomingMessage, enforceOrigin: boolean): Promise<Principal | null> {
    const cookie = req.headers.cookie
    if (!cookie) return null
    const headers = new Headers({ cookie })
    const origin = req.headers.origin
    if (typeof origin === 'string') headers.set('origin', origin)
    const request = new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`, { headers })
    if (enforceOrigin && !isSameOrigin(request, config)) return null
    const operator = await currentOperator(request)
    if (!operator) return null
    return {
      // Namespaced so an audit row can never be mistaken for an API key id.
      keyId: `session:${operator.id}`,
      name: operator.principal_name,
      scopes: operator.scopes,
      spaceId: operator.principal_space_id,
    }
  }

  // Hourly operational sweep. The timer is unref'd so it never pins tests or a
  // graceful shutdown; App.close() still clears it.
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
    authenticateSession,
    cleanup: () => cleanupOAuthRows(deps.db),
    stop: () => clearInterval(cleanupTimer),
  }
}
