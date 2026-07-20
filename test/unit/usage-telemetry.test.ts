import { describe, expect, test } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from '../../src/config.ts'
import type { Db } from '../../src/db/postgres.ts'
import type { Logger } from '../../src/logger.ts'
import { createUsageTelemetry, markUsageContext, markUsagePrincipal } from '../../src/usage.ts'

const logger = { warn() {} } as unknown as Logger
const config = {
  usageTelemetryEnabled: true,
  usageHmacSecret: 'wikikit-local-product-secret',
  usageRetentionDays: 90,
} as Config

function response(statusCode = 200, responseBytes = '42'): ServerResponse {
  return {
    statusCode,
    getHeader(name: string) {
      return name === 'content-length' ? responseBytes : undefined
    },
  } as unknown as ServerResponse
}

describe('privacy-safe usage telemetry', () => {
  test('stores bounded HTTP dimensions and product-local HMAC identities, never raw headers', async () => {
    const writes: Record<string, unknown>[] = []
    const db = {
      async insert(_table: string, row: Record<string, unknown>) {
        writes.push(row)
        return []
      },
    } as unknown as Db
    const usage = createUsageTelemetry(config, db, logger)
    const req = {
      method: 'GET',
      headers: {
        'content-length': '12',
        authorization: 'Bearer raw-secret',
        'user-agent': 'never-stored',
        'x-wikikit-traffic-class': 'synthetic',
        'x-wikikit-request-source': 'manual',
        'x-wikikit-session-id': 'raw-session',
      },
    } as unknown as IncomingMessage
    markUsagePrincipal(req, { keyId: 'raw-key-id', name: 'reader', scopes: ['knowledge:read'], spaceId: null })
    markUsageContext(req, { spaceId: '11111111-1111-4111-8111-111111111111' })
    await usage.recordHttp(req, response(), { route: '/v1/spaces/{space}/search', durationMs: 8 })

    expect(writes).toHaveLength(2) // http + semantic knowledge projection
    expect(writes[0]!.traffic_class).toBe('synthetic')
    expect(writes[0]!.request_source).toBe('manual')
    expect(writes[0]!.actor_hmac).toMatch(/^[0-9a-f]{64}$/)
    expect(writes[0]!.session_hmac).toMatch(/^[0-9a-f]{64}$/)
    expect(writes[1]!.surface).toBe('knowledge')
    expect(writes[1]!.operation).toBe('search')
    expect(JSON.stringify(writes)).not.toMatch(/raw-secret|raw-session|raw-key-id|never-stored/)
  })

  test('never fingerprints anonymous HTTP and classifies reporting as internal', async () => {
    const writes: Record<string, unknown>[] = []
    const usage = createUsageTelemetry(
      config,
      {
        async insert(_table: string, row: Record<string, unknown>) {
          writes.push(row)
          return []
        },
      } as unknown as Db,
      logger,
    )
    const req = {
      method: 'GET',
      headers: { 'x-wikikit-session-id': 'untrusted', 'x-wikikit-traffic-class': 'synthetic' },
    } as unknown as IncomingMessage
    markUsageContext(req, { spaceId: '11111111-1111-4111-8111-111111111111' })
    await usage.recordHttp(req, response(), { route: '/v1/spaces/{space}/stats/http', durationMs: 1 })
    expect(writes[0]!.traffic_class).toBe('internal')
    expect(writes[0]!.actor_hmac).toBeNull()
    expect(writes[0]!.session_hmac).toBeNull()
  })

  test('MCP stores only a registered tool name and resolves space without storing its slug', async () => {
    const writes: Record<string, unknown>[] = []
    const db = {
      async query() {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 }
      },
      async insert(_table: string, row: Record<string, unknown>) {
        writes.push(row)
        return []
      },
    } as unknown as Db
    const usage = createUsageTelemetry(config, db, logger)
    await usage.recordMcp({
      operation: 'tool_call',
      toolName: 'wikikit_search',
      spaceSlug: 'private-customer-space',
      sessionId: 'raw-mcp-session',
      principal: { keyId: 'raw-key-id', name: 'reader', scopes: ['knowledge:read'], spaceId: null },
      durationMs: 4,
    })
    expect(writes).toHaveLength(2)
    expect(writes[0]!.surface).toBe('mcp')
    expect(writes[1]!.surface).toBe('knowledge')
    expect(JSON.stringify(writes)).not.toMatch(/private-customer-space|raw-mcp-session|raw-key-id/)
  })

  test('disabled mode is a no-op and retention cleanup is parameterized', async () => {
    let inserted = false
    const disabled = createUsageTelemetry(
      { ...config, usageTelemetryEnabled: false },
      {
        async insert() {
          inserted = true
          return []
        },
      } as unknown as Db,
      logger,
    )
    await disabled.recordMcp({ operation: 'tools_list' })
    expect(inserted).toBe(false)

    const calls: { sql: string; values?: unknown[] }[] = []
    const enabled = createUsageTelemetry(
      config,
      {
        async query(sql: string, values?: unknown[]) {
          calls.push({ sql, values })
          return { rows: [{ deleted: 3 }], rowCount: 1 }
        },
      } as unknown as Db,
      logger,
    )
    expect(await enabled.cleanup()).toBe(3)
    expect(calls[0]!.values).toEqual([90])
    expect(calls[0]!.sql).toContain('DELETE FROM wk_usage_events')
  })
})
