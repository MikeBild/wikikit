// MCP Streamable HTTP server (CONTRACTS §7, plan §7) — mounted at /mcp,
// OUTSIDE the ROUTES registry and the OpenAPI surface, behind the same auth
// as REST.
//
// Architecture:
//   - ONE SDK Server per session, whose handlers close over the Principal
//     resolved at initialize — isolation by construction: no ambient auth
//     state, no cross-session leakage.
//   - Sessions are leases (see session-manager.ts): idle-TTL sweeper, hard cap
//     with oldest-idle eviction, in-flight retain counter.
//   - Owner binding: a known session id presented by a DIFFERENT credential
//     answers the SAME 404 as an unknown id — a leaked session id must not
//     even be confirmed to exist (session-hijack / confused-deputy guard).
//   - Unknown session id → HTTP 404 with JSON-RPC -32001, the spec's signal
//     for "re-run initialize" (routine client churn after a restart).
//   - Guards before auth: Origin allowlist (DNS-rebinding defense) and
//     mcp-protocol-version against the SDK's SUPPORTED_PROTOCOL_VERSIONS.
//
// WHY enableJsonResponse: true (a deliberate divergence from the usual MCP
// setup): keeping every POST on an SSE stream is only needed when tools raise
// mid-call elicitation (server→client requests need the originating POST's
// stream). WikiKit has NO in-band elicitation BY DESIGN — the hard-won rule
// is that approval elicitation gets ignored/auto-declined, so
// approval lives on REST and every tool answers terminally. Long work is an
// async-ack (wikikit_ingest → poll). With no server→client requests in a tool
// call, buffered JSON responses are strictly simpler and bound every POST's
// lifecycle. The standalone GET notification channel still streams and is
// retain-tracked.
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js'
import type { Config } from '../config.ts'
import { DomainError, UnauthorizedError } from '../domain/errors.ts'
import type { Auth } from '../http/auth.ts'
import { readDocsFile } from '../http/docs-embedded.ts'
import type { RawHandler } from '../http/server.ts'
import type { Logger } from '../logger.ts'
import { toToolError } from './error-adapter.ts'
import {
  createSessionManager,
  ownerKey,
  trackStreamLifetime,
  type McpSession,
  type SessionManager,
} from './session-manager.ts'
import { buildToolManifest, visibleTools, type Principal, type ToolDeps } from './tools.ts'

/**
 * The slice of src/http/auth.ts's Auth that MCP needs (CONTRACTS §5.4) —
 * authenticate only. Scope enforcement happens through tool VISIBILITY
 * (tools.ts), not requireScope: an out-of-scope tool simply does not exist
 * for the key. Pick keeps tests free to inject a one-method fake while the
 * production wiring passes the real Auth unchanged.
 */
export type McpAuth = Pick<Auth, 'authenticate'>

export interface McpDeps extends ToolDeps {
  auth: McpAuth
  logger: Logger
}

// ---------------------------------------------------------------------------
// Transport guards.

export type McpGuardResult =
  { ok: true } | { ok: false; reason: 'invalid_origin' | 'unsupported_protocol_version'; response: Response }

