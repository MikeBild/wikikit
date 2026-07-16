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
  /** Throws ForbiddenError (403 insufficient_scope) when the principal lacks `scope` or is scoped to a different space. */
  requireScope(principal: Principal, scope: Scope, spaceId?: string): void
  /** Mint a key. The plaintext is returned exactly once and never stored. */
  createKey(args: { name: string; scopes: string[]; spaceId?: string | null }): Promise<{ id: string; key: string }>
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
  'knowledge:approve',
  'admin',
  '*',
])

interface KeyRow {
  id: string
  name: string
  scopes: string[]
  space_id: string | null
}

export function createAuth(config: Config, db: Db): Auth {
  const auth: Auth = {
    async authenticate(headerValue) {
      if (!headerValue) throw new UnauthorizedError('missing API key (Authorization: Bearer or X-API-Key)')
      // Accept both `Bearer wk_...` (Authorization) and a bare key (X-API-Key
      // value, or a client that skips the Bearer prefix).
      const key = headerValue.match(/^Bearer\s+(.+)$/i)?.[1] ?? headerValue

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
      // Fire-and-forget: last_used_at is telemetry, and an UPDATE failure
      // must never fail an authenticated request.
      db.update(
        'wk_api_keys',
        { id: `eq.${row.id}` },
        { last_used_at: new Date().toISOString() },
        { returning: false },
      ).catch(() => {})
      return { keyId: row.id, scopes: row.scopes ?? [], spaceId: row.space_id, name: row.name }
    },

    requireScope(principal, scope, spaceId) {
      const scopes = principal.scopes
      // '*' implies everything. 'admin' implies all knowledge scopes but NOT
      // '*' (§5.2 note) — the distinction only matters for future scopes, but
      // encoding it now keeps the rule honest.
      const has = scopes.includes('*') || scopes.includes(scope) || (scope !== 'admin' && scopes.includes('admin'))
      if (!has) throw new ForbiddenError(`this key lacks the ${scope} scope`)
      if (spaceId && principal.spaceId && principal.spaceId !== spaceId) {
        throw new ForbiddenError('this key is scoped to a different space')
      }
    },

    async createKey({ name, scopes, spaceId = null }) {
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
