// Prometheus text-format metrics, covering WikiKit's surfaces: HTTP
// counters/histograms, ingest job outcomes, LLM token usage, webhook
// deliveries, and the process itself.
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
  /**
   * One terminal ingest job: counter by outcome + duration histogram.
   * 'timeout' and 'worker_lost' come from the reaper as well as the worker —
   * an outcome nothing counts is an outcome nothing can alert on.
   */
  ingestJob(status: 'done' | 'failed' | 'timeout' | 'worker_lost', durationMs: number): void
  /** One LLM call: call counter + token counters split by direction (cost telemetry from day one). */
  llmCall(kind: string, model: string, usage: LlmUsageLike, result?: 'success' | 'error', durationMs?: number): void
  /** One webhook delivery outcome (delivered = success, failed = will retry, dead = gave up). */
  webhookDelivery(status: 'delivered' | 'failed' | 'dead'): void
  /** Full Prometheus text exposition (text/plain; version=0.0.4). */
  render(): string
  /** Release the event-loop sampler. Idempotent; safe to call on a stopped instance. */
  stop(): void
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

// --- gauge --------------------------------------------------------------------

// The third metric type this module needed and did not have. A counter cannot
// express "heap is 41 MB right now" — it only goes up — and a histogram of a
// level is a category error. Unlabelled by design: every gauge here describes
// the whole process, and a label with one value is noise in every query.
function renderGauge(name: string, help: string, value: number, lines: string[]): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`)
}

// --- event loop lag ------------------------------------------------------------

/**
 * Sampled event-loop delay. A setInterval(…, interval) that fires late by N ms
 * means the loop was blocked for N ms — crude next to a perf_hooks histogram,
 * but dependency-free, allocation-free, and enough to separate "the process is
 * busy" from "the process is stuck", which is the decision it informs.
 *
 * That distinction is not academic here: ingest runs an LLM classify plus one
 * synthesize per concept, so a wikikit that stops answering during a large
 * ingest looks identical from outside to one that has wedged.
 */
function trackEventLoopLag(intervalMs = 1000): { value: () => number; stop: () => void } {
  let lag = 0
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    lag = Math.max(0, now - last - intervalMs)
    last = now
  }, intervalMs)
  // unref: a metrics sampler must never be the reason a process stays alive.
  timer.unref?.()
  return { value: () => lag, stop: () => clearInterval(timer) }
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
  const loopLag = trackEventLoopLag()

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

    stop() {
      loopLag.stop()
    },

    render() {
      const lines: string[] = []
      // Sampled at render time rather than on a timer: the scrape IS the
      // sample, so there is nothing to keep warm between scrapes. Only the loop
      // lag needs its own interval, because "how late did a timer fire" cannot
      // be answered by asking at an arbitrary moment.
      const memory = process.memoryUsage()
      renderGauge('wikikit_process_memory_rss_bytes', 'Resident set size in bytes', memory.rss, lines)
      renderGauge('wikikit_process_memory_heap_used_bytes', 'Heap in use in bytes', memory.heapUsed, lines)
      renderGauge('wikikit_process_memory_heap_total_bytes', 'Heap allocated in bytes', memory.heapTotal, lines)
      renderGauge('wikikit_process_uptime_seconds', 'Seconds since process start', Math.round(process.uptime()), lines)
      renderGauge(
        'wikikit_event_loop_lag_seconds',
        'Sampled event loop delay in seconds',
        loopLag.value() / 1000,
        lines,
      )

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