function jsonRpcHttpError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function originOf(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

/**
 * Origin allowlist built ONLY from configuration: the configured public URL
 * (the reverse-proxy hostname) plus fixed loopback hosts for local dev.
 * Deliberately NOT derived from the request's own Host header — in a DNS
 * rebinding attack the browser sends Origin and Host with the same rebound
 * hostname, so an allowlist containing `new URL(req.url).origin` would admit
 * exactly the attacker it exists to block (the guard would be a no-op).
 * Requests WITHOUT an Origin header pass — non-browser MCP clients (Claude
 * Code, SDK clients) never send one; the header is only meaningful as a
 * DNS-rebinding tell when a browser adds it.
 */
const LOOPBACK_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function validateMcpRequest(req: Request, config: Config): McpGuardResult {
  const origin = req.headers.get('origin')
  if (origin !== null) {
    const parsed = originOf(origin)
    const publicOrigin = originOf(config.publicUrl)
    let hostname = ''
    try {
      hostname = parsed ? new URL(parsed).hostname : ''
    } catch {
      hostname = ''
    }
    const isLoopback = LOOPBACK_ORIGIN_HOSTS.has(hostname) || hostname === '::1'
    if (!parsed || (parsed !== publicOrigin && !isLoopback)) {
      return {
        ok: false,
        reason: 'invalid_origin',
        response: jsonRpcHttpError(403, -32000, 'Forbidden: invalid Origin header'),
      }
    }
  }

  const protocolVersion = req.headers.get('mcp-protocol-version')
  if (protocolVersion !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return {
      ok: false,
      reason: 'unsupported_protocol_version',
      response: jsonRpcHttpError(400, -32000, `Bad Request: Unsupported protocol version: ${protocolVersion}`),
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------

/** 12-hex request id — same discipline as the HTTP surface (§5.2 note). */
function newRequestId(): string {
  return randomBytes(6).toString('hex')
}

/**
 * Server-level usage hints, returned by `initialize`. This is the one place an
 * MCP client learns the SHAPE of the workflow before calling anything — the
 * tool descriptions can only speak for one tool each, and a pure-MCP agent
 * cannot reach the REST docs. Deliberately short: the detail lives in the
 * `docs` resources below.
 */
const INSTRUCTIONS = `WikiKit is a curated knowledge base: sources are archived verbatim, an LLM synthesizes concept pages whose every claim carries a verbatim quote from a source, and nothing becomes visible knowledge without human approval.

Reading: wikikit_search finds raw evidence, wikikit_read fetches a full concept page, wikikit_sources/wikikit_decisions/wikikit_history explain where something came from. These never invent — if the answer is not in the base, say so rather than filling the gap.

Writing: wikikit_ingest (a document) and wikikit_propose (a direct change) both stage a ChangeProposal and return immediately; poll wikikit_ingest_status for ingest. A principal with knowledge:approve can use wikikit_proposals to inspect the full diff, then wikikit_review_proposal to explicitly approve or reject it. The review tool is an irreversible confirmed write: never call it without a human’s explicit decision. Do not tell the user their change is live until approval succeeds.

Only the tools your API key's scopes allow are listed. Read the "wikikit://docs/llms.txt" resource for the full API and data model.`

/** Documentation exposed to MCP clients — the same files the REST surface serves. */
const DOC_RESOURCES = [
  {
    uri: 'wikikit://docs/llms.txt',
    name: 'WikiKit documentation index',
    description: 'Index of the WikiKit docs: endpoints, MCP tools, auth, and what to read next.',
    file: 'llms.txt',
  },
  {
    uri: 'wikikit://docs/llms-full.txt',
    name: 'WikiKit full documentation',
    description: 'Complete API and data-model documentation in one file: endpoints, schemas, errors, config.',
    file: 'llms-full.txt',
  },
] as const

/**
 * One SDK Server per session, closing over the principal. tools/list is
 * scope-FILTERED (visibility gating): a knowledge:read key does not see the
 * write tools at all, and calling an invisible tool is indistinguishable from
 * calling a nonexistent one (no scope oracle).
 *
 * Resources carry the documentation: WikiKit embeds its own docs (the binary is
 * self-contained), but they used to be reachable only over HTTP GET — a
 * pure-MCP client saw the tool list and nothing else. The docs are public
 * anyway (`GET /llms.txt` needs no auth), so they are not scope-gated here.
 */
export function createSessionServer(config: Config, deps: McpDeps, principal: Principal): Server {
  const server = new Server(
    { name: 'wikikit', version: config.version },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: buildToolManifest(principal.scopes),
  }))

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: DOC_RESOURCES.filter((resource) => readDocsFile(config, resource.file) !== null).map(
      ({ uri, name, description }) => ({ uri, name, description, mimeType: 'text/plain' }),
    ),
  }))

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const resource = DOC_RESOURCES.find((candidate) => candidate.uri === request.params.uri)
    const text = resource ? readDocsFile(config, resource.file) : null
    if (!text) {
      throw new DomainError('not_found', `unknown resource: ${request.params.uri}`, 404, {
        nextBestActions: ['call resources/list to see the documentation this server exposes'],
      })
    }
    return { contents: [{ uri: resource!.uri, mimeType: 'text/plain', text }] }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const requestId = newRequestId()
    const name = request.params.name
    const tool = visibleTools(principal.scopes).find((candidate) => candidate.name === name)
    if (!tool) {
      // Deliberately NOT a JSON-RPC method error: the envelope carries
      // next_best_actions so the agent pivots to tools/list instead of
      // retrying a name it hallucinated (or lacks the scope for).
      return toToolError(
        new DomainError('not_found', `unknown tool: ${name}`, 404, {
          nextBestActions: ['call tools/list to see the tools available to this key'],
        }),
        requestId,
      )
    }
    try {
      // Tools re-parse through their own zod schema inside execute — the
      // boundary rule holds even if a future caller bypasses dispatch.
      const output = await tool.execute(deps, principal, request.params.arguments ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(output) }] }
    } catch (error) {
      // Terminal envelope for the agent; full detail in the log keyed by
      // request_id (the envelope never leaks internals — §8.2).
      deps.logger.warn('mcp tool call failed', {
        tool: name,
        request_id: requestId,
        key_id: principal.keyId,
        code: error instanceof DomainError ? error.code : 'internal_error',
        error: error instanceof Error ? error.message : String(error),
      })
      return toToolError(error, requestId)
    }
  })

  return server
}

