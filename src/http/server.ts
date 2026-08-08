// node:http server — request lifecycle for the ROUTES registry.
//
// Per-request pipeline, in the order dispatch() actually runs it:
//   request-id → raw exact mounts (/mcp plus the OAuth/session plane app.ts
//   registers) → raw prefix mounts (/cockpit), each answered or refused by the
//   drain policy it was mounted with → route match (no match → 404) → drain
//   gate (503 'draining') → auth (401/403) → body read (size-capped) → zod
//   validation (params/query/body) → handler → JSON/text response — with every
//   failure mapped to the §8.1 error envelope carrying the same x-request-id
//   as the response header.
//
// One consequence of that order reads backwards from what one expects, so it
// is stated here rather than discovered: the drain gate sits AFTER matchRoute,
// so a path matching no route answers 404 while draining, not 503. Why that is
// right is argued at the code that causes it.
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

/**
 * A raw mount's refusal while `state.draining` is set — written in the mount's
 * OWN wire format, which is the whole reason this is a function and not a
 * shared response. The request id is passed in because it is the same value
 * already on the `x-request-id` header, and a refusal that carries it can be
 * correlated with the log line the finish hook writes.
 */
export type DrainRefusal = (req: IncomingMessage, res: ServerResponse, requestId: string) => void | Promise<void>

/**
 * What a raw mount does once the process is draining: `'serve'` keeps
 * answering, anything else is the refusal to answer with instead.
 *
 * Deliberately a REQUIRED argument on both mount methods rather than an option
 * with a default. Raw mounts sit ahead of the ROUTES drain gate and can never
 * reach it, so whatever the default were, it would be a drain decision made
 * silently for every mount somebody adds later — and the two mounts that
 * existed when this was written wanted opposite answers.
 */
export type DrainPolicy = 'serve' | DrainRefusal

