/**
 * The clock, as an external store.
 *
 * `Date.now()` read during render is impure: two renders of the same component
 * produce different output, which is the thing React's rules forbid and the
 * thing that makes an "expires in" countdown disagree with the relative
 * timestamp three columns to its left. The clock IS an external system, so it
 * is subscribed to like one — one tick, one shared snapshot, every reader
 * agreeing on what "now" is.
 *
 * That agreement is not academic here. The proposal queue prints how long a
 * change has been waiting for review next to the age of the source it came
 * from, and the ingest page prints an elapsed time next to a deadline; sampled
 * independently they drift apart by a render, and the same proposal can read as
 * two different ages within one paint.
 *
 * Three pages each carried their own private `useNow(intervalMs)` — three
 * `useState` + `setInterval` pairs, three unsynchronised clocks, three timers
 * per row-heavy page. This is the one they collapse into.
 *
 * Pure and environment-injected for the same reason `theme-store.ts` is: a
 * store whose whole job is scheduling has to be provable by a test runner that
 * owns the schedule.
 */

export type TimerHandle = number

/** The three facts this store needs from a runtime, named so a test can supply them. */
export interface ClockEnvironment {
  now(): number
  /** Begin ticking. Called on the FIRST subscriber, never at construction. */
  start(tick: () => void, intervalMs: number): TimerHandle
  stop(handle: TimerHandle): void
}

export interface ClockStore {
  subscribe(listener: () => void): () => void
  /** Identity-stable between ticks: `useSyncExternalStore` compares by reference. */
  snapshot(): number
}

export const CLOCK_TICK_MS = 1_000

export function createClockStore(env: ClockEnvironment, intervalMs: number = CLOCK_TICK_MS): ClockStore {
  const listeners = new Set<() => void>()
  let tick = env.now()
  // One interval for the tab, not one per component, and none at all while
  // nobody is watching: a console parked on a static page has no business
  // waking the event loop every second.
  let handle: TimerHandle | null = null

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (handle === null) {
        // Re-read the clock rather than accumulating the interval onto it: a
        // laptop that slept for an hour resumes with a `tick` an hour behind,
        // and every countdown on screen would be an hour wrong until it caught
        // up one second at a time.
        handle = env.start(() => {
          tick = env.now()
          for (const each of listeners) each()
        }, intervalMs)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && handle !== null) {
          env.stop(handle)
          handle = null
        }
      }
    },
    snapshot: () => tick,
  }
}
