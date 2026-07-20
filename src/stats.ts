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
export const USAGE_TRAFFIC_CLASSES = ['organic', 'synthetic', 'internal', 'all'] as const
export type UsageTrafficClass = (typeof USAGE_TRAFFIC_CLASSES)[number]
export type UsageStatsSurface = 'http' | 'mcp' | 'knowledge' | 'review'

const USAGE_GROUPS: Record<UsageStatsSurface, Record<string, string>> = {
  http: {
    route: 'route',
    method: 'method',
    outcome: 'outcome',
    status_class: '(status_code / 100)::text',
    traffic_class: 'traffic_class',
    request_source: 'request_source',
  },
  mcp: {
    operation: 'operation',
    tool_name: 'tool_name',
    outcome: 'outcome',
    response_mode: 'response_mode',
    traffic_class: 'traffic_class',
  },
  knowledge: {
    operation: 'operation',
    outcome: 'outcome',
    traffic_class: 'traffic_class',
    request_source: 'request_source',
  },
  review: {
    operation: 'operation',
    outcome: 'outcome',
    traffic_class: 'traffic_class',
    request_source: 'request_source',
  },
}

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

export interface UsageStatsWindow extends StatsWindow {
  surface: UsageStatsSurface
  trafficClass: UsageTrafficClass
  groupBy: string[]
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

export function resolveUsageStatsWindow(
  input: Record<string, unknown>,
  surface: UsageStatsSurface,
  now: Date = new Date(),
): UsageStatsWindow {
  const window = resolveStatsWindow(input, now)
  const trafficClass = String(input.traffic_class ?? 'organic') as UsageTrafficClass
  if (!USAGE_TRAFFIC_CLASSES.includes(trafficClass)) {
    throw new ValidationError(`traffic_class must be one of ${USAGE_TRAFFIC_CLASSES.join(', ')}`)
  }
  const groupBy = String(input.group_by ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (groupBy.length > 2) throw new ValidationError('group_by accepts at most two dimensions')
  if (new Set(groupBy).size !== groupBy.length) throw new ValidationError('group_by dimensions must be unique')
  for (const dimension of groupBy) {
    if (!USAGE_GROUPS[surface][dimension]) {
      throw new ValidationError(`group_by '${dimension}' is not supported for ${surface}`)
    }
  }
  return { ...window, surface, trafficClass, groupBy }
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

// ---------------------------------------------------------------------------
// Privacy-bounded usage telemetry. Bucket rows and totals are queried
// independently: distinct actors/sessions and percentiles are exact for the
// requested full window and must never be reconstructed by summing buckets.
// ---------------------------------------------------------------------------

type ValueKind = 'count' | 'duration' | 'ratio' | 'data-size' | 'gauge'
type ValueState = 'observed' | 'zero' | 'missing'

function metric(value: number, valueKind: ValueKind, state?: ValueState, sampleSize?: number) {
  return {
    value,
    value_kind: valueKind,
    value_state: state ?? (value === 0 ? 'zero' : 'observed'),
    ...(sampleSize === undefined ? {} : { sample_size: sampleSize }),
  }
}

function ratio(numerator: number, denominator: number) {
  return {
    value: denominator ? numerator / denominator : 0,
    value_kind: 'ratio' as const,
    value_state: denominator ? ('observed' as const) : ('missing' as const),
    numerator,
    denominator,
    sample_size: denominator,
  }
}

interface UsageRow {
  ts?: Date | string
  dimension_1?: unknown
  dimension_2?: unknown
  calls?: unknown
  success?: unknown
  client_errors?: unknown
  server_errors?: unknown
  rejected?: unknown
  unique_actors?: unknown
  unique_sessions?: unknown
  duration_ms_total?: unknown
  duration_ms_avg?: unknown
  duration_ms_p50?: unknown
  duration_ms_p95?: unknown
  request_size_count?: unknown
  response_size_count?: unknown
  request_bytes?: unknown
  response_bytes?: unknown
  result_count?: unknown
  result_count_samples?: unknown
  active_sessions?: unknown
}

function usageDimensions(row: UsageRow, groupBy: string[]): Record<string, string | null> {
  return Object.fromEntries(
    groupBy.map((name, index) => [name, (row[`dimension_${index + 1}` as keyof UsageRow] ?? null) as string | null]),
  )
}

function usageMetrics(row: UsageRow) {
  const calls = number(row.calls)
  const success = number(row.success)
  const clientErrors = number(row.client_errors)
  const serverErrors = number(row.server_errors)
  const rejected = number(row.rejected)
  const durationSamples = calls
  const requestSamples = number(row.request_size_count)
  const responseSamples = number(row.response_size_count)
  const resultSamples = number(row.result_count_samples)
  return {
    calls: metric(calls, 'count'),
    success: metric(success, 'count'),
    client_errors: metric(clientErrors, 'count'),
    server_errors: metric(serverErrors, 'count'),
    rejected: metric(rejected, 'count'),
    success_ratio: ratio(success, calls),
    error_ratio: ratio(clientErrors + serverErrors, calls),
    unique_actors: metric(number(row.unique_actors), 'count'),
    unique_sessions: metric(number(row.unique_sessions), 'count'),
    duration_ms_total: metric(
      number(row.duration_ms_total),
      'duration',
      calls ? undefined : 'missing',
      durationSamples,
    ),
    duration_ms_avg: metric(number(row.duration_ms_avg), 'duration', calls ? undefined : 'missing', durationSamples),
    duration_ms_p50: metric(number(row.duration_ms_p50), 'duration', calls ? undefined : 'missing', durationSamples),
    duration_ms_p95: metric(number(row.duration_ms_p95), 'duration', calls ? undefined : 'missing', durationSamples),
    request_bytes: metric(
      number(row.request_bytes),
      'data-size',
      requestSamples ? undefined : 'missing',
      requestSamples,
    ),
    response_bytes: metric(
      number(row.response_bytes),
      'data-size',
      responseSamples ? undefined : 'missing',
      responseSamples,
    ),
    result_count: metric(number(row.result_count), 'count', resultSamples ? undefined : 'missing', resultSamples),
    active_sessions: metric(number(row.active_sessions), 'gauge', row.active_sessions == null ? 'missing' : undefined),
  }
}

const USAGE_SELECT = `count(*)::double precision AS calls,
  count(*) FILTER (WHERE outcome = 'success')::double precision AS success,
  count(*) FILTER (WHERE outcome = 'client_error')::double precision AS client_errors,
  count(*) FILTER (WHERE outcome = 'server_error')::double precision AS server_errors,
  count(*) FILTER (WHERE outcome = 'rejected')::double precision AS rejected,
  count(DISTINCT actor_hmac)::double precision AS unique_actors,
  count(DISTINCT session_hmac)::double precision AS unique_sessions,
  coalesce(sum(duration_ms), 0)::double precision AS duration_ms_total,
  avg(duration_ms)::double precision AS duration_ms_avg,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::double precision AS duration_ms_p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::double precision AS duration_ms_p95,
  count(request_bytes)::double precision AS request_size_count,
  count(response_bytes)::double precision AS response_size_count,
  coalesce(sum(request_bytes), 0)::double precision AS request_bytes,
  coalesce(sum(response_bytes), 0)::double precision AS response_bytes,
  coalesce(sum(result_count), 0)::double precision AS result_count,
  count(result_count)::double precision AS result_count_samples,
  max(active_sessions)::double precision AS active_sessions`

export async function getUsageStats(
  db: Db,
  spaceId: string | null,
  window: UsageStatsWindow,
  runtimeQuality: Partial<{ dropped_events: number; retention_days: number }> = {},
) {
  const groups = window.groupBy.map((dimension) => USAGE_GROUPS[window.surface][dimension]!)
  const dimensionSelect = groups.map((expression, index) => `${expression} AS dimension_${index + 1}`).join(', ')
  const dimensionPrefix = dimensionSelect ? `${dimensionSelect}, ` : ''
  const groupSql = groups.length ? `, ${groups.join(', ')}` : ''
  const scoped = spaceId !== null
  const bucketParams: unknown[] = scoped
    ? [spaceId, window.from, window.to, window.bucket, window.surface, window.trafficClass]
    : [window.from, window.to, window.bucket, window.surface, window.trafficClass]
  const totalParams: unknown[] = scoped
    ? [spaceId, window.from, window.to, window.surface, window.trafficClass]
    : [window.from, window.to, window.surface, window.trafficClass]
  const b = scoped
    ? { space: 'space_id = $1 AND ', from: '$2', to: '$3', bucket: '$4', surface: '$5', traffic: '$6' }
    : { space: '', from: '$1', to: '$2', bucket: '$3', surface: '$4', traffic: '$5' }
  const t = scoped
    ? { space: 'space_id = $1 AND ', from: '$2', to: '$3', surface: '$4', traffic: '$5' }
    : { space: '', from: '$1', to: '$2', surface: '$3', traffic: '$4' }
  const bucketWhere = `${b.space}surface = ${b.surface} AND created_at >= ${b.from} AND created_at < ${b.to}
    AND (${b.traffic} = 'all' OR traffic_class = ${b.traffic})`
  const totalWhere = `${t.space}surface = ${t.surface} AND created_at >= ${t.from} AND created_at < ${t.to}
    AND (${t.traffic} = 'all' OR traffic_class = ${t.traffic})`
  const bucketRows = (
    await db.query<UsageRow>(
      `SELECT date_trunc(${b.bucket}::text, created_at) AS ts, ${dimensionPrefix}${USAGE_SELECT}
         FROM wk_usage_events WHERE ${bucketWhere}
        GROUP BY date_trunc(${b.bucket}::text, created_at)${groupSql}
        ORDER BY date_trunc(${b.bucket}::text, created_at)${groupSql}`,
      bucketParams,
    )
  ).rows
  const totalRows = (
    await db.query<UsageRow>(
      `SELECT ${dimensionPrefix}${USAGE_SELECT}
         FROM wk_usage_events WHERE ${totalWhere}
        ${groups.length ? `GROUP BY ${groups.join(', ')} ORDER BY ${groups.join(', ')}` : ''}`,
      totalParams,
    )
  ).rows
  let buckets = bucketRows.map((row) => ({
    ts: iso(row.ts!),
    dimensions: usageDimensions(row, window.groupBy),
    metrics: usageMetrics(row),
  }))
  if (!window.groupBy.length) {
    const byTs = new Map(buckets.map((row) => [row.ts, row]))
    buckets = bucketKeys(window).map((ts) => byTs.get(ts) ?? { ts, dimensions: {}, metrics: usageMetrics({}) })
  }
  const totals = (totalRows.length ? totalRows : [{}]).map((row) => ({
    dimensions: usageDimensions(row, window.groupBy),
    metrics: usageMetrics(row),
  }))
  return {
    schema_version: 'wikikit.usage-stats.v1',
    surface: window.surface,
    bucket: window.bucket,
    tz: window.tz,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    traffic_class: window.trafficClass,
    group_by: window.groupBy,
    buckets,
    totals,
    quality: {
      sampled: false,
      unique_count_method: 'exact_window',
      actor_scope: 'wikikit_product_local_hmac',
      content_captured: false,
      ...runtimeQuality,
    },
  }
}

export const getHttpUsageStats = (
  db: Db,
  spaceId: string,
  window: UsageStatsWindow,
  quality?: Parameters<typeof getUsageStats>[3],
) => getUsageStats(db, spaceId, window, quality)
export const getKnowledgeUsageStats = (
  db: Db,
  spaceId: string,
  window: UsageStatsWindow,
  quality?: Parameters<typeof getUsageStats>[3],
) => getUsageStats(db, spaceId, window, quality)
export const getReviewUsageStats = (
  db: Db,
  spaceId: string,
  window: UsageStatsWindow,
  quality?: Parameters<typeof getUsageStats>[3],
) => getUsageStats(db, spaceId, window, quality)
export const getMcpUsageStats = (db: Db, window: UsageStatsWindow, quality?: Parameters<typeof getUsageStats>[3]) =>
  getUsageStats(db, null, window, quality)