export interface HttpServer {
  server: Server
  /**
   * Mount a raw handler at an exact pathname (all methods), matched BEFORE
   * the ROUTES table. Deliberately outside the registry/OpenAPI surface —
   * this is how POST /mcp attaches without becoming a REST route (§5.2).
   */
  mountRawHandler(path: string, handler: RawHandler, whileDraining: DrainPolicy): void
  /**
   * Mount a raw handler for every pathname under a prefix, matched AFTER the
   * exact mounts and BEFORE the ROUTES table. This is how the cockpit's static
   * plane attaches: a built SPA is thousands of fingerprinted filenames plus a
   * client-side router, so it cannot be enumerated as exact paths, and it must
   * stay off the OpenAPI surface for the same reason /mcp does.
   */
  mountRawPrefix(prefix: string, handler: RawHandler, whileDraining: DrainPolicy): void
  /** The request listener, exposed for in-process testing without a socket. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

interface RawMount {
  handler: RawHandler
  whileDraining: DrainPolicy
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

/**
 * The §8.2 `draining` envelope, exported so a raw mount whose wire format IS
 * ordinary JSON can be refused with the same bytes a matched REST route is —
 * one definition of the refusal, not a second copy in the composition root.
 * A mount that speaks another protocol (JSON-RPC, say) passes its own.
 */
export const refuseWithDrainingEnvelope: DrainRefusal = (_req, res, requestId) => {
  sendJson(res, 503, { error: 'server is draining', code: 'draining', request_id: requestId })
}

export function createHttpServer(deps: HttpDeps): HttpServer {
  const compiled = ROUTES.map(compileRoute)
  const rawMounts = new Map<string, RawMount>()
  const prefixMounts: ({ prefix: string } & RawMount)[] = []

  /** '/cockpit' matches '/cockpit' and '/cockpit/…' — never '/cockpitfoo'. */
  function matchPrefix(pathname: string): ({ prefix: string } & RawMount) | undefined {
    return prefixMounts.find(({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  }

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

  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    label: { route: string },
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal')
    const pathname = url.pathname

    // Raw mounts run before everything else, the ROUTES drain gate included:
    // that gate is further down, past matchRoute, and a request answered here
    // never reaches it. So each raw mount carries its OWN drain policy,
    // declared where it is wired in app.ts and applied here.
    //
    // WHY per-mount and not one rule for all of them — two reasons, and each
    // alone would be enough:
    //
    // They do not share a wire format. An MCP client reads the body of a /mcp
    // response as a JSON-RPC message; handed this file's HTTP error envelope
    // it reports a parse error — "the server is broken" — which is the one
    // thing a refusal must not say, because a client that thinks the server is
    // broken does not retry, it gives up. Only the mount knows what a refusal
    // sounds like in its own protocol, so only the mount can supply one.
    //
    // And they do not share an answer. Refusing the console would cost an
    // operator the one screen that shows them the drain they are watching;
    // refusing a token mint costs its caller a retry it was going to make
    // anyway. The argument for each mount's choice lives next to that mount in
    // app.ts, where the thing being mounted is in view.
    const raw = rawMounts.get(pathname)
    if (raw) {
      label.route = pathname
      if (deps.state.draining && raw.whileDraining !== 'serve') {
        await raw.whileDraining(req, res, requestId)
        return
      }
      await raw.handler(req, res)
      return
    }

    // Prefix mounts run next: the cockpit owns every path under /cockpit,
    // including the ones its client-side router invents.
    const prefixed = matchPrefix(pathname)
    if (prefixed) {
      label.route = prefixed.prefix
      if (deps.state.draining && prefixed.whileDraining !== 'serve') {
        await prefixed.whileDraining(req, res, requestId)
        return
      }
      await prefixed.handler(req, res)
      return
    }

    const matched = matchRoute(req.method ?? 'GET', pathname)
    if (!matched) {
      sendJson(res, 404, { error: `no route for ${req.method} ${pathname}`, code: 'not_found', request_id: requestId })
      return
    }
    const { def, params } = matched
    label.route = def.path

    // Drain gate: probes stay up so the LB/deploy gate can observe the drain;
    // every other MATCHED route refuses fast (§8.2 'draining').
    //
    // Placed after matchRoute, which means an unknown path 404s while draining
    // instead of 503-ing. That is the truthful answer for it: the path does
    // not exist on this build and will not exist on the next one either, so a
    // 503 would invite a caller to retry something that can never succeed.
    // Only a route that does exist has a meaningful "come back later".
    //
    // For whoever reads /metrics during a deploy: a drain REFUSAL is
    // attributable — it is status="503" against the refusing route's own label
    // (the template here; '/mcp' or '/v1/oauth/token' for a raw mount), next
    // to route="/ready" status="503", which is the drain itself. The 404 above
    // is not, and deliberately so: nothing was refused, the same request would
    // have 404ed a minute earlier, and the two are the same event. Drain volume
    // is therefore the 503 series and never a delta in the '(unmatched)'
    // bucket — which stays flat through a drain precisely because it should.
    if (deps.state.draining && !['/health', '/ready', '/metrics'].includes(pathname)) {
      refuseWithDrainingEnvelope(req, res, requestId)
      return
    }

    // Auth: route-level scope check. Space-level narrowing happens inside the
    // handler once the {space} slug is resolved to an id (routes.ts).
    let principal: Principal | null = null
    if (def.scope) {
      const header =
        (req.headers.authorization as string | undefined) ?? (req.headers['x-api-key'] as string | undefined)
      // The cookie plane is a FALLBACK, never an override: a request that
      // carries a header credential is authenticated by that credential and
      // fails exactly as it always has. Only a headerless request — which is
      // what the cockpit sends, having no token to put in one — is offered the
      // browser session. Unsafe methods additionally require a same-origin
      // Origin, because SameSite=Lax does not cover them all on its own.
      const method = (req.method ?? 'GET').toUpperCase()
      const safeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
      const session = header ? null : await deps.sessionAuth?.authenticateSession(req, !safeMethod)
      principal = session ?? (await deps.auth.authenticate(header))
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
    // Metrics/usage/log label = the ROUTE TEMPLATE, or a raw mount's path or
    // prefix — never the raw URL, so cardinality stays bounded. dispatch()
    // WRITES it the moment it knows; the finish hook only reads it.
    //
    // It used to be recomputed here by re-running matchRoute over
    // `req.url.split('?')[0]`, which was a second regex scan per request and,
    // worse, a second opinion about what the path was: dispatch resolves
    // `new URL(req.url, 'http://internal').pathname`, which collapses dot
    // segments and accepts the absolute-form request line a proxy may send,
    // while a bare split does neither — so a request dispatch answered as
    // /v1/spaces/{space} could be counted, logged and billed as '(unmatched)'.
    // Carrying the value the decision was actually made with is the only way
    // the two cannot disagree. It also keeps the drain policy in one place:
    // the finish hook no longer has to know which mounts refuse.
    //
    // '(unmatched)' is the starting value and stays the answer when no raw
    // mount, no prefix and no route claimed the path — including when the URL
    // was malformed enough that dispatch threw before deciding anything.
    const label = { route: '(unmatched)' }
    res.on('finish', () => {
      const durationMs = Date.now() - started
      deps.metrics.httpRequest(req.method ?? 'GET', label.route, res.statusCode, durationMs)
      void deps.usage.recordHttp(req, res, { route: label.route, durationMs })
      deps.logger.info('request', {
        'event.name': 'http.server.request',
        request_id: requestId,
        trace_id: trace.traceId,
        span_id: trace.spanId,
        parent_span_id: trace.parentSpanId,
        method: req.method,
        path: label.route,
        status: res.statusCode,
        ms: durationMs,
      })
    })
    try {
      await dispatch(req, res, requestId, label)
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
    mountRawHandler(path, handler, whileDraining) {
      if (rawMounts.has(path)) throw new Error(`raw handler already mounted at ${path}`)
      rawMounts.set(path, { handler, whileDraining })
    },
    mountRawPrefix(prefix, handler, whileDraining) {
      if (prefixMounts.some((mount) => mount.prefix === prefix)) {
        throw new Error(`raw prefix handler already mounted at ${prefix}`)
      }
      prefixMounts.push({ prefix, handler, whileDraining })
    },
  }
}
