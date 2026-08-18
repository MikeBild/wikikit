import { describe, expect, test } from 'bun:test'
import type { Db } from '../../src/db/postgres.ts'
import {
  getIngestStats,
  getKnowledgeStats,
  getLlmStats,
  getLlmStatsAcrossSpaces,
  getWebhookStats,
  resolveStatsWindow,
} from '../../src/stats.ts'

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

  test('captured and discarded rows are not ingest volume', async () => {
    // A parked note never entered the pipeline; a discarded one never will.
    // Without this filter every capture would inflate `created` (§B1 reader
    // audit) — a promoted row flips to queued and counts from then on.
    let sql = ''
    const db = {
      query: async (text: string) => {
        sql = text
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Db
    await getIngestStats(db, 'space-id', window)
    expect(sql).toContain(`status NOT IN ('captured', 'discarded')`)
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
      { 'model-a': { input: 2, output: 10, cache_read: 0.2 } },
    )
    expect(result.totals).toMatchObject({
      calls: 2,
      tokens: { input: 10, output: 4, cache_read: 20, total: 34 },
      cost_usd: { input: 0.00002, output: 0.00004, cache_read: 0.000004 },
      unpriced: { calls: 0, tokens: { input: 0, output: 0, cache_read: 0, total: 0 }, models: [] },
      cache_hit_ratio: 2 / 3,
      duration_ms: { total: 600, avg: 300, max: 400 },
      by_kind: { synthesize: 2 },
      by_model: { 'model-a': 2 },
    })
    expect(result.totals.cost_usd.total).toBeCloseTo(0.000064)
  })

  test('unknown models are counted openly and cross-wiki totals retain their owners', async () => {
    const result = await getLlmStatsAcrossSpaces(
      dbWith([
        {
          space_id: 'a-id',
          ts: '2026-07-18T08:00:00.000Z',
          kind: 'answer',
          model: 'unknown-model',
          calls: '2',
          input_tokens: '100',
          output_tokens: '20',
          cache_read_tokens: '0',
          duration_total: '500',
          duration_avg: '250',
          duration_max: '300',
        },
      ]),
      [
        { id: 'a-id', slug: 'alpha', name: 'Alpha' },
        { id: 'b-id', slug: 'beta', name: 'Beta' },
      ],
      window,
      {},
    )
    expect(result.totals.unpriced).toMatchObject({ calls: 2, tokens: { total: 120 }, models: ['unknown-model'] })
    expect(result.per_space[0]?.totals.unpriced.calls).toBe(2)
    expect(result.per_space[1]?.totals.calls).toBe(0)
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
