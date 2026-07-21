import { createHmac } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from './config.ts'
import type { Db } from './db/postgres.ts'
import type { Principal } from './http/auth.ts'
import type { Logger } from './logger.ts'

export type TrafficClass = 'organic' | 'synthetic' | 'internal'
export type RequestSource = 'api' | 'gateway' | 'scheduler' | 'manual' | 'mcp'
export type UsageSurface = 'http' | 'mcp' | 'knowledge' | 'review'
export type UsageOutcome =
  'success' | 'client_error' | 'server_error' | 'rejected' | 'timeout' | 'cancelled' | 'handoff'

interface UsageContext {
  spaceId?: string
  actorId?: string
  sessionId?: string
  requestSource?: RequestSource
}

export interface UsageQuality {
  sampled: false
  dropped_events: number
  retention_days: number
}

export interface UsageTelemetry {
  readonly enabled: boolean
  recordHttp(req: IncomingMessage, res: ServerResponse, input: { route: string; durationMs: number }): Promise<boolean>
  recordMcp(input: {
    operation: string
    principal?: Principal
    sessionId?: string | null
    spaceSlug?: string | null
    toolName?: string | null
    outcome?: UsageOutcome
    durationMs?: number
    responseMode?: 'json' | 'sse' | 'none'
    activeSessions?: number
    resultCount?: number
    trafficClass?: TrafficClass
  }): Promise<boolean>
  cleanup(): Promise<number>
  quality(): UsageQuality
  start(): void
  stop(): void
}

const contexts = new WeakMap<IncomingMessage, UsageContext>()
const TRAFFIC_CLASSES = new Set<TrafficClass>(['organic', 'synthetic', 'internal'])
const REQUEST_SOURCES = new Set<RequestSource>(['api', 'gateway', 'scheduler', 'manual', 'mcp'])
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

function bounded(value: unknown, max: number): string | null {
  if (value == null) return null
  const text = String(value)
  return text.length > 0 && text.length <= max ? text : null
}

