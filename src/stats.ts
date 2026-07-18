// Product analytics over WikiKit's own PostgreSQL data. These queries are
// deliberately space-scoped and expose bounded aggregates only: no source
// content, prompts, API-key identities, webhook URLs, hashes or row ids.
//
// The API is independent of any particular reporting consumer. SubKit can
// collect it with an ordinary HTTP connector, while other clients can use the
// same resources with an existing knowledge:read credential.
import type { Db } from './db/postgres.ts'
import { ValidationError } from './domain/errors.ts'

export const STATS_BUCKETS = ['hour', 'day', 'month', 'year'] as const
export type StatsBucket = (typeof STATS_BUCKETS)[number]

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const WINDOW_CAP_MS: Record<StatsBucket, number> = {
  hour: 31 * DAY,
  day: 366 * DAY,
  month: 5 * 366 * DAY,
  year: 10 * 366 * DAY,
}

export interface StatsWindow {
  bucket: StatsBucket
  from: Date
  to: Date
  tz: 'UTC'
}

export function resolveStatsWindow(input: Record<string, unknown>, now: Date = new Date()): StatsWindow {
  const bucket = String(input.bucket ?? 'hour') as StatsBucket
  if (!STATS_BUCKETS.includes(bucket)) {
    throw new ValidationError(`bucket must be one of ${STATS_BUCKETS.join(', ')}`)
  }
  const tz = String(input.tz ?? 'UTC')
  if (tz !== 'UTC') throw new ValidationError("tz currently supports only 'UTC'")
  const to = input.to ? new Date(String(input.to)) : now
  const from = input.from ? new Date(String(input.from)) : new Date(to.getTime() - 24 * HOUR)
  if (!Number.isFinite(from.getTime())) throw new ValidationError("'from' must be an RFC 3339 timestamp")
  if (!Number.isFinite(to.getTime())) throw new ValidationError("'to' must be an RFC 3339 timestamp")
  if (to <= from) throw new ValidationError("'to' must be after 'from'")
  if (to.getTime() - from.getTime() > WINDOW_CAP_MS[bucket]) {
    throw new ValidationError(`${bucket} bucket window is too large`)
  }
  return { bucket, from, to, tz: 'UTC' }
}

function floorBucket(date: Date, bucket: StatsBucket): Date {
  const value = new Date(date)
  value.setUTCMinutes(0, 0, 0)
  if (bucket !== 'hour') value.setUTCHours(0)
  if (bucket === 'month' || bucket === 'year') value.setUTCDate(1)
  if (bucket === 'year') value.setUTCMonth(0)
  return value
}

function nextBucket(date: Date, bucket: StatsBucket): Date {
  const value = new Date(date)
  if (bucket === 'hour') value.setUTCHours(value.getUTCHours() + 1)
  else if (bucket === 'day') value.setUTCDate(value.getUTCDate() + 1)
  else if (bucket === 'month') value.setUTCMonth(value.getUTCMonth() + 1)
  else value.setUTCFullYear(value.getUTCFullYear() + 1)
  return value
}

