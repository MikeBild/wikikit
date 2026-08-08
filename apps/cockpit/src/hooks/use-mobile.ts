import { useSyncExternalStore } from 'react'

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * Is the viewport phone-sized?
 *
 * The registry ships this as `useState` + `useEffect` with a `setState` in the
 * effect body, which renders twice on every mount and starts life as
 * `undefined` — and `react-hooks/set-state-in-effect` is right to refuse it.
 *
 * A media query is an external store, which is what `useSyncExternalStore` is
 * for: it reads the current answer during render and subscribes for changes,
 * with no intermediate pass where the console believes it is on a desktop. The
 * console already uses this shape for the theme, for the same reason.
 *
 * The server snapshot is `false` because the console is client-rendered and this
 * is only ever reached in a browser; "not mobile" is the honest default for a
 * viewport that does not exist yet.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function snapshot(): boolean {
  return window.matchMedia(QUERY).matches
}

function serverSnapshot(): boolean {
  return false
}
