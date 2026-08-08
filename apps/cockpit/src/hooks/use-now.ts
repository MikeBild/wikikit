import { useSyncExternalStore } from 'react'
import { createClockStore, type ClockStore } from '@/lib/clock-store'

/**
 * The browser half of the clock store, and the React binding.
 *
 * The store itself is in `lib/clock-store.ts` so it stays a pure module the
 * repository's own test runner can exercise with no DOM at all — the same split
 * as `lib/theme-store.ts` and `lib/theme.ts`, for the same reason.
 *
 * ONE store for the whole tab: every countdown, every age and every relative
 * label that reads this hook is reading the same integer, so two numbers on one
 * screen can never disagree about what time it is.
 */
const store: ClockStore = createClockStore({
  now: () => Date.now(),
  start: (tick, intervalMs) => window.setInterval(tick, intervalMs),
  stop: (handle) => window.clearInterval(handle),
})

/**
 * `Date.now()`, ticking once a second, safe to read during render.
 *
 * No interval parameter. The three private copies this replaces each took one
 * and each passed 1000; a per-caller interval is a per-caller clock, which is
 * precisely the disagreement this store exists to end. Something that needs a
 * coarser cadence than a second does not need a different clock — it needs to
 * re-render less, which is what `RelativeTime` does with its own unit-following
 * timer.
 */
export function useNow(): number {
  return useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    // Server snapshot: unused (this console never renders on a server) but
    // required by the signature. Returning the same value keeps it from
    // becoming a second, disagreeing clock if that ever changes.
    store.snapshot,
  )
}
