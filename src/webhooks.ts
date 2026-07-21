// Standard Webhooks delivery — a transactional-outbox delivery worker over
// the wk_ schema (CONTRACTS §1.11, §6).
//
// Architecture (transactional outbox):
//   1. Business writes emit rows into wk_outbox_events INSIDE their own
//      transaction (db.emitEvent / the SQL review functions) — an event exists
//      iff the state change committed.
//   2. This worker polls undispatched events and FANS OUT one
//      wk_webhook_deliveries row per matching active endpoint, then stamps
//      dispatched_at (one atomic tx per event).
//   3. A second poll picks up due deliveries and POSTs the Standard Webhooks
//      envelope: headers webhook-id / webhook-timestamp / webhook-signature
//      with `v1,<base64 HMAC-SHA256 of "id.timestamp.body")>`.
//   4. Failures back off exponentially (min(2^attempt, 300)s ± 15% jitter,
//      CONTRACTS §6.3) up to webhookMaxAttempts, then the delivery is 'dead'.
//      A per-endpoint circuit breaker counts consecutive failures and
//      auto-disables the endpoint for 15 minutes once it crosses
//      webhookCircuitThreshold — a dead URL stops burning retries, and
//      recovers without operator action (disabled_until, not disabled_at).
//
// WHY polling instead of LISTEN/NOTIFY: at WikiKit's event volume a poll
// every webhookPollMs is indistinguishable from push, needs no extra
// connection state, and survives Postgres failovers without resubscription
// logic. The delivery latency floor equals the poll interval — acceptable for
// review-gate notifications.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Config } from './config.ts'
import type { Db, WebhookEventType } from './db/postgres.ts'
import type { Logger } from './logger.ts'
import type { Metrics } from './metrics.ts'
import { NotFoundError, ValidationError } from './domain/errors.ts'
import { REVIEW_CHANNELS } from './domain/proposals.ts'
import { assertDeliverableUrl, decryptSecret, encryptSecret, generateWebhookSecret } from './secrets.ts'

// ---------------------------------------------------------------------------
// Event payload schemas (CONTRACTS §6.3) — the wire contract consumers
// (workflow engines, n8n, anything) build against. The contract test
// snapshots the derived JSON Schemas: changing a payload requires a visible
// snapshot commit.

export const WEBHOOK_EVENT_TYPES = [
  'wikikit.proposal.created',
  'wikikit.proposal.approved',
  'wikikit.proposal.rejected',
  'wikikit.concept.updated',
  'wikikit.ingest.failed',
] as const satisfies readonly WebhookEventType[]

export const zProposalCreatedData = z.object({
  proposal_id: z.uuid(),
  space: z.string(),
  title: z.string(),
  source_ids: z.array(z.uuid()),
  concepts: z.array(z.string()),
  claims_count: z.number().int(),
  contradictions_count: z.number().int(),
})

export const zProposalApprovedData = z.object({
  proposal_id: z.uuid(),
  space: z.string(),
  reviewer: z.string(),
  note: z.string().nullable(),
  review_channel: z.enum(REVIEW_CHANNELS),
  concepts: z.array(z.string()),
})

export const zProposalRejectedData = z.object({
  proposal_id: z.uuid(),
  space: z.string(),
  reviewer: z.string(),
  note: z.string().nullable(),
  review_channel: z.enum(REVIEW_CHANNELS),
})

export const zConceptUpdatedData = z.object({
  space: z.string(),
  slug: z.string(),
  rev: z.number().int(),
  proposal_id: z.uuid(),
})

export const zIngestFailedData = z.object({
  ingest_id: z.uuid(),
  space: z.string(),
  error: z.object({ code: z.string(), message: z.string() }),
})

/** Per-event `data` schema — keyed by the exact wire event name. */
export const zWebhookPayloads = {
  'wikikit.proposal.created': zProposalCreatedData,
  'wikikit.proposal.approved': zProposalApprovedData,
  'wikikit.proposal.rejected': zProposalRejectedData,
  'wikikit.concept.updated': zConceptUpdatedData,
  'wikikit.ingest.failed': zIngestFailedData,
} as const satisfies Record<WebhookEventType, z.ZodType>

