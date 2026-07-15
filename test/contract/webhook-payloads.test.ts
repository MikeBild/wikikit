// Webhook wire contract (CONTRACTS §6, plan §14.2): the Standard Webhooks
// envelope (headers + signature scheme) and every event payload schema,
// snapshotted. External systems (SubKit workflows, n8n, any HTTP consumer)
// build against exactly these shapes — a diff in the snapshot file is a
// visible, deliberate API change that requires a snapshot commit.
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import { createLogger } from '../../src/logger.ts'
import { encryptSecret } from '../../src/secrets.ts'
import {
  WEBHOOK_EVENT_TYPES,
  createOutboxWorker,
  signWebhook,
  verifyWebhookSignature,
  zWebhookEnvelope,
  zWebhookPayloads,
} from '../../src/webhooks.ts'

// ---------------------------------------------------------------------------
// 1. Schema snapshots — JSON Schema derived from the zod payload contracts.

describe('webhook payload schema snapshots', () => {
  test('event type list is frozen', () => {
    expect([...WEBHOOK_EVENT_TYPES]).toMatchSnapshot()
  })

  test('envelope schema', () => {
    expect(z.toJSONSchema(zWebhookEnvelope)).toMatchSnapshot()
  })

  for (const eventType of WEBHOOK_EVENT_TYPES) {
    test(`data schema: ${eventType}`, () => {
      expect(z.toJSONSchema(zWebhookPayloads[eventType])).toMatchSnapshot()
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Representative payloads validate against their schema (and stay valid —
//    they double as documentation of a real payload per event).

const PROPOSAL_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const SOURCE_ID = 'bbbbbbbb-2222-4222-8222-222222222222'
const INGEST_ID = 'cccccccc-3333-4333-8333-333333333333'

const EXAMPLE_PAYLOADS: Record<(typeof WEBHOOK_EVENT_TYPES)[number], Record<string, unknown>> = {
  'wikikit.proposal.created': {
    proposal_id: PROPOSAL_ID,
    space: 'demo',
    title: 'Ingest: OKF announcement',
    source_ids: [SOURCE_ID],
    concepts: ['open-knowledge-format'],
    claims_count: 7,
    contradictions_count: 1,
  },
  'wikikit.proposal.approved': {
    proposal_id: PROPOSAL_ID,
    space: 'demo',
    reviewer: 'mike',
    note: 'source is newer',
    concepts: ['open-knowledge-format'],
  },
  'wikikit.proposal.rejected': {
    proposal_id: PROPOSAL_ID,
    space: 'demo',
    reviewer: 'mike',
    note: null,
  },
  'wikikit.concept.updated': {
    space: 'demo',
    slug: 'open-knowledge-format',
    rev: 3,
    proposal_id: PROPOSAL_ID,
  },
  'wikikit.ingest.failed': {
    ingest_id: INGEST_ID,
    space: 'demo',
    error: { code: 'already_ingested', message: 'content hash already archived' },
  },
}

describe('example payloads conform', () => {
  for (const eventType of WEBHOOK_EVENT_TYPES) {
    test(eventType, () => {
      expect(() => zWebhookPayloads[eventType].parse(EXAMPLE_PAYLOADS[eventType])).not.toThrow()
      expect(() =>
        zWebhookEnvelope.parse({
          type: eventType,
          timestamp: '2026-07-15T12:00:00.000Z',
          data: EXAMPLE_PAYLOADS[eventType],
        }),
      ).not.toThrow()
    })
  }

  test('envelope rejects unknown event types and cross-wired data', () => {
    expect(() =>
      zWebhookEnvelope.parse({ type: 'wikikit.unknown', timestamp: '2026-07-15T12:00:00.000Z', data: {} }),
    ).toThrow()
    expect(() =>
      zWebhookEnvelope.parse({
        type: 'wikikit.concept.updated',
        timestamp: '2026-07-15T12:00:00.000Z',
        data: EXAMPLE_PAYLOADS['wikikit.proposal.rejected'], // wrong data for the type
      }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2b. SQL-built payload drift check: wk_apply_proposal / wk_reject_proposal
//     construct their outbox payloads with jsonb_build_object INSIDE the
//     migration, out of reach of the zod schemas above. Extract the key lists
//     from the SQL text and pin them to the schema shapes, so a renamed key
//     in the migration (e.g. in proposal.approved) fails HERE instead of
//     shipping a silently-drifted wire payload.

const MIGRATION_SQL = readFileSync(new URL('../../src/db/migrations/0000_wk_baseline.sql', import.meta.url), 'utf8')

/** Keys of the FIRST jsonb_build_object following the event-type literal. */
function sqlPayloadKeys(eventType: string): string[] {
  const at = MIGRATION_SQL.indexOf(`'${eventType}',`)
  if (at < 0) throw new Error(`migration builds no payload for ${eventType}`)
  const start = MIGRATION_SQL.indexOf('jsonb_build_object(', at)
  if (start < 0) throw new Error(`no jsonb_build_object after ${eventType}`)
  let depth = 0
  let end = -1
  for (let i = MIGRATION_SQL.indexOf('(', start); i < MIGRATION_SQL.length; i++) {
    if (MIGRATION_SQL[i] === '(') depth += 1
    else if (MIGRATION_SQL[i] === ')') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new Error(`unbalanced jsonb_build_object after ${eventType}`)
  // Keys are the quoted-identifier-comma pairs; values are columns/params and
  // never match this pattern.
  return [...MIGRATION_SQL.slice(start, end).matchAll(/'([a-z_]+)'\s*,/g)].map((match) => match[1]!).sort()
}

describe('SQL-built outbox payloads match the zod contracts (key drift check)', () => {
  const SQL_BUILT_EVENTS = [
    'wikikit.proposal.approved',
    'wikikit.proposal.rejected',
    'wikikit.concept.updated',
  ] as const

  for (const eventType of SQL_BUILT_EVENTS) {
    test(eventType, () => {
      const schema = zWebhookPayloads[eventType] as z.ZodObject<z.ZodRawShape>
      expect(sqlPayloadKeys(eventType)).toEqual(Object.keys(schema.shape).sort())
    })
  }
})

// ---------------------------------------------------------------------------
// 3. Signature scheme — pinned known-answer vector. If this snapshot changes,
//    every consumer's verification code breaks.

describe('signature contract', () => {
  const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
  const ID = 'evt_42'
  const TIMESTAMP = '1700000000'
  const BODY = '{"type":"wikikit.proposal.created","timestamp":"2026-07-15T12:00:00.000Z","data":{}}'

  test('v1,<base64(hmacSHA256(secret, id.timestamp.body))> known-answer vector', () => {
    const signature = signWebhook(SECRET, ID, TIMESTAMP, BODY)
    expect(signature).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/)
    // Independent recomputation (not via signWebhook) pins the exact scheme.
    const independent = `v1,${createHmac('sha256', SECRET).update(`${ID}.${TIMESTAMP}.${BODY}`).digest('base64')}`
    expect(signature).toBe(independent)
    expect(signature).toMatchSnapshot()
    expect(verifyWebhookSignature(SECRET, ID, TIMESTAMP, BODY, signature)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Live wire check — a real delivery produced by the outbox worker carries
//    exactly the contracted headers and a schema-valid, signature-valid body.

describe('delivery wire contract', () => {
  test('worker POST: headers, envelope, signature', async () => {
    const SPACE_ID = 'dddddddd-4444-4444-8444-444444444444'
    const SECRET = 'whsec_contract-test-secret'
    const config = {
      keyPepper: 'contract-pepper',
      webhookPollMs: 60_000,
      webhookTimeoutMs: 5_000,
      webhookMaxAttempts: 3,
      webhookCircuitThreshold: 5,
      webhookAllowPrivateTargets: true,
    } as Config

    // Purpose-built stub Db: one endpoint, one undispatched event.
    const endpoint = {
      id: 'eeeeeeee-5555-4555-8555-555555555555',
      space_id: SPACE_ID,
      url: 'http://127.0.0.1:9/hook',
      secret: encryptSecret(SECRET, config.keyPepper),
      events: [],
      active: true,
      failure_count: 0,
      disabled_until: null,
    }
    const event = {
      id: 7,
      space_id: SPACE_ID,
      event_type: 'wikikit.proposal.created',
      payload: EXAMPLE_PAYLOADS['wikikit.proposal.created'],
      dispatched_at: null as string | null,
    }
    const deliveries: Record<string, unknown>[] = []
    const stubDb = {
      async select(table: string, query: Record<string, unknown> = {}) {
        if (table === 'wk_outbox_events') {
          if (query.dispatched_at === 'is.null') return event.dispatched_at === null ? [{ ...event }] : []
          return [{ ...event }]
        }
        if (table === 'wk_webhook_endpoints') return [{ ...endpoint }]
        if (table === 'wk_webhook_deliveries') {
          return deliveries.filter((d) => d.status === 'pending').map((d) => ({ ...d }))
        }
        return []
      },
      async insert(_table: string, body: Record<string, unknown> | Record<string, unknown>[]) {
        for (const row of Array.isArray(body) ? body : [body]) deliveries.push({ id: 'del-1', attempt: 0, ...row })
        return []
      },
      async update(table: string, _filters: Record<string, unknown>, patch: Record<string, unknown>) {
        if (table === 'wk_outbox_events') Object.assign(event, patch)
        if (table === 'wk_webhook_deliveries') Object.assign(deliveries[0]!, patch)
        if (table === 'wk_webhook_endpoints') Object.assign(endpoint, patch)
        return []
      },
      async tx<T>(fn: (tx: Db) => Promise<T>) {
        return fn(stubDb as unknown as Db)
      },
    } as unknown as Db

    const captured: { headers: Record<string, string>; body: string }[] = []
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured.push({
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: String(init?.body ?? ''),
      })
      return new Response('ok', { status: 200 })
    }) as typeof fetch

    const worker = createOutboxWorker(config, stubDb, createLogger({ level: 'error', write: () => {} }), {
      fetchImpl,
    })
    await worker.tick()

    expect(captured).toHaveLength(1)
    const { headers, body } = captured[0]!

    // Contracted header set (CONTRACTS §6.2) — snapshot the names.
    expect(Object.keys(headers).sort()).toMatchSnapshot()
    expect(headers['content-type']).toBe('application/json')
    expect(headers['webhook-id']).toBe('evt_7') // outbox id, evt_-prefixed
    expect(headers['webhook-timestamp']).toMatch(/^\d{10}$/) // unix seconds
    expect(headers['webhook-signature']!.startsWith('v1,')).toBe(true)

    // Body is a schema-valid envelope carrying the event payload verbatim.
    const envelope = zWebhookEnvelope.parse(JSON.parse(body))
    expect(envelope.type).toBe('wikikit.proposal.created')
    expect(envelope.data).toEqual(EXAMPLE_PAYLOADS['wikikit.proposal.created'] as never)

    // Signature verifies with the plaintext whsec_ secret over id.timestamp.body.
    expect(
      verifyWebhookSignature(
        SECRET,
        headers['webhook-id']!,
        headers['webhook-timestamp']!,
        body,
        headers['webhook-signature']!,
      ),
    ).toBe(true)

    expect(deliveries[0]!.status).toBe('delivered')
    expect(event.dispatched_at).not.toBeNull()
  })
})
