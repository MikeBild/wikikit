// API-key auth, hardened to the CONTRACTS §5.4 surface.
//
// Key format: `wk_<43 chars base64url of 32 random bytes>`. At rest only
// hex(HMAC-SHA256(pepper, fullKeyString)) is stored — a database dump alone
// never yields usable keys, and rotating the pepper invalidates every key at
// once (deliberate: the pepper IS the kill switch).
//
// WHY HMAC with a server-side pepper instead of bcrypt/argon2: API keys are
// 256-bit random strings, not human passwords — brute force is already
// hopeless, so the threat model is "DB leaked, pepper not" and a single fast
// HMAC per request is exactly right (the house pattern).
//
// 401 vs 403 (§8.2): 401 unauthorized = we do not know WHO you are (missing,
// unknown, or revoked key). 403 insufficient_scope = we know exactly who you
// are and the answer is no (missing scope, or a space-scoped key touching a
// foreign space). Conflating them would make agents retry auth instead of
// asking for a better key.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Config } from '../config.ts'
import type { Db } from '../db/postgres.ts'
import { ForbiddenError, UnauthorizedError, ValidationError } from '../domain/errors.ts'
import type { Logger } from '../logger.ts'
import type { Scope } from './routes.ts'

export interface Principal {
  /** wk_api_keys.id, or 'bootstrap' for the env-configured bootstrap key. */
  keyId: string
  scopes: string[]
  /** Non-null = key is locked to this space (wk_spaces.id). */
  spaceId: string | null
  /** Key name — doubles as the reviewer identity on approve/reject. */
  name: string
}

export interface Auth {
  /**
   * Resolve a raw credential header value to a Principal. Accepts the
   * Authorization header value (`Bearer wk_...`) or a bare key (X-API-Key).
   * Throws UnauthorizedError (401) for missing/unknown/revoked keys.
   */
  authenticate(headerValue: string | undefined): Promise<Principal>
  /**
   * Throws ForbiddenError (403 insufficient_scope) when the principal lacks
   * `scope` or is scoped to a different space. An array means any-of: routes
   * that live on two surfaces (e.g. proposal inspection is both part of the
   * read surface and the review surface) accept either scope.
   */
  requireScope(principal: Principal, scope: Scope | readonly Scope[], spaceId?: string): void
  /**
   * Mint a key. The plaintext is returned exactly once and never stored.
   * `identity` binds the key to a wk_oauth_identities grant (the SSO session
   * path): bound keys are revoked with the grant and their effective scopes
   * are cut live against the grant's current ceiling on every authenticate.
   */
  createKey(args: {
    name: string
    scopes: string[]
    spaceId?: string | null
    identity?: { provider: string; subject: string } | null
  }): Promise<{ id: string; key: string }>
  /**
   * Dev bootstrap (§5.4): when no env bootstrap key is set and no live key
   * exists, mint a `*` key and print it ONCE to stdout. No-op in production
   * and no-op when any key already exists — restarting dev never respins keys.
   */
  ensureDevBootstrapKey(logger: Logger): Promise<void>
}

/** hex(HMAC-SHA256(pepper, key)) — the wk_api_keys.key_hash function (§1.10). */
export function hashApiKey(key: string, pepper: string): string {
  return createHmac('sha256', pepper).update(key).digest('hex')
}

// Constant-time string compare. Length is hashed first so unequal lengths
// compare in constant time too instead of throwing/short-circuiting.
function safeEqual(a: string, b: string): boolean {
  const da = createHmac('sha256', 'wikikit-cmp').update(a).digest()
  const db = createHmac('sha256', 'wikikit-cmp').update(b).digest()
  return timingSafeEqual(da, db)
}

export function generateApiKey(): string {
  return `wk_${randomBytes(32).toString('base64url')}`
}

const VALID_SCOPES: ReadonlySet<string> = new Set([
  'knowledge:read',
  'knowledge:propose',
  'knowledge:review',
  'knowledge:approve',
  'admin',
  '*',
])

/**
 * Role presets (0-migration feature): three UNDERSTANDABLE bundles expanded
 * at key-creation time. Scopes stay the ONLY ground truth — nothing stores a
 * role, requireScope never sees one, and a future org model can move
 * evaluation into requireScope precisely because of that.
 *
 * Deliberately NO 'approver' preset: knowledge:approve is the sacred human
 * gate and must remain an explicit, spelled-out grant. Reviewer includes
 * propose so a reviewer can re-propose after a changes_requested bounce.
 */
export const ROLE_SCOPES = {
  reader: ['knowledge:read'],
  contributor: ['knowledge:read', 'knowledge:propose'],
  reviewer: ['knowledge:read', 'knowledge:propose', 'knowledge:review'],
} as const

export type RoleName = keyof typeof ROLE_SCOPES

interface KeyRow {
  id: string
  name: string
  scopes: string[]
  space_id: string | null
  /** Non-null pair = SSO-minted key bound to a wk_oauth_identities grant. */
  identity_provider?: string | null
  identity_subject?: string | null
}