// ---------------------------------------------------------------------------

export interface McpMount {
  /**
   * Web-standard raw handler for ALL /mcp methods (POST/GET/DELETE) — what
   * src/app.ts registers via its raw-handler hook (mountRawHandler): /mcp is
   * intentionally outside the ROUTES registry and the OpenAPI surface.
   */
  handler(req: Request): Promise<Response>
  /** Exposed for tests and /metrics-style introspection. */
  sessions: SessionManager
  /** Graceful shutdown: stop the sweeper, close every live session. */
  stop(): void
}

function sessionNotFound(): Response {
  // Same body for "unknown id" and "foreign credential on a known id": do not
  // disclose that a session id exists to a caller that does not own it.
  return jsonRpcHttpError(404, -32001, 'Session not found')
}

function errorEnvelopeResponse(error: DomainError, requestId: string, config?: Config): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-request-id': requestId }
  if (error instanceof UnauthorizedError) {
    headers['www-authenticate'] = config?.publicUrl
      ? `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource", scope="knowledge:read knowledge:propose"`
      : 'Bearer scope="knowledge:read knowledge:propose"'
  }
  return new Response(
    JSON.stringify({
      error: error.message,
      code: error.code,
      request_id: requestId,
      next_best_actions: error.nextBestActions,
      ...error.details,
    }),
    { status: error.statusCode, headers },
  )
}

function isEventStream(response: Response): boolean {
  return response.headers.get('content-type')?.includes('text/event-stream') ?? false
}

