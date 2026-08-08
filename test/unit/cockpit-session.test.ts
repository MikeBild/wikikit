// The cockpit's credential plane: GET/DELETE /v1/session, the cockpit-login
// entry into the existing browser funnel, and the operator-session cookie used
// as a FALLBACK credential on ordinary REST routes.
//
// The three properties these tests exist to hold:
//   1. /v1/session never answers 401. "Nobody is signed in" is an answer the
//      console renders, not a failure it recovers from.
//   2. A header credential always wins. Adding the cookie plane must not change
//      the 401/403 an API-key client has always seen.
//   3. return_to is a same-origin PATH under /cockpit or it is not honoured.
//      Everything else is an open redirect with a friendly name.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import { createApp, type App } from '../../src/app.ts'
import { hashApiKey } from '../../src/http/auth.ts'
import { createFakeProvider } from '../helpers/fake-provider.ts'
import { createLogger } from '../../src/logger.ts'
import { COCKPIT_LOGIN_MAX_PER_MINUTE } from '../../src/oauth/server.ts'
import * as realOidc from '../../src/oauth/oidc.ts'

const PEPPER = 'cockpit-session-pepper'
const BOOTSTRAP = 'wk_test-bootstrap-key'
const PUBLIC_URL = 'https://wikikit.test'
const SESSION_TOKEN = `wkos_${'s'.repeat(43)}`
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000

const OPERATOR = {
  id: '00000000-0000-0000-0000-0000000000a1',
  principal_kind: 'identity' as const,
  principal_key_id: 'identity:workforce:mike',
  principal_key_hash: 'unused-for-identity-sessions',
  principal_name: 'mike@example.com',
  principal_space_id: null,
  provider_id: 'workforce',
  provider_subject: 'mike',
  scopes: ['knowledge:read', 'knowledge:propose'],
  expires_at: new Date(Date.now() + EIGHT_HOURS_MS).toISOString(),
}

/**
 * Minimal Db stub. `session` is what the operator-session lookup finds;
 * `identity` is the live grant its scopes are re-cut against on every read
 * (an identity session with no live grant is a dead session, by design);
 * `renewedExpiresAt` is what the sliding `UPDATE … RETURNING expires_at`
 * hands back, which is where the operator cookie's Max-Age comes from — set it
 * BELOW the eight-hour slide to model a session near its 24-hour cap, because
 * `least(absolute_expires_at, …)` is what clamps it in real Postgres.
 *
 * A login state that was inserted is served back to the funnel's own lookup.
 * The state_hash is not matched: the funnel validates the token's shape before
 * it queries, and the point of these tests is what the funnel does with the row
 * it finds, not that Postgres can compare two hashes.
 */