interface OAuthTokenRow {
  id: string
  client_id: string
  scopes: string[]
  principal_name: string
  principal_space_id: string | null
  principal_key_id: string
  principal_key_hash: string
  principal_kind: 'api_key' | 'identity'
}

/**
 * Current scope ceiling of a wk_oauth_identities grant, or null when the
 * identity is not (or no longer) admitted. The grant row is the single AuthZ
 * truth (0028, NOT NULL since 0030): the stored allowed_scopes array IS the
 * ceiling — a revoked or deleted row (or an empty ceiling) denies on the
 * next request, whatever the ENV allowlist says.
 */
export async function liveIdentityCeiling(
  db: Db,
  config: Config,
  providerId: string,
  subject: string,
): Promise<string[] | null> {
  const provider = config.oauthProviders?.find((candidate) => candidate.id === providerId)
  if (!provider || provider.protocol !== 'oidc') return null
  const { rows } = await db.query<{ allowed_scopes: string[] }>(
    `SELECT allowed_scopes FROM wk_oauth_identities
      WHERE provider = $1 AND provider_subject = $2 AND revoked_at IS NULL
      LIMIT 1`,
    [provider.id, subject],
  )
  const ceiling = rows[0]?.allowed_scopes
  return ceiling?.length ? ceiling : null
}

/**
 * Cut a stored scope snapshot against an identity's CURRENT ceiling. Honors
 * the same implications the ceiling side may carry ('*' covers everything,
 * 'admin' everything but '*') and the requireScope rule that
 * knowledge:approve implies knowledge:review — a key holding review under an
 * approve-only ceiling keeps exactly the right it is entitled to.
 */
export function cutScopesToCeiling(scopes: string[], ceiling: string[]): string[] {
  const allowed = new Set(ceiling)
  if (allowed.has('*')) return scopes
  return scopes.filter(
    (scope) =>
      allowed.has(scope) ||
      (scope !== '*' && allowed.has('admin')) ||
      (scope === 'knowledge:review' && allowed.has('knowledge:approve')),
  )
}

async function identityGrantIsCurrent(
  db: Db,
  config: Config,
  row: { principal_key_id: string; principal_kind: string },
): Promise<boolean> {
  if (row.principal_kind !== 'identity') return true
  const match = row.principal_key_id.match(/^identity:([a-z0-9][a-z0-9-]{0,62}):(.+)$/)
  if (!match) return false
  return (await liveIdentityCeiling(db, config, match[1]!, match[2]!)) !== null
}