function bucketKeys(window: StatsWindow): string[] {
  const keys: string[] = []
  for (
    let cursor = floorBucket(window.from, window.bucket);
    cursor < window.to;
    cursor = nextBucket(cursor, window.bucket)
  ) {
    keys.push(cursor.toISOString())
  }
  return keys
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function envelope<TBucket, TTotals>(window: StatsWindow, buckets: TBucket[], totals: TTotals) {
  return {
    bucket: window.bucket,
    tz: window.tz,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    buckets,
    totals,
  }
}

const ZERO_INGEST = () => ({
  jobs: { created: 0, started: 0, done: 0, failed: 0 },
  duration_seconds: { total: 0, count: 0, avg: 0, max: 0 },
})

interface IngestRow {
  ts: Date | string
  event: 'created' | 'started' | 'done' | 'failed'
  value: unknown
  duration_total: unknown
  duration_count: unknown
  duration_avg: unknown
  duration_max: unknown
}

export async function getIngestStats(db: Db, spaceId: string, window: StatsWindow) {
  const { rows } = await db.query<IngestRow>(
    `SELECT date_trunc($4, occurred_at) AS ts, event,
            count(*)::integer AS value,
            coalesce(sum(duration_seconds), 0)::double precision AS duration_total,
            count(duration_seconds)::integer AS duration_count,
            coalesce(avg(duration_seconds), 0)::double precision AS duration_avg,
            coalesce(max(duration_seconds), 0)::double precision AS duration_max
       FROM (
         SELECT created_at AS occurred_at, 'created' AS event, NULL::double precision AS duration_seconds
           FROM wk_ingest_jobs WHERE space_id = $1
         UNION ALL SELECT started_at, 'started', NULL::double precision
           FROM wk_ingest_jobs WHERE space_id = $1 AND started_at IS NOT NULL
         UNION ALL SELECT finished_at, status, extract(epoch FROM finished_at - started_at)
           FROM wk_ingest_jobs
          WHERE space_id = $1 AND status IN ('done', 'failed') AND finished_at IS NOT NULL
       ) events
      WHERE occurred_at >= $2 AND occurred_at < $3
      GROUP BY 1, event ORDER BY 1, event`,
    [spaceId, window.from, window.to, window.bucket],
  )
  const byTs = new Map<string, ReturnType<typeof ZERO_INGEST>>()
  for (const row of rows) {
    const ts = iso(row.ts)
    const values = byTs.get(ts) ?? ZERO_INGEST()
    values.jobs[row.event] += number(row.value)
    values.duration_seconds.total += number(row.duration_total)
    values.duration_seconds.count += number(row.duration_count)
    values.duration_seconds.max = Math.max(values.duration_seconds.max, number(row.duration_max))
    byTs.set(ts, values)
  }
  const buckets = bucketKeys(window).map((ts) => ({ ts, ...(byTs.get(ts) ?? ZERO_INGEST()) }))
  for (const bucket of buckets) {
    bucket.duration_seconds.avg = bucket.duration_seconds.count
      ? bucket.duration_seconds.total / bucket.duration_seconds.count
      : 0
  }
  const totals = buckets.reduce((sum, bucket) => {
    for (const event of ['created', 'started', 'done', 'failed'] as const) sum.jobs[event] += bucket.jobs[event]
    sum.duration_seconds.total += bucket.duration_seconds.total
    sum.duration_seconds.count += bucket.duration_seconds.count
    sum.duration_seconds.max = Math.max(sum.duration_seconds.max, bucket.duration_seconds.max)
    return sum
  }, ZERO_INGEST())
  totals.duration_seconds.avg = totals.duration_seconds.count
    ? totals.duration_seconds.total / totals.duration_seconds.count
    : 0
  return envelope(window, buckets, totals)
}

export const KNOWLEDGE_METRICS = [
  'sources_created',
  'concepts_created',
  'revisions_created',
  'claims_created',
  'citations_created',
  'decisions_created',
  'proposals_created',
  'proposals_approved',
  'proposals_rejected',
  'proposals_failed',
] as const
type KnowledgeMetric = (typeof KNOWLEDGE_METRICS)[number]

function zeroKnowledge(): Record<KnowledgeMetric, number> {
  return Object.fromEntries(KNOWLEDGE_METRICS.map((metric) => [metric, 0])) as Record<KnowledgeMetric, number>
}

interface MetricRow {
  ts: Date | string
  metric: string
  value: unknown
}

export async function getKnowledgeStats(db: Db, spaceId: string, window: StatsWindow) {
  const { rows } = await db.query<MetricRow>(
    `SELECT date_trunc($4, occurred_at) AS ts, metric, count(*)::integer AS value
       FROM (
         SELECT created_at AS occurred_at, 'sources_created' AS metric FROM wk_sources WHERE space_id = $1
         UNION ALL SELECT created_at, 'concepts_created' FROM wk_concepts WHERE space_id = $1
         UNION ALL SELECT created_at, 'revisions_created' FROM wk_concept_revisions WHERE space_id = $1
         UNION ALL SELECT created_at, 'claims_created' FROM wk_claims WHERE space_id = $1
         UNION ALL SELECT created_at, 'citations_created' FROM wk_citations WHERE space_id = $1
         UNION ALL SELECT created_at, 'decisions_created' FROM wk_decisions WHERE space_id = $1
         UNION ALL SELECT created_at, 'proposals_created' FROM wk_change_proposals WHERE space_id = $1
         UNION ALL SELECT reviewed_at, 'proposals_approved' FROM wk_change_proposals
           WHERE space_id = $1 AND status = 'approved' AND reviewed_at IS NOT NULL
         UNION ALL SELECT reviewed_at, 'proposals_rejected' FROM wk_change_proposals
           WHERE space_id = $1 AND status = 'rejected' AND reviewed_at IS NOT NULL
         UNION ALL SELECT created_at, 'proposals_failed' FROM wk_change_proposals
           WHERE space_id = $1 AND status = 'failed'
       ) events
      WHERE occurred_at >= $2 AND occurred_at < $3
      GROUP BY 1, metric ORDER BY 1, metric`,
    [spaceId, window.from, window.to, window.bucket],
  )
  const byTs = new Map<string, Record<KnowledgeMetric, number>>()
  for (const row of rows) {
    const ts = iso(row.ts)
    const values = byTs.get(ts) ?? zeroKnowledge()
    if ((KNOWLEDGE_METRICS as readonly string[]).includes(row.metric))
      values[row.metric as KnowledgeMetric] = number(row.value)
    byTs.set(ts, values)
  }
  const buckets = bucketKeys(window).map((ts) => ({ ts, ...(byTs.get(ts) ?? zeroKnowledge()) }))
  const totals = buckets.reduce((sum, bucket) => {
    for (const metric of KNOWLEDGE_METRICS) sum[metric] += bucket[metric]
    return sum
  }, zeroKnowledge())
  return envelope(window, buckets, totals)
}

const ZERO_LLM = () => ({
  calls: 0,
  tokens: { input: 0, output: 0, cache_read: 0, total: 0 },
  duration_ms: { total: 0, avg: 0, max: 0 },
  by_kind: {} as Record<string, number>,
  by_model: {} as Record<string, number>,
})

interface LlmRow {
  ts: Date | string
  kind: string
  model: string
  calls: unknown
  input_tokens: unknown
  output_tokens: unknown
  cache_read_tokens: unknown
  duration_total: unknown
  duration_avg: unknown
  duration_max: unknown
}

export async function getLlmStats(db: Db, spaceId: string, window: StatsWindow) {
  const { rows } = await db.query<LlmRow>(
    `SELECT date_trunc($4, created_at) AS ts, kind, model,
            count(*)::integer AS calls,
            coalesce(sum((usage->>'input_tokens')::bigint), 0)::bigint AS input_tokens,
            coalesce(sum((usage->>'output_tokens')::bigint), 0)::bigint AS output_tokens,
            coalesce(sum((usage->>'cache_read_input_tokens')::bigint), 0)::bigint AS cache_read_tokens,
            coalesce(sum(duration_ms), 0)::bigint AS duration_total,
            coalesce(avg(duration_ms), 0)::double precision AS duration_avg,
            coalesce(max(duration_ms), 0)::integer AS duration_max
       FROM wk_agent_runs
      WHERE space_id = $1 AND created_at >= $2 AND created_at < $3
      GROUP BY 1, kind, model ORDER BY 1, kind, model`,
    [spaceId, window.from, window.to, window.bucket],
  )
  const byTs = new Map<string, ReturnType<typeof ZERO_LLM>>()
  for (const row of rows) {
    const ts = iso(row.ts)
    const values = byTs.get(ts) ?? ZERO_LLM()
    const calls = number(row.calls)
    values.calls += calls
    values.tokens.input += number(row.input_tokens)
    values.tokens.output += number(row.output_tokens)
    values.tokens.cache_read += number(row.cache_read_tokens)
    values.duration_ms.total += number(row.duration_total)
    values.duration_ms.max = Math.max(values.duration_ms.max, number(row.duration_max))
    values.by_kind[row.kind] = (values.by_kind[row.kind] ?? 0) + calls
    values.by_model[row.model] = (values.by_model[row.model] ?? 0) + calls
    byTs.set(ts, values)
  }
  const buckets = bucketKeys(window).map((ts) => {
    const values = byTs.get(ts) ?? ZERO_LLM()
    values.tokens.total = values.tokens.input + values.tokens.output + values.tokens.cache_read
    values.duration_ms.avg = values.calls ? values.duration_ms.total / values.calls : 0
    return { ts, ...values }
  })
  const totals = buckets.reduce((sum, bucket) => {
    sum.calls += bucket.calls
    sum.tokens.input += bucket.tokens.input
    sum.tokens.output += bucket.tokens.output
    sum.tokens.cache_read += bucket.tokens.cache_read
    sum.duration_ms.total += bucket.duration_ms.total
    sum.duration_ms.max = Math.max(sum.duration_ms.max, bucket.duration_ms.max)
    for (const [kind, value] of Object.entries(bucket.by_kind)) sum.by_kind[kind] = (sum.by_kind[kind] ?? 0) + value
    for (const [model, value] of Object.entries(bucket.by_model))
      sum.by_model[model] = (sum.by_model[model] ?? 0) + value
    return sum
  }, ZERO_LLM())
  totals.tokens.total = totals.tokens.input + totals.tokens.output + totals.tokens.cache_read
  totals.duration_ms.avg = totals.calls ? totals.duration_ms.total / totals.calls : 0
  return envelope(window, buckets, totals)
}

const WEBHOOK_METRICS = ['events', 'pending', 'delivering', 'delivered', 'failed', 'dead'] as const
type WebhookMetric = (typeof WEBHOOK_METRICS)[number]
function zeroWebhook(): Record<WebhookMetric, number> {
  return Object.fromEntries(WEBHOOK_METRICS.map((metric) => [metric, 0])) as Record<WebhookMetric, number>
}

export async function getWebhookStats(db: Db, spaceId: string, window: StatsWindow) {
  const { rows } = await db.query<MetricRow>(
    `SELECT date_trunc($4, occurred_at) AS ts, metric, count(*)::integer AS value
       FROM (
         SELECT created_at AS occurred_at, 'events' AS metric
           FROM wk_outbox_events WHERE space_id = $1
         UNION ALL
         SELECT d.created_at, d.status AS metric
           FROM wk_webhook_deliveries d
           JOIN wk_webhook_endpoints e ON e.id = d.endpoint_id
          WHERE e.space_id = $1
       ) activity
      WHERE occurred_at >= $2 AND occurred_at < $3
      GROUP BY 1, metric ORDER BY 1, metric`,
    [spaceId, window.from, window.to, window.bucket],
  )
  const byTs = new Map<string, Record<WebhookMetric, number>>()
  for (const row of rows) {
    const ts = iso(row.ts)
    const values = byTs.get(ts) ?? zeroWebhook()
    if ((WEBHOOK_METRICS as readonly string[]).includes(row.metric))
      values[row.metric as WebhookMetric] = number(row.value)
    byTs.set(ts, values)
  }
  const buckets = bucketKeys(window).map((ts) => ({ ts, ...(byTs.get(ts) ?? zeroWebhook()) }))
  const totals = buckets.reduce((sum, bucket) => {
    for (const metric of WEBHOOK_METRICS) sum[metric] += bucket[metric]
    return sum
  }, zeroWebhook())
  return envelope(window, buckets, totals)
}
