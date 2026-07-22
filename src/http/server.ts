// node:http server — request lifecycle for the ROUTES registry.
//
// Per-request pipeline (WikiKit contracts):
//   request-id → drain gate → raw mounts (/mcp) → route match → auth
//   (401/403) → body read (size-capped) → zod validation (params/query/body)
//   → handler → JSON/text response — with every failure mapped to the §8.1
//   error envelope carrying the same x-request-id as the response header.
//
// WHY no web framework (house rule): the surface is ~30 routes with template
// paths; a compiled regex table + this file IS the framework, auditable in
// one read, zero dependencies to bundle into the single binary.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { DomainError, PayloadTooLargeError, ValidationError } from '../domain/errors.ts'
import type { Principal } from './auth.ts'
import { HANDLERS, ROUTES, type HttpDeps, type RouteDef } from './routes.ts'
import { SCHEMAS } from './schemas.ts'
import { ZodError } from 'zod'
import { createTraceContext } from '../trace-context.ts'
import { markUsagePrincipal } from '../usage.ts'

/** Raw mount hook: src/mcp attaches its Streamable-HTTP transport at POST/GET/DELETE /mcp via this. */
export type RawHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export interface HttpServer {
  server: Server
  /**
   * Mount a raw handler at an exact pathname (all methods), matched BEFORE
   * the ROUTES table. Deliberately outside the registry/OpenAPI surface —
   * this is how POST /mcp attaches without becoming a REST route (§5.2).
   */
  mountRawHandler(path: string, handler: RawHandler): void
  /** The request listener, exposed for in-process testing without a socket. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

interface CompiledRoute {
  def: RouteDef
  regex: RegExp
  paramNames: string[]
}

// '/v1/spaces/{space}/concepts/{slug}' → ^/v1/spaces/(?<space>[^/]+)/concepts/(?<slug>[^/]+)$
function compileRoute(def: RouteDef): CompiledRoute {
  const paramNames: string[] = []
  const pattern = def.path
    .split('/')
    .map((segment) => {
      const match = segment.match(/^\{(\w+)\}$/)
      if (!match) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      paramNames.push(match[1]!)
      return '([^/]+)'
    })
    .join('/')
  return { def, regex: new RegExp(`^${pattern}$`), paramNames }
}

// Buffered body read with a hard byte cap. The cap aborts the read mid-stream
// (destroying the request) instead of buffering first and checking later — a
// 250 MiB upload against a 10 MiB limit must not cost 250 MiB of memory.
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > maxBytes) {
        req.destroy()
        reject(new PayloadTooLargeError(`request body exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', (error) => reject(error))
  })
}

interface ErrorShape {
  status: number
  payload: Record<string, unknown>
}

/**
 * Any thrown value → (status, §8.1 envelope). Recognizes DomainError
 * (statusCode/code/nextBestActions/details), the llm module's error classes
 * (status/code/next_best_actions — structurally, no import), zod errors
 * (400 bad_request with issue details), everything else → 500 internal_error
 * with a NON-leaking message.
 */
export function toErrorPayload(error: unknown, requestId: string): ErrorShape {
  if (error instanceof DomainError) {
    return {
      status: error.statusCode,
      payload: {
        error: error.message,
        code: error.code,
        request_id: requestId,
        ...(error.nextBestActions.length ? { next_best_actions: error.nextBestActions } : {}),
        ...error.details,
      },
    }
  }
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
    return {
      status: 400,
      payload: { error: `validation failed: ${issues}`, code: 'bad_request', request_id: requestId },
    }
  }
  // Structural match for the llm error classes (LlmNotConfiguredError etc.)
  // and any future typed error following the {status, code} convention.
  const shaped = error as { status?: unknown; code?: unknown; message?: unknown; next_best_actions?: unknown }
  if (
    typeof shaped.status === 'number' &&
    shaped.status >= 400 &&
    shaped.status < 600 &&
    typeof shaped.code === 'string'
  ) {
    return {
      status: shaped.status,
      payload: {
        error: String(shaped.message ?? shaped.code),
        code: shaped.code,
        request_id: requestId,
        ...(Array.isArray(shaped.next_best_actions) ? { next_best_actions: shaped.next_best_actions } : {}),
      },
    }
  }
  return {
    status: 500,
    payload: { error: 'internal error', code: 'internal_error', request_id: requestId },
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  })
  res.end(text)
}

