// Auth unit tests — key hashing, bootstrap key, 401 vs 403 semantics, scope
// implication rules and space scoping, against a stubbed Db.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import { ForbiddenError, UnauthorizedError } from '../../src/domain/errors.ts'
import { createAuth, generateApiKey, hashApiKey, type Principal } from '../../src/http/auth.ts'
import { createLogger } from '../../src/logger.ts'

const PEPPER = 'unit-test-pepper'

function testConfig(overrides: Partial<Config> = {}): Config {
  return { production: false, keyPepper: PEPPER, bootstrapApiKey: '', ...overrides } as Config
}

interface KeyFixture {
  id: string
  name: string
  key_hash: string
  scopes: string[]
  space_id: string | null
  revoked_at: string | null
}

// Just enough Db for auth: select filters on key_hash + revoked_at is.null,
// insert returns an id, update records last_used_at calls.
function stubDb(keys: KeyFixture[]) {
  const updates: unknown[] = []
  const inserted: Record<string, unknown>[] = []
  const db = {
    async select(table: string, query: Record<string, unknown> = {}) {
      if (table !== 'wk_api_keys') return []
      const hash = String(query.key_hash ?? '').replace(/^eq\./, '')
      return keys.filter((k) => (!hash || k.key_hash === hash) && (query.revoked_at !== 'is.null' || !k.revoked_at))
    },
    async insert(_table: string, body: Record<string, unknown>) {
      inserted.push(body)
      return [{ id: '11111111-1111-1111-1111-111111111111', ...body }]
    },
    async update(...args: unknown[]) {
      updates.push(args)
      return []
    },
  } as unknown as Db
  return { db, updates, inserted }
}

describe('http auth', () => {
  test('generateApiKey mints wk_ + 43 chars base64url', () => {
    const key = generateApiKey()
    expect(key).toMatch(/^wk_[A-Za-z0-9_-]{43}$/)
    expect(generateApiKey()).not.toBe(key)
  })

  test('hashApiKey is a deterministic pepper-keyed HMAC', () => {
    expect(hashApiKey('wk_abc', PEPPER)).toBe(hashApiKey('wk_abc', PEPPER))
    expect(hashApiKey('wk_abc', PEPPER)).not.toBe(hashApiKey('wk_abc', 'other-pepper'))
    expect(hashApiKey('wk_abc', PEPPER)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('authenticate: missing header → 401', async () => {
    const auth = createAuth(testConfig(), stubDb([]).db)
    expect(auth.authenticate(undefined)).rejects.toBeInstanceOf(UnauthorizedError)
  })

  test('authenticate: unknown key → 401 unauthorized', async () => {
    const auth = createAuth(testConfig(), stubDb([]).db)
    expect(auth.authenticate('Bearer wk_nope')).rejects.toBeInstanceOf(UnauthorizedError)
  })

  test('authenticate: bootstrap key resolves without touching the db, Bearer or bare', async () => {
    const auth = createAuth(testConfig({ bootstrapApiKey: 'wk_bootstrap' }), stubDb([]).db)
    const viaBearer = await auth.authenticate('Bearer wk_bootstrap')
    const bare = await auth.authenticate('wk_bootstrap')
    for (const principal of [viaBearer, bare]) {
      expect(principal.keyId).toBe('bootstrap')
      expect(principal.scopes).toEqual(['*'])
      expect(principal.spaceId).toBeNull()
    }
  })

  test('authenticate: known key resolves to its principal; revoked key is 401', async () => {
    const key = generateApiKey()
    const fixture: KeyFixture = {
      id: 'k-1',
      name: 'reader',
      key_hash: hashApiKey(key, PEPPER),
      scopes: ['knowledge:read'],
      space_id: 'space-1',
      revoked_at: null,
    }
    const { db } = stubDb([fixture])
    const auth = createAuth(testConfig(), db)
    const principal = await auth.authenticate(`Bearer ${key}`)
    expect(principal).toMatchObject({ keyId: 'k-1', name: 'reader', scopes: ['knowledge:read'], spaceId: 'space-1' })

    const revoked = createAuth(testConfig(), stubDb([{ ...fixture, revoked_at: '2026-01-01' }]).db)
    expect(revoked.authenticate(`Bearer ${key}`)).rejects.toBeInstanceOf(UnauthorizedError)
  })

  test('requireScope: * implies everything, admin implies knowledge scopes but not vice versa', () => {
    const auth = createAuth(testConfig(), stubDb([]).db)
    const p = (scopes: string[], spaceId: string | null = null): Principal => ({
      keyId: 'k',
      name: 'k',
      scopes,
      spaceId,
    })

    expect(() => auth.requireScope(p(['*']), 'admin')).not.toThrow()
    expect(() => auth.requireScope(p(['admin']), 'knowledge:approve')).not.toThrow()
    expect(() => auth.requireScope(p(['knowledge:read']), 'knowledge:read')).not.toThrow()
    expect(() => auth.requireScope(p(['knowledge:read']), 'knowledge:propose')).toThrow(ForbiddenError)
    expect(() => auth.requireScope(p(['knowledge:approve']), 'admin')).toThrow(ForbiddenError)
  })

  test('requireScope: space-scoped key on a foreign space → 403 insufficient_scope', () => {
    const auth = createAuth(testConfig(), stubDb([]).db)
    const principal: Principal = { keyId: 'k', name: 'k', scopes: ['knowledge:read'], spaceId: 'space-1' }
    expect(() => auth.requireScope(principal, 'knowledge:read', 'space-1')).not.toThrow()
    expect(() => auth.requireScope(principal, 'knowledge:read', 'space-2')).toThrow(ForbiddenError)
    // No space given (global routes): scope alone decides.
    expect(() => auth.requireScope(principal, 'knowledge:read')).not.toThrow()
  })

  test('createKey stores a hash (never the plaintext) and validates scopes', async () => {
    const { db, inserted } = stubDb([])
    const auth = createAuth(testConfig(), db)
    const { key } = await auth.createKey({ name: 'ci', scopes: ['knowledge:read'] })
    expect(key).toMatch(/^wk_/)
    expect(inserted[0]!.key_hash).toBe(hashApiKey(key, PEPPER))
    expect(JSON.stringify(inserted[0])).not.toContain(key)
    expect(auth.createKey({ name: 'x', scopes: ['bogus'] })).rejects.toThrow('unknown scope')
  })

  test('ensureDevBootstrapKey is a no-op in production and when keys exist', async () => {
    const logger = createLogger({ level: 'error', write: () => {} })
    const prod = createAuth(testConfig({ production: true }), stubDb([]).db)
    await prod.ensureDevBootstrapKey(logger) // must not throw / insert

    const { db, inserted } = stubDb([
      { id: 'k', name: 'k', key_hash: 'h', scopes: ['*'], space_id: null, revoked_at: null },
    ])
    await createAuth(testConfig(), db).ensureDevBootstrapKey(logger)
    expect(inserted).toHaveLength(0)
  })
})