/** The full POST body: `{ type, timestamp (ISO 8601), data }`, discriminated on `type`. */
export const zWebhookEnvelope = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wikikit.proposal.created'), timestamp: z.iso.datetime(), data: zProposalCreatedData }),
  z.object({ type: z.literal('wikikit.proposal.approved'), timestamp: z.iso.datetime(), data: zProposalApprovedData }),
  z.object({ type: z.literal('wikikit.proposal.rejected'), timestamp: z.iso.datetime(), data: zProposalRejectedData }),
  z.object({ type: z.literal('wikikit.concept.updated'), timestamp: z.iso.datetime(), data: zConceptUpdatedData }),
  z.object({ type: z.literal('wikikit.ingest.failed'), timestamp: z.iso.datetime(), data: zIngestFailedData }),
])
export type WebhookEnvelope = z.infer<typeof zWebhookEnvelope>

// ---------------------------------------------------------------------------
// Signature (Standard Webhooks): v1,<base64(hmacSHA256(secret, `${id}.${timestamp}.${body}`))>
// The HMAC key is the stored whsec_-style secret string as-is (CONTRACTS §6.2
// formula — the canonical Standard Webhooks scheme, so any compliant verifier
// works).

export function signWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64')
  return `v1,${digest}`
}

/**
 * Verifies a webhook-signature header value. The header may carry multiple
 * space-separated signatures (Standard Webhooks secret-rotation form); any
 * matching v1 signature passes. Constant-time comparison — a verifier should
 * never leak how much of the signature matched.
 */
export function verifyWebhookSignature(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
  signatureHeader: string,
): boolean {
  const expected = Buffer.from(signWebhook(secret, id, timestamp, body))
  return String(signatureHeader)
    .split(' ')
    .filter(Boolean)
    .some((candidate) => {
      const buffer = Buffer.from(candidate)
      return buffer.length === expected.length && timingSafeEqual(buffer, expected)
    })
}

// ---------------------------------------------------------------------------
// Endpoint management — used by the admin HTTP handlers. Lives here (not in
// the HTTP layer) so all secret-encryption knowledge stays in one module:
// nothing outside webhooks.ts + secrets.ts ever sees a webhook secret.

/** Endpoint row WITHOUT the secret — the only shape that ever leaves this module after creation. */
export interface WebhookEndpointSummary {
  id: string
  url: string
  events: string[]
  active: boolean
  failure_count: number
  disabled_until: string | null
  created_at: string
}

