// Prometheus text-format metrics, covering WikiKit's surfaces: HTTP
// counters/histograms, ingest job outcomes, LLM token usage, webhook
// deliveries.
//
// WHY hand-rolled instead of prom-client: the exposition format is trivial
// (text lines), the metric set is small and fixed, and a dependency-free
// module keeps the single-binary build lean and auditable. Everything is
// in-memory per process — Prometheus scrapes /metrics and owns the history.
//
// WHY no timestamps and no reset: counters and histograms are cumulative
// since process start, exactly what Prometheus rate()/histogram_quantile()
// expect.

/** Structural subset of LlmUsage (src/llm/provider.ts) so metrics never depends on the llm module. */
export interface LlmUsageLike {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
}

export interface Metrics {
  /** One line per finished HTTP request: counter by method/route/status + duration histogram by method/route. */
  httpRequest(method: string, route: string, status: number, durationMs: number): void
  /** One terminal ingest job: counter by outcome + duration histogram. */
  ingestJob(status: 'done' | 'failed', durationMs: number): void
  /** One LLM call: call counter + token counters split by direction (cost telemetry from day one). */
  llmCall(kind: string, model: string, usage: LlmUsageLike, result?: 'success' | 'error', durationMs?: number): void
  /** One webhook delivery outcome (delivered = success, failed = will retry, dead = gave up). */
  webhookDelivery(status: 'delivered' | 'failed' | 'dead'): void
  /** Full Prometheus text exposition (text/plain; version=0.0.4). */
  render(): string
}

// Route/method/status are server-controlled (the ROUTES registry template,
// not the raw URL) so cardinality stays bounded; escaping still guards the
// exposition format against any stray quote/newline.
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function labelString(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`)
  return parts.length ? `{${parts.join(',')}}` : ''
}

// --- counter ----------------------------------------------------------------

interface Counter {
  help: string
  // key = serialized label string → value. Serialized form doubles as the
  // render output, so increment stays a single Map lookup on the hot path.
  series: Map<string, number>
}

function inc(counter: Counter, labels: Record<string, string>, by = 1): void {
  const key = labelString(labels)
  counter.series.set(key, (counter.series.get(key) ?? 0) + by)
}

// --- histogram ---------------------------------------------------------------

// Standard cumulative-bucket histogram: le buckets + _sum + _count per label
// set. Buckets are in SECONDS (Prometheus base-unit convention) even though
// callers pass milliseconds — the conversion lives here, once.
interface HistogramSeries {
  counts: number[]
  sum: number
  count: number
}
interface Histogram {
  help: string
  buckets: number[]
  series: Map<string, HistogramSeries>
}

function observe(histogram: Histogram, labels: Record<string, string>, seconds: number): void {
  const key = JSON.stringify(labels)
  let series = histogram.series.get(key)
  if (!series) {
    series = { counts: histogram.buckets.map(() => 0), sum: 0, count: 0 }
    histogram.series.set(key, series)
  }
  for (let i = 0; i < histogram.buckets.length; i++) {
    if (seconds <= histogram.buckets[i]!) series.counts[i]!++
  }
  series.sum += seconds
  series.count++
}

function renderHistogram(name: string, histogram: Histogram, lines: string[]): void {
  lines.push(`# HELP ${name} ${histogram.help}`, `# TYPE ${name} histogram`)
  for (const [key, series] of histogram.series) {
    const labels = JSON.parse(key) as Record<string, string>
    for (let i = 0; i < histogram.buckets.length; i++) {
      lines.push(`${name}_bucket${labelString({ ...labels, le: String(histogram.buckets[i]) })} ${series.counts[i]}`)
    }
    lines.push(`${name}_bucket${labelString({ ...labels, le: '+Inf' })} ${series.count}`)
    lines.push(`${name}_sum${labelString(labels)} ${series.sum}`)
    lines.push(`${name}_count${labelString(labels)} ${series.count}`)
  }
}

function renderCounter(name: string, counter: Counter, lines: string[]): void {
  lines.push(`# HELP ${name} ${counter.help}`, `# TYPE ${name} counter`)
  for (const [labelKey, value] of counter.series) {
    lines.push(`${name}${labelKey} ${value}`)
  }
}

// --- factory ------------------------------------------------------------------

export function createMetrics(): Metrics {
  const httpRequests: Counter = { help: 'HTTP requests handled', series: new Map() }
  const httpDuration: Histogram = {
    help: 'HTTP request duration in seconds',
    // Sub-10ms buckets catch the LLM-free reads; the long tail covers /query.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    series: new Map(),
  }
  const ingestJobs: Counter = { help: 'Terminal ingest jobs by outcome', series: new Map() }
  const ingestDuration: Histogram = {
    help: 'Ingest job duration in seconds (started_at to terminal state)',
    // Ingest is LLM-long by design (classify + one synthesize per concept),
    // so the buckets stretch to minutes instead of the HTTP sub-second range.
    buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600],
    series: new Map(),
  }
  const llmCalls: Counter = { help: 'LLM provider calls', series: new Map() }
  const llmDuration: Histogram = {
    help: 'LLM provider call duration in seconds',
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    series: new Map(),
  }
  const llmTokens: Counter = {
    help: 'LLM tokens by direction (type: input|output|cache_read)',
    series: new Map(),
  }
  const webhookDeliveries: Counter = { help: 'Webhook delivery attempts by outcome', series: new Map() }

  return {
    httpRequest(method, route, status, durationMs) {
      inc(httpRequests, { method, route, status: String(status) })
      observe(httpDuration, { method, route }, durationMs / 1000)
    },

    ingestJob(status, durationMs) {
      inc(ingestJobs, { status })
      observe(ingestDuration, {}, durationMs / 1000)
    },

    llmCall(kind, model, usage, result = 'success', durationMs = 0) {
      inc(llmCalls, { kind, model, result })
      observe(llmDuration, { kind, model, result }, durationMs / 1000)
      // Zero-token directions are skipped so unused series (e.g. cache_read
      // without prompt caching) never appear in the exposition.
      if (usage.input_tokens) inc(llmTokens, { kind, model, type: 'input' }, usage.input_tokens)
      if (usage.output_tokens) inc(llmTokens, { kind, model, type: 'output' }, usage.output_tokens)
      if (usage.cache_read_input_tokens) {
        inc(llmTokens, { kind, model, type: 'cache_read' }, usage.cache_read_input_tokens)
      }
    },

    webhookDelivery(status) {
      inc(webhookDeliveries, { status })
    },

    render() {
      const lines: string[] = []
      renderCounter('wikikit_http_requests_total', httpRequests, lines)
      renderHistogram('wikikit_http_request_duration_seconds', httpDuration, lines)
      renderCounter('wikikit_ingest_jobs_total', ingestJobs, lines)
      renderHistogram('wikikit_ingest_job_duration_seconds', ingestDuration, lines)
      renderCounter('wikikit_llm_calls_total', llmCalls, lines)
      renderHistogram('wikikit_llm_call_duration_seconds', llmDuration, lines)
      renderCounter('wikikit_llm_tokens_total', llmTokens, lines)
      renderCounter('wikikit_webhook_deliveries_total', webhookDeliveries, lines)
      return `${lines.join('\n')}\n`
    },
  }
}
