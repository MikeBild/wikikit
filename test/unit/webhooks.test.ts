// Webhooks unit tests: signature, secrets-at-rest, SSRF validation, endpoint
// registration, and the full outbox worker lifecycle (fan-out → deliver →
// backoff → circuit breaker) against an in-memory fake Db — no network, no
// Postgres.
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import { createLogger } from '../../src/logger.ts'
import { decryptSecret, encryptSecret, generateWebhookSecret, isBlockedAddress } from '../../src/secrets.ts'
import {
  createOutboxWorker,
  listWebhookDeliveries,
  listWebhookEndpoints,
  registerWebhookEndpoint,
  signWebhook,
  verifyWebhookSignature,
  zWebhookEnvelope,
} from '../../src/webhooks.ts'

// ---------------------------------------------------------------------------
// Test scaffolding

const silentLogger = createLogger({ level: 'error', write: () => {} })

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    keyPepper: 'unit-test-pepper',
    webhookPollMs: 60_000,
    webhookTimeoutMs: 5_000,
    webhookMaxAttempts: 3,
    webhookCircuitThreshold: 2,
    webhookAllowPrivateTargets: true,
    ...overrides,
  } as Config
}

interface FakeRow {
  [key: string]: unknown
}

// Minimal in-memory Db honoring exactly the filter grammar the webhook module
// uses (eq./lte./in.()/is.null + order/limit). Anything else throws so the
// fake can never silently diverge from src/db/postgres.ts semantics.
function createFakeDb() {
  const tables: Record<string, FakeRow[]> = {
    wk_outbox_events: [],
    wk_webhook_endpoints: [],
    wk_webhook_deliveries: [],
  }
  let eventSeq = 1

  function matches(row: FakeRow, filters: Record<string, unknown>): boolean {
    for (const [column, raw] of Object.entries(filters)) {
      if (column === 'order' || column === 'limit' || raw === undefined) continue
      const expression = String(raw)
      if (expression === 'is.null') {
        if (row[column] != null) return false
      } else if (expression === 'not.is.null') {
        if (row[column] == null) return false
      } else if (expression.startsWith('eq.')) {
        if (String(row[column]) !== expression.slice(3)) return false
      } else if (expression.startsWith('lte.')) {
        if (!(new Date(String(row[column])).getTime() <= new Date(expression.slice(4)).getTime())) return false
      } else if (expression.startsWith('in.(') && expression.endsWith(')')) {
        if (!expression.slice(4, -1).split(',').includes(String(row[column]))) return false
      } else {
        throw new Error(`fake db: unsupported filter ${expression}`)
      }
    }
    return true
  }

  const db = {
    async select(table: string, query: Record<string, unknown> = {}) {
      let rows = tables[table]!.filter((row) => matches(row, query))
      const order = query.order as string | undefined
      if (order) {
        const [column, direction = 'asc'] = order.split('.')
        rows = rows
          .slice()
          .sort(
            (a, b) =>
              (a[column!]! > b[column!]! ? 1 : a[column!]! < b[column!]! ? -1 : 0) * (direction === 'desc' ? -1 : 1),
          )
      }
      if (query.limit !== undefined) rows = rows.slice(0, Number(query.limit))
      return rows.map((row) => ({ ...row })) as never[]
    },
    async insert(table: string, body: FakeRow | FakeRow[], options: { returning?: boolean } = {}) {
      const rows = Array.isArray(body) ? body : [body]
      const inserted = rows.map((row) => {
        const full: FakeRow = {
          id: table === 'wk_outbox_events' ? eventSeq++ : crypto.randomUUID(),
          created_at: new Date().toISOString(),
          attempt: 0,
          ...row,
        }
        tables[table]!.push(full)
        return { ...full }
      })
      return (options.returning === false ? [] : inserted) as never[]
    },
    async update(table: string, filters: Record<string, unknown>, patch: FakeRow) {
      const updated: FakeRow[] = []
      for (const row of tables[table]!) {
        if (matches(row, filters)) {
          Object.assign(row, patch)
          updated.push({ ...row })
        }
      }
      return updated as never[]
    },
    async remove() {},
    async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(db as unknown as Db)
    },
    async query(text: string, params: unknown[] = []) {
      // Only the deliveries-join query from listWebhookDeliveries hits raw SQL.
      if (!text.includes('wk_webhook_deliveries')) throw new Error(`fake db: unexpected query ${text}`)
      const [endpointId, limit] = params as [string, number]
      const rows: FakeRow[] = tables
        .wk_webhook_deliveries!.filter((d) => d.endpoint_id === endpointId)
        .map((d) => ({
          ...d,
          event_type: tables.wk_outbox_events!.find((e) => String(e.id) === String(d.event_id))?.event_type ?? null,
        }))
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      const page = rows.slice(0, limit)
      return { rows: page as never[], rowCount: page.length }
    },
    async call() {
      throw new Error('fake db: call() not used by webhooks')
    },
    async emitEvent(spaceId: string, eventType: string, payload: Record<string, unknown>) {
      tables.wk_outbox_events!.push({
        id: eventSeq++,
        space_id: spaceId,
        event_type: eventType,
        payload,
        created_at: new Date().toISOString(),
        dispatched_at: null,
      })
    },
    tables,
  }
  return db
}