interface EndpointRow {
  id: string
  space_id: string
  url: string
  secret: string
  events: string[]
  active: boolean
  failure_count: number
  disabled_until: string | Date | null
  created_at: string | Date
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function summarize(row: EndpointRow): WebhookEndpointSummary {
  return {
    id: row.id,
    url: row.url,
    events: row.events ?? [],
    active: row.active,
    failure_count: Number(row.failure_count ?? 0),
    disabled_until: toIso(row.disabled_until),
    created_at: toIso(row.created_at)!,
  }
}

/**
 * Creates a per-space endpoint. The plaintext whsec_ secret is returned
 * EXACTLY ONCE here; at rest only the AES-256-GCM ciphertext is stored
 * (wk_webhook_endpoints.secret). URL is SSRF-validated up front — a private
 * or unresolvable target is rejected at registration, not at delivery time.
 */
export async function registerWebhookEndpoint(
  config: Config,
  db: Db,
  spaceId: string,
  args: { url: string; events?: string[] },
): Promise<{ endpoint: WebhookEndpointSummary; secret: string }> {
  const events = args.events ?? []
  const unknown = events.filter((event) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(event))
  if (unknown.length) throw new ValidationError(`unknown webhook event type(s): ${unknown.join(', ')}`)
  const url = await assertDeliverableUrl(args.url, { allowInsecure: config.webhookAllowPrivateTargets })
  const secret = generateWebhookSecret()
  const [row] = await db.insert<EndpointRow>('wk_webhook_endpoints', {
    space_id: spaceId,
    url,
    secret: encryptSecret(secret, config.keyPepper),
    events,
  })
  return { endpoint: summarize(row!), secret }
}

export async function listWebhookEndpoints(db: Db, spaceId: string): Promise<WebhookEndpointSummary[]> {
  const rows = await db.select<EndpointRow>('wk_webhook_endpoints', {
    space_id: `eq.${spaceId}`,
    order: 'created_at.asc',
  })
  return rows.map(summarize)
}

export interface WebhookDeliverySummary {
  id: string
  event_id: string
  event_type: string
  status: string
  attempt: number
  next_attempt_at: string | null
  response_status: number | null
  last_error: string | null
  created_at: string
}

/** Deliveries for one endpoint — space ownership is verified first (space-scoped keys must not enumerate foreign deliveries). */
export async function listWebhookDeliveries(
  db: Db,
  spaceId: string,
  args: { endpointId: string; limit?: number },
): Promise<WebhookDeliverySummary[]> {
  const [endpoint] = await db.select<EndpointRow>('wk_webhook_endpoints', {
    id: `eq.${args.endpointId}`,
    space_id: `eq.${spaceId}`,
    limit: 1,
  })
  if (!endpoint) throw new NotFoundError('webhook endpoint not found')
  const rows = await db.query<{
    id: string
    event_id: string | number
    event_type: string
    status: string
    attempt: number
    next_attempt_at: string | Date | null
    response_status: number | null
    last_error: string | null
    created_at: string | Date
  }>(
    `SELECT d.id, d.event_id, e.event_type, d.status, d.attempt, d.next_attempt_at,
            d.response_status, d.last_error, d.created_at
       FROM wk_webhook_deliveries d
       JOIN wk_outbox_events e ON e.id = d.event_id
      WHERE d.endpoint_id = $1
      ORDER BY d.created_at DESC
      LIMIT $2`,
    [args.endpointId, Math.min(Math.max(args.limit ?? 50, 1), 200)],
  )
  return rows.rows.map((row) => ({
    id: row.id,
    event_id: String(row.event_id),
    event_type: row.event_type,
    status: row.status,
    attempt: Number(row.attempt),
    next_attempt_at: toIso(row.next_attempt_at),
    response_status: row.response_status,
    last_error: row.last_error,
    created_at: toIso(row.created_at)!,
  }))
}

// ---------------------------------------------------------------------------
// Delivery worker

export interface OutboxWorker {
  start(): void
  stop(): void
  /** One poll cycle (fan-out + due deliveries). Exposed for tests and graceful drain. */
  tick(): Promise<void>
}

export interface OutboxWorkerDeps {
  /** Injected fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Optional metrics sink (webhookDelivery outcomes). */
  metrics?: Pick<Metrics, 'webhookDelivery'>
  /** Clock for deterministic backoff tests; defaults to Date.now. */
  now?: () => number
  /** RNG for deterministic jitter tests; defaults to Math.random. */
  random?: () => number
}

interface OutboxEventRow {
  id: string | number
  space_id: string
  event_type: WebhookEventType
  payload: Record<string, unknown>
  created_at: string | Date
  dispatched_at: string | Date | null
}

interface DeliveryRow {
  id: string
  endpoint_id: string
  event_id: string | number
  status: string
  attempt: number
  next_attempt_at: string | Date
}

const CIRCUIT_DISABLE_MS = 15 * 60 * 1000 // CONTRACTS §6.3: disabled_until = now() + 15min

export function createOutboxWorker(config: Config, db: Db, logger: Logger, deps: OutboxWorkerDeps = {}): OutboxWorker {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  // min(2^attempt, 300)s ± 15% jitter (CONTRACTS §6.3). The jitter keeps a
  // fleet of due deliveries from retrying in lockstep against a recovering
  // endpoint. Exponent is clamped so 2**attempt never overflows before min().
  function backoffSeconds(attempt: number): number {
    const base = Math.min(2 ** Math.min(attempt, 9), 300)
    return base * (0.85 + random() * 0.3)
  }

  // Fan-out: one delivery row per matching endpoint, then dispatched_at — in
  // ONE transaction so a crash can never half-dispatch an event (either it is
  // picked up again in full, or all deliveries exist).
  async function fanOutPending(): Promise<void> {
    const events = await db.select<OutboxEventRow>('wk_outbox_events', {
      dispatched_at: 'is.null',
      order: 'id.asc',
      limit: 50,
    })
    for (const event of events) {
      const endpoints = await db.select<EndpointRow>('wk_webhook_endpoints', {
        space_id: `eq.${event.space_id}`,
        active: 'eq.true',
      })
      const matching = endpoints.filter(
        (endpoint) => !endpoint.events?.length || endpoint.events.includes(event.event_type),
      )
      const nowIso = new Date(now()).toISOString()
      const rows = matching.map((endpoint) => {
        // Endpoints inside a circuit-breaker window still get their delivery
        // row — scheduled for when the window closes, so no event is lost.
        const disabledUntil = endpoint.disabled_until ? new Date(endpoint.disabled_until).getTime() : 0
        return {
          endpoint_id: endpoint.id,
          event_id: event.id,
          status: 'pending',
          next_attempt_at: disabledUntil > now() ? new Date(disabledUntil).toISOString() : nowIso,
        }
      })
      await db.tx(async (tx) => {
        if (rows.length) await tx.insert('wk_webhook_deliveries', rows, { returning: false })
        await tx.update('wk_outbox_events', { id: `eq.${event.id}` }, { dispatched_at: nowIso }, { returning: false })
      })
    }
  }

  async function markDead(delivery: DeliveryRow, reason: string): Promise<void> {
    await db.update(
      'wk_webhook_deliveries',
      { id: `eq.${delivery.id}` },
      { status: 'dead', last_error: reason },
      { returning: false },
    )
    deps.metrics?.webhookDelivery('dead')
  }

  async function deliver(delivery: DeliveryRow): Promise<void> {
    const [endpoint] = await db.select<EndpointRow>('wk_webhook_endpoints', {
      id: `eq.${delivery.endpoint_id}`,
      limit: 1,
    })
    // Missing/deactivated endpoints are terminal, not retryable: an admin
    // switched them off on purpose, so retrying would only defer the noise.
    if (!endpoint) return markDead(delivery, 'endpoint no longer exists')
    if (!endpoint.active) return markDead(delivery, 'endpoint inactive')
    const disabledUntil = endpoint.disabled_until ? new Date(endpoint.disabled_until).getTime() : 0
    if (disabledUntil > now()) {
      // Circuit open — defer WITHOUT burning an attempt; the endpoint being
      // down is already accounted for by the breaker, not this delivery.
      await db.update(
        'wk_webhook_deliveries',
        { id: `eq.${delivery.id}` },
        { next_attempt_at: new Date(disabledUntil).toISOString() },
        { returning: false },
      )
      return
    }
    const [event] = await db.select<OutboxEventRow>('wk_outbox_events', { id: `eq.${delivery.event_id}`, limit: 1 })
    if (!event) return markDead(delivery, 'outbox event no longer exists')

    try {
      // Re-validate against SSRF at send time (not only at registration):
      // DNS can be re-pointed at a private address after the URL was
      // approved. NOTE this NARROWS the rebinding window, it does not close
      // it — the fetch below performs its own independent DNS resolution, so
      // a 0-TTL host can still answer public for this check and private for
      // the dial (TOCTOU). Closing it would require pinning the connection to
      // the vetted IP via a custom dispatcher, which Bun's fetch does not
      // expose; the residual risk is documented on assertDeliverableUrl.
      if (!config.webhookAllowPrivateTargets) await assertDeliverableUrl(endpoint.url, { allowInsecure: false })

      const secret = decryptSecret(endpoint.secret, config.keyPepper)
      const webhookId = `evt_${event.id}`
      const timestamp = String(Math.floor(now() / 1000))
      const envelope: Record<string, unknown> = {
        type: event.event_type,
        timestamp: new Date(now()).toISOString(),
        data: event.payload,
      }
      const body = JSON.stringify(envelope)

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), config.webhookTimeoutMs)
      let response: Response
      try {
        response = await fetchImpl(endpoint.url, {
          method: 'POST',
          // Redirects are NOT followed: a 3xx to an internal address would
          // bypass the SSRF check above, so any redirect counts as a failure.
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'webhook-id': webhookId,
            'webhook-timestamp': timestamp,
            'webhook-signature': signWebhook(secret, webhookId, timestamp, body),
          },
          body,
        })
      } finally {
        clearTimeout(timeout)
      }
      if (!response.ok) {
        throw Object.assign(new Error(`endpoint returned ${response.status}`), { responseStatus: response.status })
      }

