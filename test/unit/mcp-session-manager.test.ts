// Session leasing (CONTRACTS §7, session-leasing learnings): idle-TTL sweep, hard cap
// with oldest-idle eviction, in-flight retain protection, bounded stream
// retains. All driven through the injectable clock — no real timers.
import { describe, expect, test } from 'bun:test'
import { createLogger } from '../../src/logger.ts'
import { createSessionManager, ownerKey, trackStreamLifetime, type McpSession } from '../../src/mcp/session-manager.ts'

const logger = createLogger({ level: 'error', write: () => {} })

function fakeSession(now: number, closed: { count: number }): McpSession {
  return {
    transport: {} as McpSession['transport'],
    server: {
      close: async () => {
        closed.count += 1
      },
    } as unknown as McpSession['server'],
    owner: 'k1:test',
    lastSeenAt: now,
    inFlight: 0,
  }
}

describe('createSessionManager', () => {
  test('tick evicts sessions idle past the TTL and closes their servers', () => {
    let now = 1_000_000
    const closed = { count: 0 }
    const manager = createSessionManager({ ttlMs: 1000, maxSessions: 10, logger, now: () => now })
    manager.sessions.set('old', fakeSession(now, closed))
    manager.sessions.set('fresh', fakeSession(now, closed))

    now += 500
    manager.sessions.get('fresh')!.lastSeenAt = now // touched recently
    now += 600 // 'old' is now 1100ms idle, 'fresh' 600ms
    manager.tick()

    expect(manager.sessions.has('old')).toBe(false)
    expect(manager.sessions.has('fresh')).toBe(true)
    expect(closed.count).toBe(1)
  })

  test('tick never evicts a session with in-flight work, however old', () => {
    let now = 0
    const closed = { count: 0 }
    const manager = createSessionManager({ ttlMs: 1000, maxSessions: 10, logger, now: () => now })
    const busy = fakeSession(now, closed)
    manager.sessions.set('busy', busy)
    manager.retain(busy)

    now += 100_000
    manager.tick()
    expect(manager.sessions.has('busy')).toBe(true)

    // Once released, the lease is dated from the release moment — it survives
    // until a full TTL passes from THEN.
    manager.release(busy)
    manager.tick()
    expect(manager.sessions.has('busy')).toBe(true)
    now += 1001
    manager.tick()
    expect(manager.sessions.has('busy')).toBe(false)
    expect(closed.count).toBe(1)
  })

  test('evictOverflow removes the oldest idle lease first', () => {
    let now = 0
    const closed = { count: 0 }
    const manager = createSessionManager({ ttlMs: 60_000, maxSessions: 2, logger, now: () => now })
    manager.sessions.set('a', fakeSession(10, closed))
    manager.sessions.set('b', fakeSession(20, closed))
    now = 30

    manager.evictOverflow() // making room for a third lease at cap 2
    expect(manager.sessions.has('a')).toBe(false) // oldest idle went first
    expect(manager.sessions.size).toBe(1)
  })

  test('evictOverflow admits over the cap when every lease is busy', () => {
    const closed = { count: 0 }
    const manager = createSessionManager({ ttlMs: 60_000, maxSessions: 1, logger, now: () => 100 })
    const busy = fakeSession(0, closed)
    manager.sessions.set('busy', busy)
    manager.retain(busy)

    manager.evictOverflow()
    // Severing live work is worse than briefly exceeding the cap.
    expect(manager.sessions.has('busy')).toBe(true)
    expect(closed.count).toBe(0)
  })

  test('retain/release pair keeps the counter balanced and never below zero', () => {
    const manager = createSessionManager({ ttlMs: 1000, maxSessions: 10, logger, now: () => 0 })
    const session = fakeSession(0, { count: 0 })
    manager.retain(session)
    manager.retain(session)
    expect(session.inFlight).toBe(2)
    manager.release(session)
    manager.release(session)
    manager.release(session) // extra release must not go negative
    expect(session.inFlight).toBe(0)
  })

  test('closeAll evicts everything (shutdown path)', () => {
    const closed = { count: 0 }
    const manager = createSessionManager({ ttlMs: 1000, maxSessions: 10, logger, now: () => 0 })
    manager.sessions.set('a', fakeSession(0, closed))
    manager.sessions.set('b', fakeSession(0, closed))
    manager.closeAll()
    expect(manager.sessions.size).toBe(0)
    expect(closed.count).toBe(2)
  })
})

describe('ownerKey', () => {
  test('binds the session to the credential — two keys never share an owner', () => {
    const a = ownerKey({ keyId: 'k1', scopes: ['knowledge:read'], spaceId: null, name: 'ci' })
    const b = ownerKey({ keyId: 'k2', scopes: ['knowledge:read'], spaceId: null, name: 'ci' })
    expect(a).not.toBe(b)
    expect(a).toBe(ownerKey({ keyId: 'k1', scopes: ['*'], spaceId: 'x', name: 'ci' }))
  })
})

describe('trackStreamLifetime', () => {
  function sourceStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
  }

  test('releases exactly once when the stream is fully consumed', async () => {
    let released = 0
    const tracked = trackStreamLifetime(
      sourceStream(['a', 'b']),
      { release: () => (released += 1), reacquire: () => {}, onForceReleased: () => {} },
      10_000,
    )
    const reader = tracked.getReader()
    while (!(await reader.read()).done) {
      /* drain */
    }
    expect(released).toBe(1)
  })

  test('releases exactly once when the consumer cancels', async () => {
    let released = 0
    const tracked = trackStreamLifetime(
      sourceStream(['a']),
      { release: () => (released += 1), reacquire: () => {}, onForceReleased: () => {} },
      10_000,
    )
    await tracked.cancel('done')
    expect(released).toBe(1)
  })

  test('a body nobody consumes is force-released after the grace window', async () => {
    let released = 0
    let forced = 0
    trackStreamLifetime(
      sourceStream(['a']),
      { release: () => (released += 1), reacquire: () => {}, onForceReleased: () => (forced += 1) },
      10, // tiny grace so the test stays fast
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(released).toBe(1)
    expect(forced).toBe(1)
  })

  test('a late first pull reacquires the retain and releases again at the end', async () => {
    let released = 0
    let reacquired = 0
    const tracked = trackStreamLifetime(
      sourceStream(['a']),
      { release: () => (released += 1), reacquire: () => (reacquired += 1), onForceReleased: () => {} },
      10,
    )
    await new Promise((resolve) => setTimeout(resolve, 40)) // grace fires first
    const reader = tracked.getReader()
    while (!(await reader.read()).done) {
      /* drain — stream turns out to be live */
    }
    expect(reacquired).toBe(1)
    expect(released).toBe(2) // force-release + terminal release, balanced with 1 reacquire
  })
})