type FakeDb = ReturnType<typeof createFakeDb>

const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const PROPOSAL_ID = '22222222-2222-4222-8222-222222222222'

function seedEndpoint(db: FakeDb, config: Config, overrides: FakeRow = {}): FakeRow {
  const endpoint: FakeRow = {
    id: crypto.randomUUID(),
    space_id: SPACE_ID,
    url: 'http://127.0.0.1:9/hook',
    secret: encryptSecret('whsec_unit-test-secret', config.keyPepper),
    events: [],
    active: true,
    failure_count: 0,
    disabled_until: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
  db.tables.wk_webhook_endpoints!.push(endpoint)
  return endpoint
}

async function seedEvent(db: FakeDb, type = 'wikikit.proposal.rejected'): Promise<void> {
  await db.emitEvent(SPACE_ID, type, {
    proposal_id: PROPOSAL_ID,
    space: 'demo',
    reviewer: 'mike',
    note: null,
  })
}

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

// Fetch stub: replies from a status queue (last status repeats) and records
// every request for assertion.
function fakeFetch(statuses: number[]) {
  const requests: CapturedRequest[] = []
  const impl = (async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: String(init?.body ?? ''),
    })
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!
    return new Response(status === 204 ? null : 'x', { status })
  }) as typeof fetch
  return { impl, requests }
}

// ---------------------------------------------------------------------------
// Signature