export function createHttpServer(deps: HttpDeps): HttpServer {
  const compiled = ROUTES.map(compileRoute)
  const rawMounts = new Map<string, RawHandler>()

  function matchRoute(method: string, pathname: string): { def: RouteDef; params: Record<string, string> } | null {
    for (const route of compiled) {
      if (route.def.method !== method.toLowerCase()) continue
      const match = route.regex.exec(pathname)
      if (!match) continue
      const params: Record<string, string> = {}
      route.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1]!)
      })
      return { def: route.def, params }
    }
    return null
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal')
    const pathname = url.pathname

    // Raw mounts run before everything else (drain excepted): the MCP
    // transport owns its own protocol including errors and sessions.
    const raw = rawMounts.get(pathname)
    if (raw) {
      await raw(req, res)
      return
    }

    const matched = matchRoute(req.method ?? 'GET', pathname)
    if (!matched) {
      sendJson(res, 404, { error: `no route for ${req.method} ${pathname}`, code: 'not_found', request_id: requestId })
      return
    }
    const { def, params } = matched

    // Drain gate: probes stay up so the LB/deploy gate can observe the drain;
    // everything else refuses fast (§8.2 'draining').
    if (deps.state.draining && !['/health', '/ready', '/metrics'].includes(pathname)) {
      sendJson(res, 503, { error: 'server is draining', code: 'draining', request_id: requestId })
      return
    }

    // Auth: route-level scope check. Space-level narrowing happens inside the
    // handler once the {space} slug is resolved to an id (routes.ts).
    let principal: Principal | null = null
    if (def.scope) {
      const header =
        (req.headers.authorization as string | undefined) ?? (req.headers['x-api-key'] as string | undefined)
      principal = await deps.auth.authenticate(header)
      deps.auth.requireScope(principal, def.altScopes ? [def.scope, ...def.altScopes] : def.scope)
      markUsagePrincipal(req, principal)
    }

    // Validation, in request order: params → query → body. Schema names come
    // from the registry; a bad name is a boot-time bug surfaced by the drift
    // tests, so the non-null assertion here is safe by construction.
    let validatedParams: Record<string, string> = params
    if (def.request?.params) {
      validatedParams = SCHEMAS[def.request.params]!.parse(params) as Record<string, string>
    }
    let validatedQuery: Record<string, unknown> = {}
    if (def.request?.query) {
      validatedQuery = SCHEMAS[def.request.query]!.parse(Object.fromEntries(url.searchParams)) as Record<
        string,
        unknown
      >
    }

    let body: unknown
    if (def.rawBody) {
      body = new Uint8Array(await readBody(req, deps.config.maxBodyBytes))
    } else if (def.request?.body) {
      const buffer = await readBody(req, deps.config.maxBodyBytes)
      let parsed: unknown
      if (buffer.length === 0) {
        parsed = undefined // schemas with .default({}) accept an empty body
      } else {
        try {
          parsed = JSON.parse(buffer.toString('utf8'))
        } catch {
          throw new ValidationError('request body is not valid JSON')
        }
      }
      body = SCHEMAS[def.request.body]!.parse(parsed)
    }

    const handler = HANDLERS[def.handler]
    if (!handler) throw new Error(`route ${def.method} ${def.path} references unknown handler ${def.handler}`)
    const result = await handler(deps, {
      requestId,
      principal,
      params: validatedParams,
      query: validatedQuery,
      body,
      req,
      res,
    })
    if (!result) return // handler streamed/ended the response itself
    if (result.text !== undefined) {
      res.writeHead(result.status, { 'content-type': 'text/plain; charset=utf-8', ...result.headers })
      res.end(result.text)
      return
    }
    sendJson(res, result.status, result.body, result.headers)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 12-hex request id (§5.2) — response header, envelope field and log
    // correlation key are all the same value.
    const requestId = randomBytes(6).toString('hex')
    const started = Date.now()
    const trace = createTraceContext(req.headers.traceparent as string | undefined)
    res.setHeader('x-request-id', requestId)
    res.setHeader('traceparent', trace.traceparent)
    res.on('finish', () => {
      const pathname = (req.url ?? '/').split('?')[0]!
      // Metrics label = the ROUTE TEMPLATE, never the raw URL (bounded
      // cardinality); unmatched paths collapse into one bucket.
      const route =
        matchRoute(req.method ?? 'GET', pathname)?.def.path ?? (rawMounts.has(pathname) ? pathname : '(unmatched)')
      deps.metrics.httpRequest(req.method ?? 'GET', route, res.statusCode, Date.now() - started)
      void deps.usage.recordHttp(req, res, { route, durationMs: Date.now() - started })
      deps.logger.info('request', {
        'event.name': 'http.server.request',
        request_id: requestId,
        trace_id: trace.traceId,
        span_id: trace.spanId,
        parent_span_id: trace.parentSpanId,
        method: req.method,
        path: route,
        status: res.statusCode,
        ms: Date.now() - started,
      })
    })
    try {
      await dispatch(req, res, requestId)
    } catch (error) {
      const { status, payload } = toErrorPayload(error, requestId)
      if (status >= 500) {
        deps.logger.error('request failed', {
          request_id: requestId,
          trace_id: trace.traceId,
          span_id: trace.spanId,
          parent_span_id: trace.parentSpanId,
          status,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
      }
      if (!res.headersSent) sendJson(res, status, payload)
      else res.end()
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res)
  })
  // Keep-alive sockets must not pin a draining process forever; 5s is the
  // node default region and well under the deploy gate's 90s window.
  server.keepAliveTimeout = 5000

  return {
    server,
    handle,
    mountRawHandler(path, handler) {
      if (rawMounts.has(path)) throw new Error(`raw handler already mounted at ${path}`)
      rawMounts.set(path, handler)
    },
  }
}