      await db.update(
        'wk_webhook_deliveries',
        { id: `eq.${delivery.id}` },
        {
          status: 'delivered',
          attempt: Number(delivery.attempt ?? 0) + 1,
          response_status: response.status,
          last_error: null,
        },
        { returning: false },
      )
      deps.metrics?.webhookDelivery('delivered')
      // A success closes the breaker: failure_count is CONSECUTIVE failures.
      if (Number(endpoint.failure_count ?? 0) > 0) {
        await db
          .update('wk_webhook_endpoints', { id: `eq.${endpoint.id}` }, { failure_count: 0 }, { returning: false })
          .catch(() => {})
      }
    } catch (error) {
      await onFailure(delivery, endpoint, error as Error & { responseStatus?: number })
    }
  }

  async function onFailure(
    delivery: DeliveryRow,
    endpoint: EndpointRow,
    error: Error & { responseStatus?: number },
  ): Promise<void> {
    const attempt = Number(delivery.attempt ?? 0) + 1
    const terminal = attempt >= config.webhookMaxAttempts
    await db
      .update(
        'wk_webhook_deliveries',
        { id: `eq.${delivery.id}` },
        {
          attempt,
          last_error: String(error.message || error).slice(0, 500),
          response_status: error.responseStatus ?? null,
          status: terminal ? 'dead' : 'failed',
          next_attempt_at: new Date(now() + backoffSeconds(attempt) * 1000).toISOString(),
        },
        { returning: false },
      )
      .catch(() => {})
    deps.metrics?.webhookDelivery(terminal ? 'dead' : 'failed')

    // Circuit breaker: EVERY failed attempt counts (not only dead deliveries)
    // so a hard-down endpoint trips after webhookCircuitThreshold attempts
    // instead of webhookCircuitThreshold * webhookMaxAttempts. The count is
    // reset when the breaker trips, giving the endpoint a fresh budget after
    // the 15-minute window instead of instantly re-tripping on one failure.
    const failures = Number(endpoint.failure_count ?? 0) + 1
    const tripped = failures >= config.webhookCircuitThreshold
    const patch: Record<string, unknown> = tripped
      ? { failure_count: 0, disabled_until: new Date(now() + CIRCUIT_DISABLE_MS).toISOString() }
      : { failure_count: failures }
    await db.update('wk_webhook_endpoints', { id: `eq.${endpoint.id}` }, patch, { returning: false }).catch(() => {})
    if (tripped) {
      logger.warn('webhook endpoint circuit opened', {
        endpoint_id: endpoint.id,
        disabled_until: patch.disabled_until,
      })
    }
    logger.warn('webhook delivery failed', {
      delivery_id: delivery.id,
      endpoint_id: endpoint.id,
      attempt,
      terminal,
      error: String(error.message || error),
    })
  }

  async function deliverDue(): Promise<void> {
    // 'delivering' is deliberately NOT used as a claim marker: this worker is
    // single-instance per process with a re-entrancy guard, and a crash while
    // rows sit in 'delivering' would strand them forever (the due index only
    // covers pending|failed). pending → delivered|failed|dead is crash-safe.
    const due = await db.select<DeliveryRow>('wk_webhook_deliveries', {
      status: 'in.(pending,failed)',
      next_attempt_at: `lte.${new Date(now()).toISOString()}`,
      order: 'next_attempt_at.asc',
      limit: 20,
    })
    for (const delivery of due) {
      await deliver(delivery)
    }
  }

  async function tick(): Promise<void> {
    if (running) return // re-entrancy guard: a slow endpoint must not stack ticks
    running = true
    try {
      await fanOutPending()
      await deliverDue()
    } catch (error) {
      logger.error('webhook worker tick failed', { error: String((error as Error).message || error) })
    } finally {
      running = false
    }
  }

  return {
    start() {
      timer = setInterval(() => void tick(), config.webhookPollMs)
      // unref: the poll loop must never keep the process alive during shutdown.
      timer.unref?.()
      void tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    tick,
  }
}