describe('webhook signature', () => {
  test('produces v1,<base64 HMAC-SHA256 of id.timestamp.body>', () => {
    const expected = `v1,${createHmac('sha256', 's3cret').update('evt_1.1700000000.{"a":1}').digest('base64')}`
    expect(signWebhook('s3cret', 'evt_1', '1700000000', '{"a":1}')).toBe(expected)
  })

  test('verifies its own signatures and rejects tampering', () => {
    const sig = signWebhook('s3cret', 'evt_1', '1700000000', 'body')
    expect(verifyWebhookSignature('s3cret', 'evt_1', '1700000000', 'body', sig)).toBe(true)
    expect(verifyWebhookSignature('s3cret', 'evt_1', '1700000000', 'body!', sig)).toBe(false)
    expect(verifyWebhookSignature('other', 'evt_1', '1700000000', 'body', sig)).toBe(false)
    expect(verifyWebhookSignature('s3cret', 'evt_2', '1700000000', 'body', sig)).toBe(false)
    expect(verifyWebhookSignature('s3cret', 'evt_1', '1700000001', 'body', sig)).toBe(false)
  })

  test('accepts any matching signature in a space-separated header (secret rotation)', () => {
    const sig = signWebhook('s3cret', 'evt_1', '1700000000', 'body')
    expect(verifyWebhookSignature('s3cret', 'evt_1', '1700000000', 'body', `v1,bogus ${sig}`)).toBe(true)
    expect(verifyWebhookSignature('s3cret', 'evt_1', '1700000000', 'body', 'v1,bogus v1,alsobogus')).toBe(false)
    expect(verifyWebhookSignature('s3cret', 'evt_1', '1700000000', 'body', '')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Secrets at rest

describe('secrets', () => {
  test('encrypt/decrypt round-trips with the pepper', () => {
    const encrypted = encryptSecret('whsec_abc', 'pepper')
    expect(encrypted).not.toContain('whsec_abc')
    expect(encrypted.split('.')).toHaveLength(3)
    expect(decryptSecret(encrypted, 'pepper')).toBe('whsec_abc')
  })

  test('decrypt fails with the wrong pepper or malformed input', () => {
    const encrypted = encryptSecret('whsec_abc', 'pepper')
    expect(() => decryptSecret(encrypted, 'other-pepper')).toThrow()
    expect(() => decryptSecret('not-a-secret', 'pepper')).toThrow('malformed encrypted secret')
  })

  test('encryption is non-deterministic (fresh IV per call)', () => {
    expect(encryptSecret('whsec_abc', 'pepper')).not.toBe(encryptSecret('whsec_abc', 'pepper'))
  })

  test('generateWebhookSecret is whsec_-prefixed and unique', () => {
    const secret = generateWebhookSecret()
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/)
    expect(generateWebhookSecret()).not.toBe(secret)
  })

  test('missing pepper is a hard error', () => {
    expect(() => encryptSecret('x', '')).toThrow('WIKIKIT_KEY_PEPPER')
  })
})

// ---------------------------------------------------------------------------
// SSRF guard

describe('isBlockedAddress', () => {
  const blocked = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'ff02::1',
    '::ffff:10.0.0.1', // IPv4-mapped bypass attempt
    'not-an-ip',
  ]
  const allowed = ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2001:4860:4860::8888']

  for (const ip of blocked) test(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true))
  for (const ip of allowed) test(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false))
})

// ---------------------------------------------------------------------------
// Endpoint registration & listing

describe('registerWebhookEndpoint', () => {
  test('stores the secret encrypted, returns plaintext exactly once', async () => {
    const config = testConfig()
    const db = createFakeDb()
    const { endpoint, secret } = await registerWebhookEndpoint(config, db as unknown as Db, SPACE_ID, {
      url: 'http://127.0.0.1:9/hook',
      events: ['wikikit.proposal.created'],
    })
    expect(secret).toMatch(/^whsec_/)
    const stored = db.tables.wk_webhook_endpoints![0]!
    expect(String(stored.secret)).not.toContain(secret)
    expect(decryptSecret(String(stored.secret), config.keyPepper)).toBe(secret)
    // The returned summary never carries the secret.
    expect(endpoint).not.toHaveProperty('secret')
    expect(endpoint.events).toEqual(['wikikit.proposal.created'])
  })

  test('rejects unknown event names, non-http(s) urls, and credentials in urls', async () => {
    const config = testConfig()
    const db = createFakeDb() as unknown as Db
    await expect(
      registerWebhookEndpoint(config, db, SPACE_ID, { url: 'http://127.0.0.1/x', events: ['nope.event'] }),
    ).rejects.toThrow('unknown webhook event type')
    await expect(registerWebhookEndpoint(config, db, SPACE_ID, { url: 'ftp://example.com/x' })).rejects.toThrow(
      'http(s)',
    )
    await expect(registerWebhookEndpoint(config, db, SPACE_ID, { url: 'https://a:b@example.com/x' })).rejects.toThrow(
      'credentials',
    )
    await expect(registerWebhookEndpoint(config, db, SPACE_ID, { url: 'not a url' })).rejects.toThrow('absolute URL')
  })

  test('production posture: http rejected, private targets rejected via DNS resolution', async () => {
    const config = testConfig({ webhookAllowPrivateTargets: false })
    const db = createFakeDb() as unknown as Db
    await expect(registerWebhookEndpoint(config, db, SPACE_ID, { url: 'http://example.com/x' })).rejects.toThrow(
      'https',
    )
    // localhost resolves to loopback without touching the network.
    await expect(registerWebhookEndpoint(config, db, SPACE_ID, { url: 'https://localhost/x' })).rejects.toThrow(
      'disallowed',
    )
  })

  test('listWebhookEndpoints is space-scoped and secret-free', async () => {
    const config = testConfig()
    const db = createFakeDb()
    seedEndpoint(db, config)
    seedEndpoint(db, config, { space_id: 'other-space' })
    const listed = await listWebhookEndpoints(db as unknown as Db, SPACE_ID)
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('secret')
    expect(listed[0]).not.toHaveProperty('space_id')
  })
})

// ---------------------------------------------------------------------------
// Outbox worker

describe('outbox worker', () => {
  test('fan-out: one delivery per matching endpoint, event marked dispatched', async () => {
    const config = testConfig()
    const db = createFakeDb()
    seedEndpoint(db, config) // subscribes to all events
    seedEndpoint(db, config, { events: ['wikikit.concept.updated'] }) // does NOT match
    seedEndpoint(db, config, { events: ['wikikit.proposal.rejected'] }) // matches
    seedEndpoint(db, config, { active: false }) // inactive → skipped
    seedEndpoint(db, config, { space_id: 'other-space' }) // wrong space → skipped
    await seedEvent(db)

    const { impl, requests } = fakeFetch([200])
    const worker = createOutboxWorker(config, db as unknown as Db, silentLogger, { fetchImpl: impl })
    await worker.tick()

    expect(db.tables.wk_webhook_deliveries).toHaveLength(2)
    expect(db.tables.wk_outbox_events![0]!.dispatched_at).not.toBeNull()
    expect(requests).toHaveLength(2)
    // Fan-out is idempotent: a second tick creates nothing new.
    await worker.tick()
    expect(db.tables.wk_webhook_deliveries).toHaveLength(2)
    expect(requests).toHaveLength(2)
  })

  test('successful delivery: Standard Webhooks headers, verifiable signature, valid envelope', async () => {
    const config = testConfig()
    const db = createFakeDb()
    seedEndpoint(db, config)
    await seedEvent(db)

    const { impl, requests } = fakeFetch([200])
    const worker = createOutboxWorker(config, db as unknown as Db, silentLogger, { fetchImpl: impl })
    await worker.tick()

    const request = requests[0]!
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.headers['webhook-id']).toBe('evt_1')
    expect(request.headers['webhook-timestamp']).toMatch(/^\d+$/)
    expect(request.headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/)
    expect(
      verifyWebhookSignature(
        'whsec_unit-test-secret',
        request.headers['webhook-id']!,
        request.headers['webhook-timestamp']!,
        request.body,
        request.headers['webhook-signature']!,
      ),
    ).toBe(true)
    const envelope = zWebhookEnvelope.parse(JSON.parse(request.body))
    expect(envelope.type).toBe('wikikit.proposal.rejected')

    const delivery = db.tables.wk_webhook_deliveries![0]!
    expect(delivery.status).toBe('delivered')
    expect(delivery.attempt).toBe(1)
    expect(delivery.response_status).toBe(200)
  })

  test('failure schedules exponential backoff with jitter; success on retry resets', async () => {
    const config = testConfig()
    const db = createFakeDb()
    seedEndpoint(db, config, { failure_count: 0 })
    await seedEvent(db)

    let clock = Date.parse('2026-07-15T12:00:00Z')
    const { impl } = fakeFetch([500, 200])
    const worker = createOutboxWorker(config, db as unknown as Db, silentLogger, {
      fetchImpl: impl,
      now: () => clock,
      random: () => 0.5, // jitter factor 0.85 + 0.5*0.3 = 1.0 exactly
    })

    await worker.tick()
    const delivery = db.tables.wk_webhook_deliveries![0]!
    expect(delivery.status).toBe('failed')
    expect(delivery.attempt).toBe(1)
    expect(delivery.last_error).toBe('endpoint returned 500')
    expect(delivery.response_status).toBe(500)
    // attempt=1 → min(2^1, 300)s * 1.0 = exactly 2s.
    expect(new Date(String(delivery.next_attempt_at)).getTime()).toBe(clock + 2000)
    expect(db.tables.wk_webhook_endpoints![0]!.failure_count).toBe(1)

    // Not due yet → untouched.
    clock += 1000
    await worker.tick()
    expect(delivery.attempt).toBe(1)

    // Due → retried and delivered; consecutive-failure count resets.
    clock += 1500
    await worker.tick()
    expect(delivery.status).toBe('delivered')
    expect(delivery.attempt).toBe(2)
    expect(db.tables.wk_webhook_endpoints![0]!.failure_count).toBe(0)
  })

  test('delivery goes dead after webhookMaxAttempts', async () => {
    const config = testConfig({ webhookMaxAttempts: 2, webhookCircuitThreshold: 99 })
    const db = createFakeDb()
    seedEndpoint(db, config)
    await seedEvent(db)

    let clock = Date.parse('2026-07-15T12:00:00Z')
    const { impl, requests } = fakeFetch([500])
    const worker = createOutboxWorker(config, db as unknown as Db, silentLogger, {
      fetchImpl: impl,
      now: () => clock,
      random: () => 0.5,
    })

    await worker.tick()
    clock += 10_000
    await worker.tick()
    const delivery = db.tables.wk_webhook_deliveries![0]!
    expect(delivery.status).toBe('dead')
    expect(delivery.attempt).toBe(2)

    // Dead deliveries are never picked up again.
    clock += 3_600_000
    await worker.tick()
    expect(requests).toHaveLength(2)
  })

  test('circuit breaker: threshold consecutive failures disable the endpoint for 15min, then recover', async () => {
    const config = testConfig({ webhookCircuitThreshold: 2, webhookMaxAttempts: 10 })
    const db = createFakeDb()
    const endpoint = seedEndpoint(db, config)
    await seedEvent(db)

    let clock = Date.parse('2026-07-15T12:00:00Z')
    const { impl, requests } = fakeFetch([500, 500, 200])
    const worker = createOutboxWorker(config, db as unknown as Db, silentLogger, {
      fetchImpl: impl,
      now: () => clock,
      random: () => 0.5,
    })

    await worker.tick() // failure 1 → count 1
    expect(endpoint.failure_count).toBe(1)
    expect(endpoint.disabled_until).toBeNull()

    clock += 10_000
    await worker.tick() // failure 2 → breaker trips
    expect(endpoint.failure_count).toBe(0) // fresh budget after the window
    expect(new Date(String(endpoint.disabled_until)).getTime()).toBe(clock + 15 * 60 * 1000)

    // While open: due delivery is deferred to disabled_until WITHOUT an attempt.
    const delivery = db.tables.wk_webhook_deliveries![0]!
    const attemptsBefore = delivery.attempt
    clock += 60_000
    await worker.tick()
    expect(delivery.attempt).toBe(attemptsBefore)
    expect(String(delivery.next_attempt_at)).toBe(String(endpoint.disabled_until))
    expect(requests).toHaveLength(2)

    // After the window closes the delivery flows again and succeeds.
    clock += 15 * 60 * 1000
    await worker.tick()
    expect(delivery.status).toBe('delivered')
  })

  test('fan-out during an open circuit schedules the delivery for when the window closes', async () => {
    const config = testConfig()
    const db = createFakeDb()
    const clock = Date.parse('2026-07-15T12:00:00Z')
    const disabledUntil = new Date(clock + 60_000).toISOString()
    seedEndpoint(db, config, { disabled_until: disabledUntil })
    await seedEvent(db)

    const { impl, requests } = fakeFetch([200])
    const worker = createOutboxWorker(config, db as unknown as Db, silentLogger, {
      fetchImpl: impl,
      now: () => clock,
    })
    await worker.tick()
    expect(db.tables.wk_webhook_deliveries).toHaveLength(1)
    expect(String(db.tables.wk_webhook_deliveries![0]!.next_attempt_at)).toBe(disabledUntil)
    expect(requests).toHaveLength(0) // not attempted inside the window
  })

  test('endpoint deactivated after fan-out → pending delivery goes dead, no request', async () => {
    const config = testConfig()
    const db = createFakeDb()
    const endpoint = seedEndpoint(db, config)
    await seedEvent(db)

    // Seed a pending delivery directly (as if fan-out already ran), then
    // deactivate the endpoint before the delivery poll picks it up.
    db.tables.wk_webhook_deliveries!.push({
      id: crypto.randomUUID(),
      endpoint_id: endpoint.id,
      event_id: db.tables.wk_outbox_events![0]!.id,
      status: 'pending',
      attempt: 0,
      next_attempt_at: new Date(0).toISOString(),
      created_at: new Date().toISOString(),
    })
    db.tables.wk_outbox_events![0]!.dispatched_at = new Date().toISOString()
    endpoint.active = false

    const { impl, requests } = fakeFetch([200])
    await createOutboxWorker(config, db as unknown as Db, silentLogger, { fetchImpl: impl }).tick()
    expect(requests).toHaveLength(0)
    expect(db.tables.wk_webhook_deliveries![0]!.status).toBe('dead')
    expect(db.tables.wk_webhook_deliveries![0]!.last_error).toBe('endpoint inactive')
  })

  test('metrics sink records delivery outcomes', async () => {
    const config = testConfig({ webhookMaxAttempts: 1 })
    const db = createFakeDb()
    seedEndpoint(db, config)
    await seedEvent(db)
    const outcomes: string[] = []
    const { impl } = fakeFetch([500])
    const worker = createOutboxWorker(config, db as unknown as Db, silentLogger, {
      fetchImpl: impl,
      metrics: { webhookDelivery: (status) => void outcomes.push(status) },
    })
    await worker.tick()
    expect(outcomes).toEqual(['dead']) // maxAttempts=1 → first failure is terminal
  })

  test('start/stop: immediate tick on start, no timers left after stop', async () => {
    const config = testConfig({ webhookPollMs: 3_600_000 })
    const db = createFakeDb()
    seedEndpoint(db, config)
    await seedEvent(db)
    const { impl, requests } = fakeFetch([200])
    const worker = createOutboxWorker(config, db as unknown as Db, silentLogger, { fetchImpl: impl })
    worker.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    worker.stop()
    expect(requests).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Delivery listing

describe('listWebhookDeliveries', () => {
  test('joins event_type, newest first, and enforces space ownership', async () => {
    const config = testConfig()
    const db = createFakeDb()
    const endpoint = seedEndpoint(db, config)
    await seedEvent(db)
    const { impl } = fakeFetch([200])
    await createOutboxWorker(config, db as unknown as Db, silentLogger, { fetchImpl: impl }).tick()

    const deliveries = await listWebhookDeliveries(db as unknown as Db, SPACE_ID, {
      endpointId: String(endpoint.id),
    })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.event_type).toBe('wikikit.proposal.rejected')
    expect(deliveries[0]!.status).toBe('delivered')

    await expect(
      listWebhookDeliveries(db as unknown as Db, 'other-space', { endpointId: String(endpoint.id) }),
    ).rejects.toThrow('not found')
  })
})
