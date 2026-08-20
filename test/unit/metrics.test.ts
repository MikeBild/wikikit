// Prometheus exposition tests: counter aggregation, cumulative histogram
// buckets, label escaping, the token accounting split, and the process gauges.
import { describe, expect, test } from 'bun:test'
import { createMetrics } from '../../src/metrics.ts'

describe('createMetrics', () => {
  test('renders an empty registry with all families declared', () => {
    const text = createMetrics().render()
    expect(text).toContain('# TYPE wikikit_http_requests_total counter')
    expect(text).toContain('# TYPE wikikit_http_request_duration_seconds histogram')
    expect(text).toContain('# TYPE wikikit_ingest_jobs_total counter')
    expect(text).toContain('# TYPE wikikit_ingest_job_duration_seconds histogram')
    expect(text).toContain('# TYPE wikikit_llm_calls_total counter')
    expect(text).toContain('# TYPE wikikit_llm_call_duration_seconds histogram')
    expect(text).toContain('# TYPE wikikit_llm_tokens_total counter')
    expect(text).toContain('# TYPE wikikit_webhook_deliveries_total counter')
    expect(text).toContain('# TYPE wikikit_process_memory_rss_bytes gauge')
    expect(text).toContain('# TYPE wikikit_process_memory_heap_used_bytes gauge')
    expect(text).toContain('# TYPE wikikit_process_memory_heap_total_bytes gauge')
    expect(text).toContain('# TYPE wikikit_process_uptime_seconds gauge')
    expect(text).toContain('# TYPE wikikit_event_loop_lag_seconds gauge')
    expect(text.endsWith('\n')).toBe(true)
    // Every family has exactly one HELP line (no duplicates on repeat render).
    expect(text.match(/# HELP wikikit_http_requests_total /g)).toHaveLength(1)
  })

  test('http request counters aggregate by method/route/status', () => {
    const metrics = createMetrics()
    metrics.httpRequest('GET', '/v1/spaces/{space}/concepts', 200, 12)
    metrics.httpRequest('GET', '/v1/spaces/{space}/concepts', 200, 15)
    metrics.httpRequest('GET', '/v1/spaces/{space}/concepts', 404, 3)
    metrics.httpRequest('POST', '/v1/spaces/{space}/ingest', 202, 40)
    const text = metrics.render()
    expect(text).toContain(
      'wikikit_http_requests_total{method="GET",route="/v1/spaces/{space}/concepts",status="200"} 2',
    )
    expect(text).toContain(
      'wikikit_http_requests_total{method="GET",route="/v1/spaces/{space}/concepts",status="404"} 1',
    )
    expect(text).toContain(
      'wikikit_http_requests_total{method="POST",route="/v1/spaces/{space}/ingest",status="202"} 1',
    )
  })

  test('http duration histogram has cumulative buckets, +Inf, sum and count', () => {
    const metrics = createMetrics()
    metrics.httpRequest('GET', '/health', 200, 3) // 0.003s → all buckets
    metrics.httpRequest('GET', '/health', 200, 30) // 0.03s  → le>=0.05
    metrics.httpRequest('GET', '/health', 200, 30_000) // 30s → only +Inf
    const text = metrics.render()
    expect(text).toContain('wikikit_http_request_duration_seconds_bucket{method="GET",route="/health",le="0.005"} 1')
    expect(text).toContain('wikikit_http_request_duration_seconds_bucket{method="GET",route="/health",le="0.05"} 2')
    expect(text).toContain('wikikit_http_request_duration_seconds_bucket{method="GET",route="/health",le="10"} 2')
    expect(text).toContain('wikikit_http_request_duration_seconds_bucket{method="GET",route="/health",le="+Inf"} 3')
    expect(text).toContain('wikikit_http_request_duration_seconds_sum{method="GET",route="/health"} 30.033')
    expect(text).toContain('wikikit_http_request_duration_seconds_count{method="GET",route="/health"} 3')
  })

  test('ingest job outcomes and durations', () => {
    const metrics = createMetrics()
    metrics.ingestJob('done', 12_000)
    metrics.ingestJob('done', 45_000)
    metrics.ingestJob('failed', 500)
    const text = metrics.render()
    expect(text).toContain('wikikit_ingest_jobs_total{status="done"} 2')
    expect(text).toContain('wikikit_ingest_jobs_total{status="failed"} 1')
    expect(text).toContain('wikikit_ingest_job_duration_seconds_bucket{le="30"} 2')
    expect(text).toContain('wikikit_ingest_job_duration_seconds_bucket{le="+Inf"} 3')
    expect(text).toContain('wikikit_ingest_job_duration_seconds_count 3')
  })

  test('llm token accounting splits by direction and skips absent/zero directions', () => {
    const metrics = createMetrics()
    metrics.llmCall('synthesize', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 250 }, 'success', 250)
    metrics.llmCall(
      'synthesize',
      'claude-sonnet-5',
      {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 900,
      },
      'success',
      500,
    )
    metrics.llmCall('classify', 'claude-haiku-4-5', { input_tokens: 0, output_tokens: 10 })
    const text = metrics.render()
    expect(text).toContain('wikikit_llm_calls_total{kind="synthesize",model="claude-sonnet-5",result="success"} 2')
    expect(text).toContain('wikikit_llm_calls_total{kind="classify",model="claude-haiku-4-5",result="success"} 1')
    expect(text).toContain('wikikit_llm_tokens_total{kind="synthesize",model="claude-sonnet-5",type="input"} 1500')
    expect(text).toContain('wikikit_llm_tokens_total{kind="synthesize",model="claude-sonnet-5",type="output"} 350')
    expect(text).toContain('wikikit_llm_tokens_total{kind="synthesize",model="claude-sonnet-5",type="cache_read"} 900')
    expect(text).toContain(
      'wikikit_llm_call_duration_seconds_count{kind="synthesize",model="claude-sonnet-5",result="success"} 2',
    )
    // zero input_tokens for classify → no input series at all
    expect(text).not.toContain('wikikit_llm_tokens_total{kind="classify",model="claude-haiku-4-5",type="input"}')
    expect(text).toContain('wikikit_llm_tokens_total{kind="classify",model="claude-haiku-4-5",type="output"} 10')
  })

  test('webhook delivery outcomes', () => {
    const metrics = createMetrics()
    metrics.webhookDelivery('delivered')
    metrics.webhookDelivery('delivered')
    metrics.webhookDelivery('failed')
    metrics.webhookDelivery('dead')
    const text = metrics.render()
    expect(text).toContain('wikikit_webhook_deliveries_total{status="delivered"} 2')
    expect(text).toContain('wikikit_webhook_deliveries_total{status="failed"} 1')
    expect(text).toContain('wikikit_webhook_deliveries_total{status="dead"} 1')
  })

  test('label values are escaped (quotes, backslashes, newlines)', () => {
    const metrics = createMetrics()
    metrics.httpRequest('GET', 'route"with\\weird\nchars', 200, 1)
    const text = metrics.render()
    expect(text).toContain('route="route\\"with\\\\weird\\nchars"')
    // Exposition stays line-based: no raw newline leaked into a label.
    for (const line of text.split('\n')) expect(line).not.toMatch(/^chars/)
  })
})

// --- process gauges -------------------------------------------------------------
//
// Until 2026-08-20 wikikit was the one product of six whose exposition could not
// answer "is this process healthy". Eight families, none of them about the
// process: a slow memory leak would have been invisible here until the host ran
// out, and "busy" and "wedged" looked the same from outside.

describe('process gauges', () => {
  test('report live values, not zeroes', () => {
    const metrics = createMetrics()
    const text = metrics.render()
    metrics.stop()

    const value = (name: string): number =>
      Number(
        text
          .split('\n')
          .find((line) => line.startsWith(`${name} `))
          ?.split(' ')[1],
      )

    // A gauge that renders but always reads 0 is worse than an absent one: it
    // answers the question wrongly instead of admitting it cannot.
    expect(value('wikikit_process_memory_rss_bytes')).toBeGreaterThan(0)
    expect(value('wikikit_process_memory_heap_used_bytes')).toBeGreaterThan(0)
    expect(value('wikikit_process_memory_heap_total_bytes')).toBeGreaterThan(0)
    expect(value('wikikit_process_uptime_seconds')).toBeGreaterThanOrEqual(0)
    // Lag may legitimately be 0 on an idle loop, so only its shape is asserted.
    expect(Number.isFinite(value('wikikit_event_loop_lag_seconds'))).toBe(true)
  })

  test('are unlabelled — one process, so a label would carry one value forever', () => {
    const metrics = createMetrics()
    const text = metrics.render()
    metrics.stop()
    for (const name of [
      'wikikit_process_memory_rss_bytes',
      'wikikit_process_uptime_seconds',
      'wikikit_event_loop_lag_seconds',
    ]) {
      expect(text).toMatch(new RegExp(`^${name} [0-9.]+$`, 'm'))
    }
  })

  test('are re-sampled per render, and never duplicate their HELP line', () => {
    // The scrape IS the sample. A gauge computed once at construction would
    // report the heap as it was at boot for the life of the process.
    const metrics = createMetrics()
    metrics.render()
    const text = metrics.render()
    metrics.stop()
    expect(text.match(/# HELP wikikit_process_memory_rss_bytes /g)).toHaveLength(1)
    expect(text.match(/^wikikit_process_uptime_seconds /gm)).toHaveLength(1)
  })

  test('stop() is idempotent, so a double close cannot throw', () => {
    const metrics = createMetrics()
    metrics.stop()
    expect(() => metrics.stop()).not.toThrow()
  })
})