function stubDb(
  options: {
    session?: typeof OPERATOR | null
    identity?: { allowed_scopes: string[] } | null
    renewedExpiresAt?: string
  } = {},
) {
  const inserts: { table: string; body: Record<string, unknown> }[] = []
  const updates: { table: string; body: Record<string, unknown> }[] = []
  const db: Db = {
    async query(sql: string) {
      if (sql.includes('UPDATE wk_oauth_operator_sessions')) {
        const expires = options.renewedExpiresAt ?? new Date(Date.now() + EIGHT_HOURS_MS).toISOString()
        return { rows: [{ expires_at: expires }] as never[], rowCount: 1 }
      }
      if (sql.includes('FROM wk_oauth_operator_sessions')) {
        const row = options.session === undefined ? null : options.session
        return { rows: (row ? [{ ...row }] : []) as never[], rowCount: row ? 1 : 0 }
      }
      if (sql.includes('FROM wk_oauth_identities')) {
        const grant = options.identity === undefined ? { allowed_scopes: OPERATOR.scopes } : options.identity
        return { rows: (grant ? [grant] : []) as never[], rowCount: grant ? 1 : 0 }
      }
      if (sql.includes('FROM wk_oauth_login_states')) {
        const minted = inserts.findLast((insert) => insert.table === 'wk_oauth_login_states')
        if (!minted) return { rows: [], rowCount: 0 }
        return { rows: [{ id: '00000000-0000-0000-0000-0000000000c1', ...minted.body }] as never[], rowCount: 1 }
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
    async select() {
      return []
    },
    async insert(table, body) {
      const rows = Array.isArray(body) ? body : [body]
      for (const row of rows) inserts.push({ table: String(table), body: row as Record<string, unknown> })
      return rows.map((row) => ({ id: '00000000-0000-0000-0000-0000000000b1', ...row })) as never[]
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
    publicUrl: PUBLIC_URL,
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
      // The identity session below is re-checked against this provider on
      // every read; without it configured, the session is correctly treated as
      // dead — which is the behaviour, not the thing under test here.
      {
        protocol: 'oidc',
        id: 'workforce',
        label: 'Workforce OIDC',
        issuer: 'https://issuer.example.test',
        clientId: 'wikikit-test',
        scopes: 'openid email profile',
        allowedEmails: [],
        allowedSubjects: [],
        allowedScopes: ['knowledge:read', 'knowledge:propose', 'knowledge:approve'],
      },
    ],
  }
}

const apps: App[] = []

async function boot(db: Db, overrides: Partial<Config> = {}): Promise<string> {
  const app = createApp(
    { ...testConfig(), ...overrides },
    {
      database: { db, async close() {} },
      llm: createFakeProvider(),
      logger: createLogger({ level: 'error', write: () => {} }),
    },
  )
  apps.push(app)
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address() as { port: number }
  return `http://127.0.0.1:${address.port}`
}

// The name the funnel actually sets: `__Host-` prefixed because publicUrl here
// is https, which is also what a real deployment looks like.
const cookie = `__Host-wikikit_operator=${encodeURIComponent(SESSION_TOKEN)}`

beforeAll(() => {
  mock.module('../../src/oauth/oidc.ts', () => ({ ...realOidc }))
})

afterAll(async () => {
  for (const app of apps) await app.close()
})

describe('GET /v1/session', () => {
  test('answers 200 with a null session for an anonymous tab — never 401', async () => {
    const { db } = stubDb({ session: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/session`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ session: null })
  })

  test('answers 200 with a null session when the cookie no longer resolves', async () => {
    const { db } = stubDb({ session: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/session`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ session: null })
  })

  test('names the operator, their scopes and how they signed in', async () => {
    const { db } = stubDb({ session: OPERATOR })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/session`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      session: {
        name: 'mike@example.com',
        kind: 'identity',
        scopes: ['knowledge:read', 'knowledge:propose'],
        space_id: null,
        provider_id: 'workforce',
      },
    })
  })

  test('reports the scopes the identity grant currently allows, not the ones minted', async () => {
    // A grant narrowed after the session was minted narrows the session too:
    // the console must not offer a control the server will now refuse.
    const { db } = stubDb({ session: OPERATOR, identity: { allowed_scopes: ['knowledge:read'] } })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/session`, { headers: { cookie } })
    const body = (await res.json()) as { session: { scopes: string[] } }
    expect(body.session.scopes).toEqual(['knowledge:read'])
  })
})

/**
 * The regression: `currentOperator` slid `expires_at` in the DATABASE on every
 * read, but nothing re-wrote the browser's cookie outside login/consent/logout.
 * An operator working continuously was therefore hard-signed-out eight hours
 * after signing in — by their own browser dropping a cookie whose session was
 * still alive — while CONTRACTS.md promised a sliding eight-hour IDLE limit.
 */
describe('the operator cookie slides with the session it stands for', () => {
  function maxAgeOf(setCookie: string | null): number {
    const match = /Max-Age=(\d+)/.exec(setCookie ?? '')
    if (!match) throw new Error(`no Max-Age in set-cookie: ${setCookie}`)
    return Number(match[1])
  }

  test("re-stamps the cookie from the row's renewed idle deadline", async () => {
    const { db } = stubDb({ session: OPERATOR })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/session`, { headers: { cookie } })
    const setCookie = res.headers.get('set-cookie')
    // The SAME token, so this renews a session rather than minting one.
    expect(setCookie).toContain(`__Host-wikikit_operator=${SESSION_TOKEN}`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(maxAgeOf(setCookie)).toBeGreaterThan(EIGHT_HOURS_MS / 1000 - 10)
    expect(maxAgeOf(setCookie)).toBeLessThanOrEqual(EIGHT_HOURS_MS / 1000)
  })

  test('never hands the browser more life than the 24-hour absolute cap left', async () => {
    // 45 minutes short of the cap: `least(absolute_expires_at, now() + 8h)`
    // has clamped the row, and the cookie must inherit the clamp rather than a
    // fresh eight hours — otherwise the renewal quietly becomes the extension
    // the absolute cap exists to forbid.
    const { db } = stubDb({ session: OPERATOR, renewedExpiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString() })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/session`, { headers: { cookie } })
    const maxAge = maxAgeOf(res.headers.get('set-cookie'))
    expect(maxAge).toBeGreaterThan(45 * 60 - 10)
    expect(maxAge).toBeLessThanOrEqual(45 * 60)
  })

  test('sets no cookie for a tab that is not signed in', async () => {
    const { db } = stubDb({ session: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/session`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

describe('DELETE /v1/session', () => {
  test('refuses without a same-origin Origin — SameSite=Lax does not cover every write', async () => {
    const { db, updates } = stubDb({ session: OPERATOR })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/session`, {
      method: 'DELETE',
      headers: { cookie, origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    expect(updates.some((update) => update.table === 'wk_oauth_operator_sessions')).toBe(false)
  })

  test('refuses when no Origin was sent at all — a browser always sends one on a write', async () => {
    const { db } = stubDb({ session: OPERATOR })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/session`, { method: 'DELETE', headers: { cookie } })
    expect(res.status).toBe(403)
  })

  test('revokes the session and clears the cookie', async () => {
    const { db, updates } = stubDb({ session: OPERATOR })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/session`, {
      method: 'DELETE',
      headers: { cookie, origin: PUBLIC_URL },
    })
    expect(res.status).toBe(204)
    const revoked = updates.find((update) => update.table === 'wk_oauth_operator_sessions')
    expect(revoked?.body.revoked_at).toBeString()
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

describe('GET /v1/identity/cockpit-login', () => {
  test('mints a cockpit-purpose login state and hands the browser to the shared chooser', async () => {
    const { db, inserts } = stubDb({ session: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/cockpit-login?return_to=%2Fcockpit%2Fchanges`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/v1/identity/login/start?login_state=wkl_')
    const state = inserts.find((insert) => insert.table === 'wk_oauth_login_states')
    expect(state?.body.purpose).toBe('cockpit')
    expect(state?.body.return_to).toBe('/cockpit/changes')
    // A cockpit state is not an authorization request and must not look like one.
    expect(state?.body.client_id).toBeUndefined()
    expect(state?.body.redirect_uri).toBeUndefined()
  })

  test('sends an already-signed-in operator straight back, without a chooser', async () => {
    const { db, inserts } = stubDb({ session: OPERATOR })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/cockpit-login?return_to=%2Fcockpit%2Fpages`, {
      headers: { cookie },
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/cockpit/pages')
    expect(inserts.some((insert) => insert.table === 'wk_oauth_login_states')).toBe(false)
  })

  test.each([
    ['an absolute URL naming another host', 'https://evil.example/cockpit'],
    ['a protocol-relative URL', '//evil.example'],
    ['a path outside the cockpit', '/v1/api-keys'],
    ['a path that merely starts with the prefix', '/cockpitfoo'],
    ['nothing at all', ''],
    // Everything below is a code point node's res.setHeader refuses to write —
    // by throwing, halfway through a redirect the funnel has already committed
    // to. The browser percent-encodes location.pathname/search before the
    // console ever builds a return_to, so none of these is a deep link anybody
    // typed.
    ['a NUL byte', `/cockpit/${String.fromCharCode(0)}`],
    ['a DEL byte', `/cockpit/${String.fromCharCode(0x7f)}`],
    ['a bare CR', `/cockpit/${String.fromCharCode(13)}Location:%20https://evil.example`],
    ['a raw non-ASCII code point', '/cockpit/Ā'],
    ['a Unicode line separator', `/cockpit/${String.fromCharCode(0x2028)}`],
  ])('falls back to the cockpit root for %s', async (_case, returnTo) => {
    const { db, inserts } = stubDb({ session: null })
    const base = await boot(db)
    await fetch(`${base}/v1/identity/cockpit-login?return_to=${encodeURIComponent(returnTo)}`, { redirect: 'manual' })
    const state = inserts.find((insert) => insert.table === 'wk_oauth_login_states')
    expect(state?.body.return_to).toBe('/cockpit/')
  })

  test('a crafted return_to cannot end a sign-in on a 500 with the state already spent', async () => {
    // The whole crafted link, walked end to end: an operator clicks
    // `?return_to=/cockpit/%00`, signs in with an API key, and lands. Before
    // the non-printable rule the NUL survived into the login state, and
    // `finishCockpitLogin` stamped `consumed_at` BEFORE building the redirect
    // whose `location` header node then refused to write — so the operator got
    // a 500, and the single-use state that would have let them retry was gone.
    const { db, inserts, updates } = stubDb({ session: null })
    const base = await boot(db)
    const crafted = `/cockpit/changes${String.fromCharCode(0)}`
    const entry = await fetch(`${base}/v1/identity/cockpit-login?return_to=${encodeURIComponent(crafted)}`, {
      redirect: 'manual',
    })
    expect(entry.status).toBe(302)
    const loginState = new URL(entry.headers.get('location') ?? '').searchParams.get('login_state') ?? ''
    expect(loginState).toStartWith('wkl_')

    const landed = await fetch(`${base}/v1/identity/login/start`, {
      method: 'POST',
      body: new URLSearchParams({ provider: 'api-key', login_state: loginState, api_key: BOOTSTRAP }),
      redirect: 'manual',
    })
    expect(landed.status).toBe(302)
    expect(landed.headers.get('location')).toBe('/cockpit/')
    expect(landed.headers.get('set-cookie')).toContain('__Host-wikikit_operator=wkos_')
    // The state was consumed exactly once, for a sign-in that actually landed.
    expect(inserts.find((insert) => insert.table === 'wk_oauth_login_states')?.body.return_to).toBe('/cockpit/')
    expect(updates.filter((update) => update.table === 'wk_oauth_login_states')).toHaveLength(1)
  })
})

/**
 * The only login-state-minting path with no client, no credential and no
 * consent behind it: every anonymous GET used to buy an INSERT into
 * `wk_oauth_login_states`, a table the housekeeping sweep only visits hourly.
 */
describe('GET /v1/identity/cockpit-login is rate limited per remote address', () => {
  test('a burst past the limit is refused as a page a human can read', async () => {
    const { db, inserts } = stubDb({ session: null })
    const base = await boot(db)
    for (let attempt = 1; attempt <= COCKPIT_LOGIN_MAX_PER_MINUTE; attempt += 1) {
      const res = await fetch(`${base}/v1/identity/cockpit-login`, { redirect: 'manual' })
      expect(res.status, `sign-in ${attempt} of the allowance`).toBe(302)
    }
    const refused = await fetch(`${base}/v1/identity/cockpit-login`, { redirect: 'manual' })
    expect(refused.status).toBe(429)
    // A browser surface answers a browser. Raw JSON here would be a page an
    // operator cannot act on.
    expect(refused.headers.get('content-type')).toContain('text/html')
    const html = await refused.text()
    expect(html).toContain('data-auth-contract="mcp-auth"')
    expect(html).toContain('Too many sign-in attempts')
    // NOT the expired-state message: that would send a throttled operator
    // straight back into the loop that throttled them.
    expect(html).not.toContain('expired or was already used')
    expect(inserts.filter((insert) => insert.table === 'wk_oauth_login_states')).toHaveLength(
      COCKPIT_LOGIN_MAX_PER_MINUTE,
    )
  })

  test('an operator who already holds a session is never charged for arriving', async () => {
    // No row is created for them, so there is nothing to meter — and metering
    // it would throttle the one person the door exists for.
    const { db, inserts } = stubDb({ session: OPERATOR })
    const base = await boot(db)
    for (let attempt = 1; attempt <= COCKPIT_LOGIN_MAX_PER_MINUTE + 5; attempt += 1) {
      const res = await fetch(`${base}/v1/identity/cockpit-login?return_to=%2Fcockpit%2Fpages`, {
        headers: { cookie },
        redirect: 'manual',
      })
      expect(res.status, `arrival ${attempt}`).toBe(302)
      expect(res.headers.get('location')).toBe('/cockpit/pages')
    }
    expect(inserts.some((insert) => insert.table === 'wk_oauth_login_states')).toBe(false)
  })

  test('the registration bucket and the sign-in bucket do not spend each other', async () => {
    // Both limits live in one store; if the bucket name were not part of the
    // key, a client-registration flood would lock operators out of the console.
    const { db } = stubDb({ session: null })
    const base = await boot(db)
    const register = () =>
      fetch(`${base}/v1/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://client.example/callback'] }),
      })
    let exhausted = false
    for (let attempt = 1; attempt <= 20 && !exhausted; attempt += 1) {
      exhausted = (await register()).status === 429
    }
    expect(exhausted).toBe(true)
    const signIn = await fetch(`${base}/v1/identity/cockpit-login`, { redirect: 'manual' })
    expect(signIn.status).toBe(302)
  })
})

describe('the operator cookie as a REST credential', () => {
  test('authenticates a scoped GET that carries no header credential', async () => {
    const { db } = stubDb({ session: OPERATOR })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/spaces`, { headers: { cookie } })
    expect(res.status).toBe(200)
  })

  test('still answers 401 for a request with neither a header nor a cookie', async () => {
    const { db } = stubDb({ session: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/spaces`)
    expect(res.status).toBe(401)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'unauthorized' })
  })

  test('a header credential wins — a bad key fails as it always has, cookie or not', async () => {
    // The regression this guards: making the cookie an override rather than a
    // fallback would silently repair a broken API key and hide the outage the
    // 401 was reporting.
    const { db } = stubDb({ session: OPERATOR })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/spaces`, {
      headers: { cookie, authorization: 'Bearer wk_definitely-not-a-key' },
    })
    expect(res.status).toBe(401)
  })

  test('refuses a cookie-authenticated write with no Origin', async () => {
    const { db } = stubDb({ session: OPERATOR })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'x', name: 'X' }),
    })
    // Falls through to header authentication, which finds nothing.
    expect(res.status).toBe(401)
  })

  test('accepts a cookie-authenticated write from this origin', async () => {
    const admin = { ...OPERATOR, scopes: ['admin'] }
    const { db } = stubDb({ session: admin, identity: { allowed_scopes: ['admin'] } })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/spaces`, {
      method: 'POST',
      headers: { cookie, origin: PUBLIC_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'a-wiki', name: 'A wiki' }),
    })
    // Whatever the handler makes of the body, it got past authentication —
    // which is the only thing this test is about.
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })
})

describe('the sign-in funnel follows the console theme', () => {
  test('stamps scheme-dark on the document when the console stored dark', async () => {
    const { db } = stubDb({ session: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/login/start?login_state=wkl_${'a'.repeat(43)}`, {
      headers: { cookie: 'wk-cockpit-theme=dark' },
    })
    const html = await res.text()
    expect(html).toContain('<html lang="en" class="scheme-dark">')
    expect(res.headers.get('vary')?.toLowerCase()).toContain('cookie')
  })

  test('leaves the document alone when no scheme was chosen — absence means follow the OS', async () => {
    const { db } = stubDb({ session: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/login/start?login_state=wkl_${'a'.repeat(43)}`)
    const html = await res.text()
    expect(html).toContain('<html lang="en">')
    expect(html).not.toContain('scheme-dark"')
  })

  test('a malformed theme cookie does not take the whole funnel down', async () => {
    // `decodeURIComponent('%')` throws. Unguarded, one bad cookie 500'd every
    // HTML response in the funnel — sign-in for the console AND for every MCP
    // client — and this cookie is deliberately script-writable, so any page on
    // the same registrable domain could set it.
    const { db } = stubDb({ session: null })
    const base = await boot(db)
    for (const value of ['%', '%zz', '%E0%A4%A', 'dark%']) {
      const res = await fetch(`${base}/v1/identity/login/start?login_state=wkl_${'a'.repeat(43)}`, {
        headers: { cookie: `wk-cockpit-theme=${value}` },
      })
      // The state is unknown in this stub, so the funnel answers its styled
      // "sign-in failed" page — which is the point: it answers, in the shared
      // shell, instead of dying in the cookie parser.
      expect(res.status, value).toBeLessThan(500)
      expect(res.headers.get('content-type'), value).toContain('text/html')
      expect(await res.text(), value).toContain('data-auth-contract="mcp-auth"')
    }
  })

  test('a value that will not decode does not select a scheme either', async () => {
    // It is used as sent and simply fails the equality check, rather than
    // being guessed at.
    const { db } = stubDb({ session: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/identity/login/start?login_state=wkl_${'a'.repeat(43)}`, {
      headers: { cookie: 'wk-cockpit-theme=%' },
    })
    const html = await res.text()
    expect(html).toContain('<html lang="en">')
    expect(html).not.toContain('scheme-dark"')
  })

  test('a malformed session cookie is a signed-out tab, not a failure', async () => {
    const { db } = stubDb({ session: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/session`, { headers: { cookie: '__Host-wikikit_operator=%' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ session: null })
  })
})

describe('the bootstrap key still works exactly as before', () => {
  test('a header credential authenticates with no cookie in sight', async () => {
    const { db } = stubDb({ session: null })
    const base = await boot(db)
    const res = await fetch(`${base}/v1/spaces`, { headers: { authorization: `Bearer ${BOOTSTRAP}` } })
    expect(res.status).toBe(200)
    // The pepper is what the bootstrap key is compared through; if this ever
    // stops being true the stub above is lying about the whole auth path.
    expect(hashApiKey(BOOTSTRAP, PEPPER)).toBeString()
  })
})
