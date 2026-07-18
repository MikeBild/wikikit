import { describe, expect, test } from 'bun:test'
import type { Db } from '../../src/db/postgres.ts'
import { getIngestStats, getKnowledgeStats, getLlmStats, getWebhookStats, resolveStatsWindow } from '../../src/stats.ts'

function dbWith(rows: Record<string, unknown>[]): Db {
  return { query: async () => ({ rows, rowCount: rows.length }) } as unknown as Db
}

const window = resolveStatsWindow({
  bucket: 'hour',
  from: '2026-07-18T08:00:00.000Z',
  to: '2026-07-18T10:00:00.000Z',
})

describe('product stats window', () => {
  test('defaults to a bounded UTC 24-hour view', () => {
    const to = new Date('2026-07-18T10:34:56.000Z')
    const resolved = resolveStatsWindow({}, to)
    expect(resolved).toEqual({
      bucket: 'hour',
      tz: 'UTC',
      from: new Date('2026-07-17T10:34:56.000Z'),
      to,
    })
  })

  test('rejects invalid, reversed and excessive windows', () => {
    expect(() => resolveStatsWindow({ bucket: 'minute' })).toThrow(/bucket/)
    expect(() => resolveStatsWindow({ from: 'bad' })).toThrow(/from/)
    expect(() => resolveStatsWindow({ from: '2026-01-02', to: '2026-01-01' })).toThrow(/after/)
    expect(() =>
      resolveStatsWindow({ bucket: 'hour', from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }),
    ).toThrow(/too large/)
  })
})

describe('database-backed product stats', () => {
  test('ingest events are dense, terminal-time based and correctly rolled up', async () => {
    const result = await getIngestStats(
      dbWith([
        {
          ts: '2026-07-18T08:00:00.000Z',
          event: 'created',
          value: '2',
          duration_total: 0,
          duration_count: 0,
          duration_avg: 0,
          duration_max: 0,
        },
        {
          ts: '2026-07-18T08:00:00.000Z',
          event: 'done',
          value: '1',
          duration_total: '4.5',
          duration_count: '1',
          duration_avg: '4.5',
          duration_max: '4.5',
        },
      ]),
      'space-id',
      window,
    )
    expect(result.buckets).toHaveLength(2)
    expect(result.buckets[0]).toMatchObject({ jobs: { created: 2, done: 1 }, duration_seconds: { avg: 4.5 } })
    expect(result.buckets[1]).toMatchObject({ jobs: { created: 0, done: 0 } })
    expect(result.totals).toMatchObject({ jobs: { created: 2, done: 1 }, duration_seconds: { total: 4.5 } })
  })

  test('knowledge events expose counts only and separate review outcomes', async () => {
    const result = await getKnowledgeStats(
      dbWith([
        { ts: '2026-07-18T08:00:00.000Z', metric: 'sources_created', value: '3' },
        { ts: '2026-07-18T08:00:00.000Z', metric: 'proposals_approved', value: '1' },
      ]),
      'space-id',
      window,
    )
    expect(result.totals.sources_created).toBe(3)
    expect(result.totals.proposals_approved).toBe(1)
    expect(result.totals.claims_created).toBe(0)
    expect(JSON.stringify(result)).not.toContain('space-id')
  })

  test('LLM stats aggregate tokens and retain bounded product dimensions', async () => {
    const result = await getLlmStats(
      dbWith([
        {
          ts: '2026-07-18T08:00:00.000Z',
          kind: 'synthesize',
          model: 'model-a',
          calls: '2',
          input_tokens: '10',
          output_tokens: '4',
          cache_read_tokens: '20',
          duration_total: '600',
          duration_avg: '300',
          duration_max: '400',
        },
      ]),
      'space-id',
      window,
    )
    expect(result.totals).toMatchObject({
      calls: 2,
      tokens: { input: 10, output: 4, cache_read: 20, total: 34 },
      duration_ms: { total: 600, avg: 300, max: 400 },
      by_kind: { synthesize: 2 },
      by_model: { 'model-a': 2 },
    })
  })

  test('webhook stats expose delivery outcomes without endpoints or payloads', async () => {
    const result = await getWebhookStats(
      dbWith([
        { ts: '2026-07-18T08:00:00.000Z', metric: 'events', value: '4' },
        { ts: '2026-07-18T08:00:00.000Z', metric: 'delivered', value: '3' },
      ]),
      'space-id',
      window,
    )
    expect(result.totals).toMatchObject({ events: 4, delivered: 3, failed: 0, dead: 0 })
    expect(JSON.stringify(result)).not.toMatch(/endpoint|payload|url|secret/)
  })
})
