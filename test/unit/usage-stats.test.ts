import { describe, expect, test } from 'bun:test'
import type { Db } from '../../src/db/postgres.ts'
import { getHttpUsageStats, getMcpUsageStats, resolveUsageStatsWindow } from '../../src/stats.ts'

describe('semantic usage statistics', () => {
  test('validates traffic and surface-specific grouping', () => {
    const now = new Date('2026-07-20T12:00:00Z')
    const window = resolveUsageStatsWindow(
      { bucket: 'hour', from: '2026-07-20T10:00:00Z', to: '2026-07-20T12:00:00Z', group_by: 'route,method' },
      'http',
      now,
    )
    expect(window.groupBy).toEqual(['route', 'method'])
    expect(() => resolveUsageStatsWindow({ group_by: 'route,method,outcome' }, 'http', now)).toThrow(/at most two/)
    expect(() => resolveUsageStatsWindow({ group_by: 'tool_name' }, 'http', now)).toThrow(/not supported/)
    expect(() => resolveUsageStatsWindow({ traffic_class: 'bot' }, 'mcp', now)).toThrow(/traffic_class/)
  })

  test('uses an independent full-window query for exact uniques, percentiles and ratio evidence', async () => {
    const calls: { sql: string; values?: unknown[] }[] = []
    const db = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values })
        const bucket = /date_trunc/.test(sql)
        return {
          rows: bucket
            ? [
                {
                  ts: new Date('2026-07-20T10:00:00Z'),
                  calls: 5,
                  success: 4,
                  client_errors: 1,
                  unique_actors: 2,
                  unique_sessions: 3,
                  duration_ms_total: 50,
                  duration_ms_avg: 10,
                  duration_ms_p50: 8,
                  duration_ms_p95: 20,
                },
              ]
            : [
                {
                  calls: 8,
                  success: 7,
                  client_errors: 1,
                  unique_actors: 3,
                  unique_sessions: 4,
                  duration_ms_total: 80,
                  duration_ms_avg: 10,
                  duration_ms_p50: 8,
                  duration_ms_p95: 21,
                },
              ],
          rowCount: 1,
        }
      },
    } as unknown as Db
    const window = resolveUsageStatsWindow(
      { bucket: 'hour', from: '2026-07-20T10:00:00Z', to: '2026-07-20T12:00:00Z', traffic_class: 'synthetic' },
      'http',
    )
    const result = await getHttpUsageStats(db, '11111111-1111-4111-8111-111111111111', window, {
      dropped_events: 0,
      retention_days: 90,
    })
    expect(result.schema_version).toBe('wikikit.usage-stats.v1')
    expect(result.buckets).toHaveLength(2)
    expect(result.buckets[0]!.metrics.success_ratio).toMatchObject({ numerator: 4, denominator: 5, value: 0.8 })
    expect(result.totals[0]!.metrics.unique_actors.value).toBe(3)
    expect(result.quality.unique_count_method).toBe('exact_window')
    expect(result.quality.content_captured).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.values).toEqual([
      '11111111-1111-4111-8111-111111111111',
      window.from,
      window.to,
      'hour',
      'http',
      'synthetic',
    ])
    for (const call of calls) {
      expect(call.sql).toContain('count(DISTINCT actor_hmac)')
      expect(call.sql).not.toMatch(/query_string|user_agent|ip_address|markdown|arguments|result_json/)
    }
  })

  test('global MCP stats deliberately omit a space predicate', async () => {
    const calls: string[] = []
    const db = {
      async query(sql: string) {
        calls.push(sql)
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Db
    const window = resolveUsageStatsWindow({ from: '2026-07-20T10:00:00Z', to: '2026-07-20T11:00:00Z' }, 'mcp')
    await getMcpUsageStats(db, window, { dropped_events: 0, retention_days: 90 })
    expect(calls).toHaveLength(2)
    expect(calls.every((sql) => !sql.includes('space_id ='))).toBe(true)
  })
})
