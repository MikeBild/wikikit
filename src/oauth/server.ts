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

const OAUTH_SCOPES = ['knowledge:read', 'knowledge:propose', 'offline_access'] as const
const DEFAULT_SCOPE = OAUTH_SCOPES.join(' ')
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
}

interface RefreshRow {
  id: string
  scopes: string[]
  resource: string
  principal_name: string
  principal_space_id: string | null
  principal_key_id: string
  principal_key_hash: string
  family_id: string
  expires_at: Date | string
  revoked_at: Date | string | null
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

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
}): Response {
  const hidden = [...args.params.entries()]
    .filter(([name]) => name !== 'api_key' && name !== 'action')
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n')
  const scopeItems = args.scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join('')
  const error = args.error ? `<p class="error">${escapeHtml(args.error)}</p>` : ''
  const response = html(`<!doctype html>
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
<label for="api_key">WikiKit API key</label><input id="api_key" name="api_key" type="password" required autocomplete="off" spellcheck="false">
<small>The key is checked once and is never stored. The issued OAuth token is limited to the permissions above.</small>
<div class="actions"><button class="primary" type="submit" name="action" value="approve">Authorize</button><button type="submit" name="action" value="deny" formnovalidate>Deny</button></div>
</form></main></body></html>`)
  response.headers.set(
    'set-cookie',
    `wk_oauth_csrf=${encodeURIComponent(args.csrfToken)}; HttpOnly; SameSite=Lax; Path=/v1/oauth/authorize; Max-Age=600${args.secureCookie ? '; Secure' : ''}`,
  )
  return response
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
): Promise<{ client: ClientRow; redirectUri: string; scopes: string[]; resource: string }> {
  if (params.get('response_type') !== 'code')
    throw new OAuthError('unsupported_response_type', 'response_type must be code')
  const clientId = params.get('client_id') || ''
  const redirectUri = params.get('redirect_uri') || ''
  const challenge = params.get('code_challenge') || ''
  if (!clientId || !redirectUri || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
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
  return { client, redirectUri, scopes: parseScopes(params.get('scope')), resource }
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
        return consentPage({
          clientName: loaded.client.client_name,
          params: url.searchParams,
          scopes: loaded.scopes,
          csrfToken: randomBytes(32).toString('base64url'),
          secureCookie: new URL(config.publicUrl).protocol === 'https:',
        })
      }
      if (request.method === 'POST' && path === '/v1/oauth/authorize') {
        const params = new URLSearchParams(await request.text())
        const csrfToken = params.get('csrf_token') || ''
        const csrfCookie = cookieValue(request, 'wk_oauth_csrf') || ''
        if (!csrfToken || !csrfCookie || !safeEqualText(csrfToken, csrfCookie)) {
          throw new OAuthError('invalid_request', 'consent form CSRF validation failed')
        }
        const loaded = await loadAuthorizationRequest(config, deps.db, params)
        if (params.get('action') === 'deny') {
          return clearCsrfCookie(
            redirectWith(loaded.redirectUri, {
              error: 'access_denied',
              state: params.get('state') ?? undefined,
            }),
            new URL(config.publicUrl).protocol === 'https:',
          )
        }
        let principal: Principal
        const apiKey = params.get('api_key') || ''
        const principalKeyHash = hashApiKey(apiKey, config.keyPepper)
        try {
          principal = await deps.auth.authenticate(`Bearer ${apiKey}`)
          if (principal.keyId.startsWith('oauth:')) throw new Error('an operator API key is required')
          for (const scope of loaded.scopes) {
            if (scope !== 'offline_access')
              deps.auth.requireScope(principal, scope as 'knowledge:read' | 'knowledge:propose')
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
        const code = randomToken('wka_')
        await deps.db.insert(
          'wk_oauth_authorization_codes',
          {
            code_hash: hashApiKey(code, config.keyPepper),
            client_id: loaded.client.client_id,
            redirect_uri: loaded.redirectUri,
            scopes: loaded.scopes,
            code_challenge: params.get('code_challenge')!,
            resource: loaded.resource,
            principal_name: principal.name,
            principal_space_id: principal.spaceId,
            principal_key_id: principal.keyId,
            principal_key_hash: principalKeyHash,
            expires_at: new Date(Date.now() + (config.oauthAuthorizationCodeTtlMs ?? 10 * 60 * 1000)).toISOString(),
          },
          { returning: false },
        )
        return clearCsrfCookie(
          redirectWith(loaded.redirectUri, { code, state: params.get('state') ?? undefined }),
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
                      a.principal_key_id, a.principal_key_hash
                 FROM wk_oauth_authorization_codes a
                 JOIN wk_oauth_clients c ON c.client_id = a.client_id
                WHERE a.code_hash = $1 AND a.client_id = $2 AND a.redirect_uri = $3
                  AND a.resource = $4 AND a.consumed_at IS NULL AND a.expires_at > now()
                  AND c.revoked_at IS NULL
                  AND (
                    a.principal_key_id = 'bootstrap'
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
                      r.principal_key_id, r.principal_key_hash, r.family_id,
                      r.expires_at, r.revoked_at
                 FROM wk_oauth_refresh_tokens r
                 JOIN wk_oauth_clients c ON c.client_id = r.client_id
                WHERE r.token_hash = $1 AND r.client_id = $2
                  AND c.revoked_at IS NULL
                  AND (
                    r.principal_key_id = 'bootstrap'
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
            if (!row || !bootstrapGrantIsCurrent(config, row)) {
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
