// MCP session leasing (CONTRACTS §7, plan §7) — a hard-won rule applied
// throughout: sessions are LEASES, not permanent allocations.
//
// The MCP Streamable HTTP spec has clients send `DELETE /mcp` when done, and
// almost none do. Every orphaned entry would pin an SDK Server + transport for
// the life of the process — an RSS leak seen in production. Three
// defenses, all here:
//
//   1. Idle-TTL sweeper (config.mcpSessionTtlMs, default 30 min): a lease
//      lives only as long as requests keep touching it.
//   2. Hard cap (config.mcpMaxSessions) with oldest-idle eviction: a client
//      that re-initializes on every call cannot outrun the sweeper.
//   3. In-flight retain counter: a session serving an open SSE stream is doing
//      work no matter how old its lastSeenAt is — evicting it would close the
//      transport under a live stream, so busy sessions are never victims.
//
// Owner binding (MCP Security Best Practices: sessions MUST NOT be used for
// authentication): the session captures `keyId:principal` at initialize; every
// later request on that session id must present the SAME credential — see
// ownerKey() and the 404 branch in server.ts.
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Logger } from '../logger.ts'
import type { Principal } from './tools.ts'

export const SESSION_SWEEP_INTERVAL_MS = 60_000

// A retain must be bounded like the lease it accounts against: an SSE body the
// runtime never attaches to a socket is never pulled and never cancelled, so
// its onClosed never fires and its retain would pin inFlight at 1 forever.
// A stream that produced nothing and was neither pulled nor cancelled inside
// this window is not in flight — real consumers issue their first pull in the
// same microtask the Response is returned in.
export const STREAM_RETAIN_START_GRACE_MS = 30_000

export interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport
  server: Server
  /** Credential identity captured at initialize — `keyId:name`. Requests on
   *  this session id from any OTHER credential are rejected (hijack guard). */
  owner: string
  /** Wall clock of the request that most recently started or finished here.
   *  Written by retain/release only — renewing from the sweeper would make an
   *  idle session immortal. */
  lastSeenAt: number
  /** Open units of work: requests inside handleRequest plus every SSE body
   *  they handed back. inFlight > 0 = not idle, never evicted. */
  inFlight: number
}

/**
 * Stable owner key for the credential that opened a session. Two distinct
 * keys — even with identical scopes — produce different owners, so a token
 * swap can never ride an existing session (CONTRACTS §7: owner =
 * keyId:principal, foreign token on a known session id → 404).
 */
export function ownerKey(principal: Principal): string {
  return `${principal.keyId}:${principal.name}`
}

export interface SessionManagerOptions {
  /** Idle TTL — config.mcpSessionTtlMs. */
  ttlMs: number
  /** Hard cap — config.mcpMaxSessions. */
  maxSessions: number
  logger: Logger
  /** Clock seam: tests install a fake and drive tick() deterministically. */
  now?: () => number
  sweepIntervalMs?: number
}

export interface SessionManager {
  readonly sessions: Map<string, McpSession>
  evict(sessionId: string, reason: 'idle_ttl' | 'capacity' | 'shutdown'): void
  /** One sweep pass — exposed so tests drive it without the real timer. */
  tick(): void
  startSweeper(): void
  stopSweeper(): void
  /** Make room for one more lease (oldest-idle first; busy leases are never
   *  victims — admit over cap rather than sever live work). */
  evictOverflow(): void
  /** Mark one unit of work started. Pair with exactly one release(). */
  retain(session: McpSession): void
  /** Mark one unit of work finished and date the lease from that moment. */
  release(session: McpSession): void
  /** Evict everything — process shutdown. */
  closeAll(): void
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const { ttlMs, maxSessions, logger } = options
  const now = options.now ?? Date.now
  const sweepIntervalMs = options.sweepIntervalMs ?? SESSION_SWEEP_INTERVAL_MS
  const sessions = new Map<string, McpSession>()
  let sweeper: ReturnType<typeof setInterval> | undefined