export function createAuth(config: Config, db: Db): Auth {
  const auth: Auth = {
    async authenticate(headerValue) {
      if (!headerValue) throw new UnauthorizedError('missing API key (Authorization: Bearer or X-API-Key)')
      // Accept both `Bearer wk_...` (Authorization) and a bare key (X-API-Key
      // value, or a client that skips the Bearer prefix).
      const bearer = headerValue.match(/^Bearer\s+(.+)$/i)
      const key = bearer?.[1] ?? headerValue

      // OAuth access tokens are separate from operator API keys and are
      // intentionally accepted only through Bearer authentication. They are
      // short-lived, revocable and carry no admin scope.
      if (/^wko_[A-Za-z0-9_-]{43}$/.test(key)) {
        if (!bearer) throw new UnauthorizedError('OAuth access tokens require Authorization: Bearer')
        if (!config.keyPepper) throw new UnauthorizedError('unknown OAuth access token')
        const tokenHash = hashApiKey(key, config.keyPepper)
        const { rows } = await db.query<OAuthTokenRow>(
          `SELECT t.id, t.client_id, t.scopes, t.principal_name, t.principal_space_id,
                  t.principal_key_id, t.principal_key_hash, t.principal_kind
             FROM wk_oauth_access_tokens t
             JOIN wk_oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = $1
              AND t.resource = $2
              AND t.revoked_at IS NULL
              AND t.expires_at > now()
              AND c.revoked_at IS NULL
              AND (
                t.principal_kind = 'identity'
                OR t.principal_key_id = 'bootstrap'
                OR EXISTS (
                  SELECT 1 FROM wk_api_keys k
                   WHERE k.id::text = t.principal_key_id
                     AND k.key_hash = t.principal_key_hash
                     AND k.revoked_at IS NULL
                )
              )
            LIMIT 1`,
          [tokenHash, `${config.publicUrl}/mcp`],
        )
        const row = rows[0]
        if (!row) throw new UnauthorizedError('unknown or expired OAuth access token')
        if (!(await identityGrantIsCurrent(db, config, row))) {
          throw new UnauthorizedError('the interactive identity behind this OAuth grant is no longer active')
        }
        if (
          row.principal_key_id === 'bootstrap' &&
          (!config.bootstrapApiKey ||
            !safeEqual(row.principal_key_hash, hashApiKey(config.bootstrapApiKey, config.keyPepper)))
        ) {
          throw new UnauthorizedError('the API key behind this OAuth grant is no longer active')
        }
        db.update(
          'wk_oauth_access_tokens',
          { id: `eq.${row.id}` },
          { last_used_at: new Date().toISOString() },
          { returning: false },
        ).catch(() => {})
        return {
          keyId: `oauth:${row.id}`,
          scopes: (row.scopes ?? []).filter((scope) => scope !== 'offline_access'),
          spaceId: row.principal_space_id,
          name: `oauth:${row.principal_name}`,
        }
      }

      // Env bootstrap key first: it exists before any DB row does (that is
      // its purpose) and never touches the pool. Constant-time compare — the
      // bootstrap key is the crown jewels.
      if (config.bootstrapApiKey && safeEqual(key, config.bootstrapApiKey)) {
        return { keyId: 'bootstrap', scopes: ['*'], spaceId: null, name: 'bootstrap' }
      }
      if (!config.keyPepper) throw new UnauthorizedError('unknown API key')

      const keyHash = hashApiKey(key, config.keyPepper)
      // Lookup by hash equality is not a timing side channel: the attacker
      // controls the key, not the stored hash, and HMAC output is uniform.
      const [row] = await db.select<KeyRow>('wk_api_keys', {
        key_hash: `eq.${keyHash}`,
        revoked_at: 'is.null',
        limit: 1,
      })
      if (!row) throw new UnauthorizedError('unknown API key')
      // SSO-minted keys (POST /v1/identity/sessions) are bound to their
      // wk_oauth_identities grant, and that row stays the single AuthZ truth
      // (0028): recheck it LIVE, exactly like the OAuth-token path — a
      // revoked or deleted grant answers 401 on the next request, and a
      // downgraded ceiling cuts the key's stored snapshot immediately
      // instead of surviving until a re-login.
      let scopes = row.scopes ?? []
      if (row.identity_provider && row.identity_subject) {
        const ceiling = await liveIdentityCeiling(db, config, row.identity_provider, row.identity_subject)
        if (!ceiling) throw new UnauthorizedError('the interactive identity behind this API key is no longer active')
        scopes = cutScopesToCeiling(scopes, ceiling)
      }
      // Fire-and-forget: last_used_at is telemetry, and an UPDATE failure
      // must never fail an authenticated request.
      db.update(
        'wk_api_keys',
        { id: `eq.${row.id}` },
        { last_used_at: new Date().toISOString() },
        { returning: false },
      ).catch(() => {})
      return { keyId: row.id, scopes, spaceId: row.space_id, name: row.name }
    },

    requireScope(principal, scope, spaceId) {
      const accepted = Array.isArray(scope) ? (scope as readonly Scope[]) : [scope as Scope]
      const scopes = principal.scopes
      // '*' implies everything. 'admin' implies all knowledge scopes but NOT
      // '*' (§5.2 note) — the distinction only matters for future scopes, but
      // encoding it now keeps the rule honest. 'knowledge:approve' implies
      // 'knowledge:review' (review is the inspect subset of approve).
      const has = accepted.some(
        (candidate) =>
          scopes.includes('*') ||
          scopes.includes(candidate) ||
          (candidate !== 'admin' && scopes.includes('admin')) ||
          (candidate === 'knowledge:review' && scopes.includes('knowledge:approve')),
      )
      if (!has) throw new ForbiddenError(`this key lacks the ${accepted.join(' or ')} scope`)
      if (spaceId && principal.spaceId && principal.spaceId !== spaceId) {
        throw new ForbiddenError('this key is scoped to a different space')
      }
    },

    async createKey({ name, scopes, spaceId = null, identity = null }) {
      if (!config.keyPepper) {
        throw new ValidationError('WIKIKIT_KEY_PEPPER is not configured — cannot mint API keys')
      }
      const invalid = scopes.filter((scope) => !VALID_SCOPES.has(scope))
      if (invalid.length) throw new ValidationError(`unknown scope(s): ${invalid.join(', ')}`)
      const key = generateApiKey()
      const [row] = await db.insert<{ id: string }>('wk_api_keys', {
        name,
        key_hash: hashApiKey(key, config.keyPepper),
        scopes,
        space_id: spaceId,
        identity_provider: identity?.provider ?? null,
        identity_subject: identity?.subject ?? null,
      })
      return { id: row!.id, key }
    },

    async ensureDevBootstrapKey(logger) {
      if (config.production || config.bootstrapApiKey || !config.keyPepper) return
      const existing = await db.select<{ id: string }>('wk_api_keys', { revoked_at: 'is.null', limit: 1 })
      if (existing.length) return
      const { key } = await auth.createKey({ name: 'bootstrap', scopes: ['*'] })
      // Plain stdout on purpose (not a JSON log line): this is the one
      // operator-facing moment of zero-config boot, and it happens once.
      process.stdout.write(`\nWikiKit bootstrap API key (shown once, scope *):\n\n  ${key}\n\n`)
      logger.info('dev bootstrap API key minted', { name: 'bootstrap' })
    },
  }
  return auth
}
