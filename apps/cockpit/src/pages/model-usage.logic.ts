export interface LlmBucket {
  ts: string
  calls: number
  tokens: { input: number; output: number; cache_read: number; total: number }
  cost_usd: { total: number }
  unpriced: { calls: number; tokens: { total: number }; models: readonly string[] }
  cache_hit_ratio: number | null
}

export interface UsagePoint {
  ts: string
  label: string
  input: number
  output: number
  cacheRead: number
  cost: number | null
  unpricedCalls: number
}

/** Keep the server's gaps and unknown prices visible instead of joining them into a reassuring zero line. */
export function usageSeries(buckets: readonly LlmBucket[], locale: string): UsagePoint[] {
  const formatter = new Intl.DateTimeFormat(locale, { month: 'short', day: '2-digit', hour: '2-digit' })
  return buckets.map((bucket) => ({
    ts: bucket.ts,
    label: formatter.format(new Date(bucket.ts)),
    input: bucket.tokens.input,
    output: bucket.tokens.output,
    cacheRead: bucket.tokens.cache_read,
    cost:
      bucket.calls > 0 && bucket.unpriced.calls === bucket.calls && bucket.cost_usd.total === 0
        ? null
        : bucket.cost_usd.total,
    unpricedCalls: bucket.unpriced.calls,
  }))
}

export function formatCurrency(
  cost: number | null | undefined,
  calls: number,
  unpricedCalls: number,
  locale: string,
): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return '—'
  if (calls > 0 && calls === unpricedCalls && cost === 0) return '—'
  const digits = cost > 0 && cost < 0.01 ? 4 : 2
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(cost)
}

export function formatRatio(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value)
}

export function formatCount(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(locale).format(value)
}

export function unpricedModels(models: readonly string[]): string {
  return [...new Set(models)].sort().join(', ')
}
