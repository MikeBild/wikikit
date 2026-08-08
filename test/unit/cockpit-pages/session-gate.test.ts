// What keeps a single open tab signed in, and what the gate shows while it
// tries.
//
// The defect behind this file: 0.24.0 made `GET /v1/session` re-stamp the
// operator cookie with the session row's real deadline, so a browser's copy
// keeps up with the row. The console then read that endpoint once, when the
// bundle mounted. A reload, a second tab and a cold start were covered; a
// reviewer with ONE tab open, navigating client-side for a working day, was
// signed out eight hours after sign-in exactly as before — the case the
// re-stamping was built for.
//
// Both rules are pure, and both matter for a reason no assertion about the
// server can reach: the cadence is a number that has to sit between two other
// numbers (the server's idle window above, the console's polling below), and
// the branch order decides whether a single failed renewal throws an operator
// out of a session that is still valid.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveSessionView,
  SESSION_REFRESH_INTERVAL_MS,
  SESSION_STALE_MS,
  sessionRefreshOptions,
} from '../../../apps/cockpit/src/components/session-gate.logic.ts'
import { LIVE_INTERVAL_MS } from '../../../apps/cockpit/src/lib/live.ts'
import { createQueryClient } from '../../../apps/cockpit/src/lib/query.ts'

const root = process.cwd()

/**
 * The server's idle window, read out of the SQL that slides the session rather
 * than typed in here.
 *
 * A test that restated `8 hours` would keep passing after somebody shortened
 * the window to twenty minutes, which is the single change most likely to make
 * this cadence wrong. The literal it looks for is the one in the renewing
 * UPDATE — `least(absolute_expires_at, now() + interval '8 hours')` — because
 * that is the value the cookie's Max-Age is derived from and therefore the
 * deadline the console is racing.
 */
function serverIdleWindowMs(): number {
  const source = readFileSync(join(root, 'src', 'oauth', 'server.ts'), 'utf8')
  const match = /least\(absolute_expires_at, now\(\) \+ interval '(\d+) hours'\)/.exec(source)
  if (!match?.[1]) throw new Error('the renewing UPDATE no longer states its idle window as an hours interval')
  return Number(match[1]) * 60 * 60 * 1000
}

describe('how often a tab renews its session', () => {
  test('many renewals fit inside the window the server actually slides', () => {
    // Not "smaller than" — comfortably smaller. The margin is what absorbs a
    // suspended laptop, a throttled timer and a run of failed reads without the
    // operator ever seeing a sign-in page they did not ask for.
    const window = serverIdleWindowMs()
    expect(SESSION_REFRESH_INTERVAL_MS * 12).toBeLessThanOrEqual(window)
  })

  test('and it is nowhere near a poll', () => {
    // The console's live reads tick every three seconds while an ingest is
    // running. Renewal is the opposite kind of read: nothing about it is
    // watched, so it is held two orders of magnitude away from the cadence a
    // reader would call polling. Compared against the real constant so that
    // making live reads slower can never quietly make this one look fast.
    expect(SESSION_REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(LIVE_INTERVAL_MS * 100)
  })

  test('a hidden tab does not renew itself', () => {
    // The decision this pins is a security property, not an optimisation.
    // TanStack fires an interval only while the document is visible unless this
    // flag is set — `lib/live.ts` sets it, on purpose, so leaving it off here
    // has to be deliberate. A minimized tab that renewed every ten minutes
    // would turn the eight-hour IDLE window into the 24-hour absolute cap for
    // every operator who never closes a tab: an unattended session that outlives
    // its deadline because a background timer attended it.
    expect(sessionRefreshOptions.refetchIntervalInBackground).toBe(false)
  })

  test('coming back to a hidden tab renews it, against the console default', () => {
    // The other half. A tab hidden for hours fires no interval by the rule
    // above, so returning to it has to be what asks — otherwise the case the
    // interval declines to cover is covered by nothing.
    expect(sessionRefreshOptions.refetchOnWindowFocus).toBe(true)
    // And it is an OVERRIDE. Stated against the real client rather than against
    // a comment: if the global default is ever turned on, this option stops
    // being a decision and the reasoning written next to it stops being true.
    expect(createQueryClient().getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false)
  })

  test('the focus renewal is debounced, but not past a scheduled one', () => {
    // A refetch on focus fires only for a stale query, so `staleTime` is what
    // stops an operator alt-tabbing between the console and their editor from
    // sending a read per switch. It has to stay well under the interval, or the
    // freshness rule would start suppressing the scheduled renewal itself.
    expect(SESSION_STALE_MS).toBeGreaterThan(0)
    expect(SESSION_STALE_MS).toBeLessThan(SESSION_REFRESH_INTERVAL_MS)
    expect(sessionRefreshOptions.staleTime).toBe(SESSION_STALE_MS)
    expect(sessionRefreshOptions.refetchInterval).toBe(SESSION_REFRESH_INTERVAL_MS)
  })
})

describe('what the gate shows for a given read', () => {
  const session = { name: 'mike@example.com' }

  test('nothing yet, and nothing wrong, is checking', () => {
    expect(resolveSessionView({ data: undefined, failed: false })).toBe('checking')
  })

  test('nothing yet, and the attempt failed, is unreachable', () => {
    // First load with the server down: the failure is the whole story, and
    // there is nothing else to show.
    expect(resolveSessionView({ data: undefined, failed: true })).toBe('unreachable')
  })

  test('a session is the console', () => {
    expect(resolveSessionView({ data: session, failed: false })).toBe('ready')
  })

  test('a failed RENEWAL does not evict a session that is still good', () => {
    // The regression this ordering exists to prevent, and the one the periodic
    // read above made reachable for the first time. TanStack keeps `data` and
    // sets `status: 'error'` when a background refetch fails, so a gate that
    // checked the error first would answer one proxy hiccup by replacing the
    // whole console with "Could not reach WikiKit" — unmounting the router and
    // taking every unsubmitted edit with it — over a session the server never
    // stopped honouring.
    expect(resolveSessionView({ data: session, failed: true })).toBe('ready')
  })

  test('a session that genuinely ended still signs the console out', () => {
    // The other side of the same rule, and the one that must not be traded away
    // to get the one above: `null` is the endpoint's ANSWER, not a failure, and
    // it is what arrives when the idle window or the 24-hour absolute cap has
    // passed. It wins immediately, from whatever the operator was looking at.
    expect(resolveSessionView({ data: null, failed: false })).toBe('signed-out')
    expect(resolveSessionView({ data: null, failed: true })).toBe('signed-out')
  })
})

describe('the gate uses these rules rather than its own', () => {
  // Both rules are exported, which means both could be tested here and neither
  // wired up. The gate is JSX and cannot be imported into test/unit — the
  // compiler has no DOM here — so its source is read instead. Coarse on
  // purpose: this proves the wiring exists, not what it does.
  const gate = readFileSync(join(root, 'apps', 'cockpit', 'src', 'components', 'session-gate.tsx'), 'utf8')

  test('the session query spreads the renewal policy', () => {
    expect(gate).toContain('...sessionRefreshOptions')
  })

  test('and the view comes from the rule, not from a second copy of it', () => {
    expect(gate).toContain('resolveSessionView(')
    // A hand-written cadence next to the shared one is two policies, and the
    // one this file tests would be the one that is not in force.
    expect(gate).not.toContain('refetchInterval:')
    expect(gate).not.toContain('staleTime:')
  })
})