function integer(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function statusOutcome(status: number): UsageOutcome {
  if (status >= 500) return 'server_error'
  if (status >= 400) return 'client_error'
  return 'success'
}

function isInternalRoute(route: string): boolean {
  return /^(?:\/health|\/ready|\/metrics|\/openapi\.json|\/llms(?:-full)?\.txt|\/v1\/stats\/|\/v1\/spaces\/(?:\{space\}|:space)\/stats\/)/.test(
    route,
  )
}

function classifiedOperation(
  route: string,
  method: string,
): { surface: 'knowledge' | 'review'; operation: string } | null {
  const key = `${method} ${route}`
  const exact: Record<string, { surface: 'knowledge' | 'review'; operation: string }> = {
    'GET /v1/spaces/{space}/search': { surface: 'knowledge', operation: 'search' },
    'POST /v1/spaces/{space}/query': { surface: 'knowledge', operation: 'query' },
    'GET /v1/spaces/{space}/concepts/{slug}': { surface: 'knowledge', operation: 'read_concept' },
    'GET /v1/spaces/{space}/decisions/{slug}': { surface: 'knowledge', operation: 'read_decision' },
    'GET /v1/spaces/{space}/sources/{id}': { surface: 'knowledge', operation: 'read_source' },
    'GET /v1/spaces/{space}/lint': { surface: 'knowledge', operation: 'lint' },
    'POST /v1/spaces/{space}/ingest': { surface: 'knowledge', operation: 'ingest' },
    'POST /v1/spaces/{space}/ingest/document': { surface: 'knowledge', operation: 'ingest_document' },
    'POST /v1/spaces/{space}/proposals': { surface: 'knowledge', operation: 'propose' },
    'GET /v1/spaces/{space}/proposals': { surface: 'review', operation: 'list_proposals' },
    'GET /v1/proposals/{id}': { surface: 'review', operation: 'inspect_proposal' },
    'POST /v1/proposals/{id}/approve': { surface: 'review', operation: 'approve' },
    'POST /v1/proposals/{id}/reject': { surface: 'review', operation: 'reject' },
  }
  return exact[key] ?? null
}

function mcpKnowledgeOperation(toolName: string | null): { surface: 'knowledge' | 'review'; operation: string } | null {
  if (!toolName) return null
  const name = toolName.replace(/^wikikit_/, '')
  if (name === 'review_proposal' || name === 'proposals') return { surface: 'review', operation: name }
  if (
    [
      'search',
      'read',
      'sources',
      'decisions',
      'history',
      'lint',
      'query',
      'ingest',
      'ingest_status',
      'propose',
    ].includes(name)
  ) {
    return { surface: 'knowledge', operation: name }
  }
  return null
}

export function markUsageContext(req: IncomingMessage, input: UsageContext): UsageContext {
  const next = { ...(contexts.get(req) ?? {}), ...input }
  contexts.set(req, next)
  return next
}

export function markUsagePrincipal(req: IncomingMessage, principal: Principal): UsageContext {
  return markUsageContext(req, {
    actorId: `principal:${principal.keyId}`,
    ...(principal.spaceId ? { spaceId: principal.spaceId } : {}),
  })
}

export function createUsageTelemetry(config: Config, db: Db, logger: Logger): UsageTelemetry {
  const enabled = config.usageTelemetryEnabled === true
  const secret = config.usageHmacSecret ?? ''
  const retentionDays = config.usageRetentionDays ?? 90
  let cleanupTimer: ReturnType<typeof setInterval> | undefined
  let dropped = 0

  const hash = (kind: 'actor' | 'session', value?: string | null): string | null =>
    value && secret ? createHmac('sha256', secret).update(`${kind}:${value}`).digest('hex') : null

  async function write(input: Record<string, unknown>): Promise<boolean> {
    if (!enabled) return false
    try {
      await db.insert('wk_usage_events', input, { returning: false })
      return true
    } catch (error) {
      dropped += 1
      logger.warn('usage telemetry write failed', {
        surface: input.surface,
        operation: input.operation,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  function headers(req: IncomingMessage, authenticated: boolean, route: string, context: UsageContext) {
    const declaredTraffic = bounded(req.headers['x-wikikit-traffic-class'], 16) as TrafficClass | null
    const declaredSource = bounded(req.headers['x-wikikit-request-source'], 16) as RequestSource | null
    const trafficClass: TrafficClass = isInternalRoute(route)
      ? 'internal'
      : authenticated && declaredTraffic && TRAFFIC_CLASSES.has(declaredTraffic)
        ? declaredTraffic
        : 'organic'
    const requestSource: RequestSource =
      context.requestSource && REQUEST_SOURCES.has(context.requestSource)
        ? context.requestSource
        : authenticated && declaredSource && REQUEST_SOURCES.has(declaredSource)
          ? declaredSource
          : 'api'
    const sessionId = authenticated ? bounded(req.headers['x-wikikit-session-id'], 200) : null
    return { trafficClass, requestSource, sessionId }
  }

  async function recordHttp(
    req: IncomingMessage,
    res: ServerResponse,
    input: { route: string; durationMs: number },
  ): Promise<boolean> {
    if (!enabled) return false
    const context = contexts.get(req) ?? {}
    const authenticated = Boolean(context.actorId)
    const declared = headers(req, authenticated, input.route, context)
    const base = {
      space_id: context.spaceId ?? null,
      route: bounded(input.route, 200),
      method: METHODS.has(req.method ?? '') ? req.method : null,
      status_code: res.statusCode,
      outcome: statusOutcome(res.statusCode),
      traffic_class: declared.trafficClass,
      request_source: declared.requestSource,
      actor_hmac: hash('actor', context.actorId),
      session_hmac: hash('session', context.sessionId ?? declared.sessionId),
      duration_ms: integer(input.durationMs) ?? 0,
      request_bytes: integer(req.headers['content-length']),
      response_bytes: integer(res.getHeader('content-length')),
      result_count: null,
      tool_name: null,
      response_mode: null,
      active_sessions: null,
    }
    const saved = await write({ ...base, surface: 'http', operation: 'request' })
    const classified = classifiedOperation(input.route, req.method ?? 'GET')
    if (classified && context.spaceId) {
      await write({ ...base, surface: classified.surface, operation: classified.operation })
    }
    return saved
  }

  async function resolveSpaceId(slug?: string | null): Promise<string | null> {
    if (!slug) return null
    try {
      const { rows } = await db.query<{ id: string }>('SELECT id FROM wk_spaces WHERE slug = $1 LIMIT 1', [slug])
      return rows[0]?.id ?? null
    } catch {
      return null
    }
  }

  async function recordMcp(input: Parameters<UsageTelemetry['recordMcp']>[0]): Promise<boolean> {
    if (!enabled) return false
    const spaceId = await resolveSpaceId(input.spaceSlug)
    const trafficClass = input.trafficClass && TRAFFIC_CLASSES.has(input.trafficClass) ? input.trafficClass : 'organic'
    const base = {
      space_id: spaceId,
      route: '/mcp',
      method: null,
      status_code: null,
      outcome: input.outcome ?? 'success',
      traffic_class: trafficClass,
      request_source: 'mcp',
      actor_hmac: hash('actor', input.principal ? `principal:${input.principal.keyId}` : null),
      session_hmac: hash('session', input.sessionId),
      duration_ms: integer(input.durationMs) ?? 0,
      request_bytes: null,
      response_bytes: null,
      result_count: integer(input.resultCount),
      tool_name: bounded(input.toolName, 80),
      response_mode: input.responseMode ?? null,
      active_sessions: integer(input.activeSessions),
    }
    const saved = await write({ ...base, surface: 'mcp', operation: bounded(input.operation, 80) ?? 'request' })
    const classified = mcpKnowledgeOperation(base.tool_name)
    if (classified && spaceId) await write({ ...base, surface: classified.surface, operation: classified.operation })
    return saved
  }

  async function cleanup(): Promise<number> {
    if (!enabled) return 0
    try {
      const { rows } = await db.query<{ deleted: number }>(
        `WITH deleted AS (
           DELETE FROM wk_usage_events
            WHERE created_at < now() - ($1::int * interval '1 day')
            RETURNING 1
         ) SELECT count(*)::int AS deleted FROM deleted`,
        [retentionDays],
      )
      return Number(rows[0]?.deleted ?? 0)
    } catch (error) {
      logger.warn('usage telemetry retention cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return 0
    }
  }

  return {
    enabled,
    recordHttp,
    recordMcp,
    cleanup,
    quality: () => ({ sampled: false, dropped_events: dropped, retention_days: retentionDays }),
    start() {
      if (!enabled || cleanupTimer) return
      void cleanup()
      cleanupTimer = setInterval(() => void cleanup(), 60 * 60 * 1000)
      cleanupTimer.unref?.()
    },
    stop() {
      if (cleanupTimer) clearInterval(cleanupTimer)
      cleanupTimer = undefined
    },
  }
}