  // Drop the lease and close the server (which closes the transport). Closing
  // is fire-and-forget: the map entry is gone either way, and a client that
  // returns finds a 404 and re-initializes — routine churn, not a fault.
  function evict(sessionId: string, reason: 'idle_ttl' | 'capacity' | 'shutdown'): void {
    const session = sessions.get(sessionId)
    if (!session) return
    sessions.delete(sessionId)
    logger.info('mcp session evicted', {
      session_id: sessionId,
      reason,
      idle_ms: now() - session.lastSeenAt,
      sessions_open: sessions.size,
    })
    void session.server.close().catch((err: unknown) => {
      logger.warn('failed to close evicted mcp session', {
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  function stopSweeper(): void {
    if (!sweeper) return
    clearInterval(sweeper)
    sweeper = undefined
  }

  function retain(session: McpSession): void {
    session.inFlight += 1
    session.lastSeenAt = now()
  }

  function release(session: McpSession): void {
    if (session.inFlight > 0) session.inFlight -= 1
    // Date the lease from the moment work FINISHED: a stream that stayed open
    // for an hour has an hour-old lastSeenAt and would otherwise be swept the
    // instant it closed.
    session.lastSeenAt = now()
  }

  function tick(): void {
    const cutoff = now() - ttlMs
    for (const [sessionId, session] of sessions) {
      if (session.inFlight > 0) continue
      if (session.lastSeenAt <= cutoff) evict(sessionId, 'idle_ttl')
    }
    if (sessions.size === 0) stopSweeper()
  }

  // Armed on the first lease, disarmed with the last one, unref'd on top —
  // a process with no MCP traffic (and every unit test) never holds a timer.
  function startSweeper(): void {
    if (sweeper) return
    sweeper = setInterval(tick, sweepIntervalMs)
    ;(sweeper as unknown as { unref?: () => void }).unref?.()
  }

  function evictOverflow(): void {
    while (sessions.size >= maxSessions) {
      let oldestId: string | undefined
      let oldestSeenAt = Number.POSITIVE_INFINITY
      for (const [sessionId, session] of sessions) {
        if (session.inFlight > 0) continue
        if (session.lastSeenAt < oldestSeenAt) {
          oldestSeenAt = session.lastSeenAt
          oldestId = sessionId
        }
      }
      if (!oldestId) {
        // Every lease is busy. Admit over the cap rather than sever live work;
        // the sweeper reclaims them as their streams close.
        logger.warn('mcp session cap reached but every lease is busy — admitting over cap', {
          sessions_open: sessions.size,
        })
        return
      }
      evict(oldestId, 'capacity')
    }
  }

  function closeAll(): void {
    stopSweeper()
    for (const sessionId of [...sessions.keys()]) evict(sessionId, 'shutdown')
  }

  return { sessions, evict, tick, startSweeper, stopSweeper, evictOverflow, retain, release, closeAll }
}

// ---------------------------------------------------------------------------
// Stream retain tracking (hard-won rationale): handleRequest
// resolves the moment an SSE stream OPENS, not when it closes — entry-time
// bookkeeping alone would let the sweeper terminate a live notification
// stream 30 minutes in. The retain is handed to the body and released exactly
// once — on normal end, client cancel, or error. A body nobody ever pulls has
// none of those endings, so its retain is force-released after the grace
// window; a first pull arriving later takes the retain back (release and
// reacquire balance in every ordering).

export interface StreamRetain {
  /** Give the retain back — the stream ended, was cancelled, or never started. */
  release(): void
  /** Take the retain again after a force-release — the stream was live after all. */
  reacquire(): void
  /** The force-release fired: a body nobody pulled or cancelled. */
  onForceReleased(): void
}

export function trackStreamLifetime(
  body: ReadableStream<Uint8Array>,
  retain: StreamRetain,
  graceMs: number = STREAM_RETAIN_START_GRACE_MS,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let started = false
  let held = true
  let closed = false
  let grace: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    grace = undefined
    if (started || closed) return
    held = false
    retain.release()
    retain.onForceReleased()
  }, graceMs)
  ;(grace as unknown as { unref?: () => void }).unref?.()

  const disarm = (): void => {
    if (!grace) return
    clearTimeout(grace)
    grace = undefined
  }
  // First evidence the stream is alive — reclaims a force-released retain.
  const activate = (): void => {
    started = true
    disarm()
    if (held) return
    held = true
    retain.reacquire()
  }
  const finish = (): void => {
    if (closed) return
    closed = true
    disarm()
    if (!held) return
    held = false
    retain.release()
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        activate()
        try {
          const chunk = await reader.read()
          if (chunk.done) {
            finish()
            controller.close()
            return
          }
          controller.enqueue(chunk.value)
        } catch (err) {
          finish()
          controller.error(err)
        }
      },
      async cancel(reason) {
        finish()
        await reader.cancel(reason)
      },
    },
    // WHY highWaterMark 0: with the default HWM of 1 the runtime calls pull()
    // ONCE at construction to pre-fill the internal queue — before any
    // consumer exists — which would mark every body "started" and disarm the
    // grace timer, resurrecting exactly the latched-retain leak this wrapper
    // exists to prevent. At HWM 0 the first pull is a REAL read request.
    { highWaterMark: 0 },
  )
}