export function createMcpMount(config: Config, deps: McpDeps): McpMount {
  const logger = deps.logger
  const manager = createSessionManager({
    ttlMs: config.mcpSessionTtlMs,
    maxSessions: config.mcpMaxSessions,
    logger,
  })

  async function handler(req: Request): Promise<Response> {
    const guarded = validateMcpRequest(req, config)
    if (!guarded.ok) {
      logger.debug('mcp request rejected by transport guard', { reason: guarded.reason })
      return guarded.response
    }

    // Same credential surface as REST: Bearer or X-API-Key (§1.10). Auth
    // failures answer the §8.1 envelope — terminal for the client, and the
    // request never reaches a transport.
    let principal: Principal
    try {
      const headerValue = req.headers.get('authorization') ?? req.headers.get('x-api-key') ?? undefined
      principal = await deps.auth.authenticate(headerValue)
    } catch (error) {
      const requestId = newRequestId()
      const domainError = error instanceof DomainError ? error : new UnauthorizedError('authentication failed')
      logger.debug('mcp request unauthorized', { request_id: requestId })
      return errorEnvelopeResponse(domainError, requestId, config)
    }

    const sessionHeader = req.headers.get('mcp-session-id')
    let session: McpSession | undefined

    if (sessionHeader) {
      session = manager.sessions.get(sessionHeader)
      if (!session) {
        // Engine restart dropped the map, or the lease was swept. Per the
        // Streamable HTTP spec: 404 so the client re-runs initialize —
        // routine churn, log at debug.
        logger.debug('unknown mcp session id — client should re-initialize', {
          session_id: sessionHeader,
          key_id: principal.keyId,
        })
        return sessionNotFound()
      }
      if (session.owner !== ownerKey(principal)) {
        // A valid but DIFFERENT credential presenting a known session id would
        // otherwise execute inside the owner's server instance (its handlers
        // close over the owner's principal). Reject with the same 404 as the
        // unknown-session branch — do not confirm the id exists.
        logger.warn('mcp session id presented by a different principal — rejecting', {
          session_id: sessionHeader,
          key_id: principal.keyId,
        })
        return sessionNotFound()
      }
    }

    // A fresh transport only earns a lease once initialize completes; until
    // then nothing owns its server, so this request must close it (finally).
    let freshSession = false
    let registered = false

    if (!session) {
      freshSession = true
      const server = createSessionServer(config, deps, principal)
      // Holder filled before server.connect — the SDK invokes
      // onsessioninitialized from inside handleRequest, long after this.
      const leaseRef: { current?: McpSession } = {}
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // See header WHY — no in-band elicitation, so buffered JSON is safe.
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          if (!leaseRef.current) {
            // Unreachable given the SDK's call order; fail closed (the
            // request's finally closes the orphaned server) rather than
            // registering a half-built lease.
            logger.warn('mcp session initialized before its lease existed — refusing to register', {
              session_id: sid,
            })
            return
          }
          registered = true
          manager.evictOverflow()
          manager.sessions.set(sid, leaseRef.current)
          manager.startSweeper()
          logger.info('mcp session initialized', {
            session_id: sid,
            key_id: principal.keyId,
            sessions_open: manager.sessions.size,
          })
        },
        onsessionclosed: (sid) => {
          // Client sent DELETE /mcp. The SDK closes the transport right after
          // this callback, so the map delete is all this owes.
          manager.sessions.delete(sid)
          if (manager.sessions.size === 0) manager.stopSweeper()
          logger.info('mcp session closed', { session_id: sid, sessions_open: manager.sessions.size })
        },
      })
      transport.onerror = (err: Error) => {
        // A request that skipped the handshake self-rejects with "Server not
        // initialized" — recoverable client churn, not a fault.
        if (err.message === 'Bad Request: Server not initialized') {
          logger.debug('mcp request before initialize — client should re-initialize', { key_id: principal.keyId })
          return
        }
        logger.warn('mcp transport error', { error: err.message })
      }
      leaseRef.current = { transport, server, owner: ownerKey(principal), lastSeenAt: Date.now(), inFlight: 0 }
      await server.connect(transport)
      session = leaseRef.current
    }

    // Standalone GET SSE stream: the SDK permits exactly ONE per session and
    // 409s a second. A client re-opening its notification channel after a
    // network blip (before the server saw the old socket die) must REPLACE
    // the stale stream, not get an unrecoverable Conflict (the hard-won rule:
    // last-writer-wins reconnection).
    if (req.method === 'GET') {
      session.transport.closeStandaloneSSEStream()
    }

    // Retain for this request; if the reply is an SSE body the retain is
    // handed to that body for a bounded lifetime (see trackStreamLifetime),
    // otherwise released here. handleRequest resolves when a stream OPENS,
    // not when it closes — entry-time bookkeeping alone would let the sweeper
    // kill a live notification stream mid-flight.
    const active = session
    manager.retain(active)
    let streamed = false

    try {
      const response = await active.transport.handleRequest(req)
      const body = response.body
      if (!body || !isEventStream(response)) return response
      streamed = true
      return new Response(
        trackStreamLifetime(body, {
          release: () => manager.release(active),
          reacquire: () => manager.retain(active),
          onForceReleased: () =>
            logger.warn('mcp sse body never consumed within the retain grace — releasing its lease retain', {
              session_id: active.transport.sessionId ?? null,
              key_id: principal.keyId,
            }),
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      )
    } finally {
      if (!streamed) manager.release(active)
      // The SDK awaits onsessioninitialized inside handleRequest, so
      // `registered` is authoritative by now: a fresh transport that never
      // completed the handshake holds no lease and never will — close its
      // server here or it leaks for the life of the process. Eviction only
      // touches registered sessions, so this cannot double-close.
      if (freshSession && !registered) {
        void active.server.close().catch((err: unknown) => {
          logger.warn('failed to close mcp transport that never initialized', {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    }
  }

  return {
    handler,
    sessions: manager,
    stop: () => manager.closeAll(),
  }
}

// ---------------------------------------------------------------------------

/** Sentinel for the capped body read below — maps to the §8 413 envelope. */
class McpBodyTooLarge extends Error {}

// Buffered body read with the same hard byte cap discipline as the REST
// reader (src/http/server.ts readBody): raw mounts bypass that reader, so
// without this the MCP transport would be an unbounded-memory path for the
// very same operations REST caps at WIKIKIT_MAX_BODY_BYTES (413).
function readCappedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      received += chunk.length
      if (received > maxBytes) {
        done = true
        req.pause()
        reject(new McpBodyTooLarge(`request body exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (!done) reject(error)
    })
  })
}

/**
 * Bridge to the node:http surface: src/http/server.ts mounts raw handlers as
 * `(IncomingMessage, ServerResponse)`, while the WebStandard transport wants
 * `(Request) => Response`. The composition root wires MCP with exactly:
 *
 *   const mcp = createMcpMount(config, { config, db, ingest, auth, logger })
 *   app.mountRawHandler('/mcp', toNodeRawHandler(mcp, { maxBodyBytes: config.maxBodyBytes }))
 *
 * Request bodies are BUFFERED (capped, above) rather than streamed: every MCP
 * POST body is a JSON-RPC message the transport parses whole anyway, and only
 * buffering lets the cap answer a clean 413 body_too_large envelope before
 * the SDK sees a byte. Responses stay streaming-aware: the standalone GET
 * notification channel is a long-lived SSE body, so chunks are written as
 * they arrive and a client disconnect cancels the web stream (releasing its
 * lease retain — see trackStreamLifetime) instead of pumping into a dead
 * socket.
 */
export function toNodeRawHandler(mount: McpMount, options: { maxBodyBytes?: number } = {}): RawHandler {
  // Default mirrors the WIKIKIT_MAX_BODY_BYTES default so a wiring that
  // forgets the option is still capped, never unbounded.
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET'
    const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/mcp'}`
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) for (const entry of value) headers.append(name, entry)
      else headers.set(name, value)
    }

    const hasBody = method !== 'GET' && method !== 'HEAD'
    let body: Buffer | undefined
    if (hasBody) {
      try {
        body = await readCappedBody(req, maxBodyBytes)
      } catch (error) {
        if (error instanceof McpBodyTooLarge) {
          const requestId = newRequestId()
          res.statusCode = 413
          res.setHeader('content-type', 'application/json')
          res.setHeader('x-request-id', requestId)
          res.end(
            JSON.stringify({
              error: error.message,
              code: 'body_too_large',
              request_id: requestId,
              next_best_actions: ['split the payload', 'raise WIKIKIT_MAX_BODY_BYTES if this size is intentional'],
            }),
          )
          req.destroy()
          return
        }
        throw error
      }
    }
    // Framing headers describe the ORIGINAL stream; the runtime re-frames the
    // buffered body itself.
    headers.delete('content-length')
    headers.delete('transfer-encoding')
    const request = new Request(url, {
      method,
      headers,
      ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
    } as RequestInit)

    const response = await mount.handler(request)
    res.statusCode = response.status
    response.headers.forEach((value, name) => res.setHeader(name, value))
    if (!response.body) {
      res.end()
      return
    }

    const reader = response.body.getReader()
    // A vanished client must cancel the source stream, or an SSE body keeps
    // its retain and the session becomes unevictable until the grace fires.
    res.once('close', () => void reader.cancel().catch(() => {}))
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.writable) break
        res.write(value)
      }
    } catch {
      // Reader cancelled or socket error — either way the response is over.
    } finally {
      res.end()
    }
  }
}
