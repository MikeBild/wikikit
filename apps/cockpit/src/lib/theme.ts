import { useSyncExternalStore } from 'react'
import {
  createThemeStore,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type Theme,
  type ThemeEnvironment,
  type ThemeStore,
} from './theme-store'

/**
 * The browser half of the theme store: the DOM facts, and the React binding.
 *
 * Kept apart from theme-store.ts so the store itself stays a pure module the
 * repository's own test runner can exercise with no DOM at all.
 *
 * Every localStorage access is guarded — it throws outright in a tab where the
 * user has blocked site data, and a colour preference is not worth a blank
 * screen.
 */
function browserThemeEnvironment(): ThemeEnvironment {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  return {
    read: (key) => {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    },
    write: (key, value) => {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* private mode: the class still applies for this tab's lifetime */
      }
    },
    remove: (key) => {
      try {
        window.localStorage.removeItem(key)
      } catch {
        /* as above */
      }
    },
    prefersDark: () => media.matches,
    apply: (resolved) => document.documentElement.classList.toggle('dark', resolved === 'dark'),
    watchSystem: (onChange) => {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    },
    // The cookie shares the localStorage key's NAME on purpose: one string for
    // one concept, greppable across both storages.
    //
    // Deliberately NOT HttpOnly — this code is what writes it. Deliberately not
    // `__Host-` — that prefix requires Secure, which breaks the http dev
    // origin. Say that here so nobody later "hardens" it and silently kills
    // the feature.
    //
    // What that costs, stated honestly: anything that can set cookies for this
    // registrable domain can set this one, and the server parses it on every
    // HTML response in the sign-in funnel. It carries no authority — the worst
    // a chosen VALUE achieves is a dark login page — but a malformed one used
    // to throw in the parser and 500 the whole funnel. `cookieValue` in
    // src/oauth/server.ts now tolerates a value that will not decode; do not
    // remove that guard.
    writeCookie: (value) => {
      try {
        const secure = window.location.protocol === 'https:' ? '; Secure' : ''
        document.cookie = `${THEME_STORAGE_KEY}=${value}; Path=/; SameSite=Lax; Max-Age=31536000${secure}`
      } catch {
        /* a blocked cookie jar costs the funnel the preference, nothing else */
      }
    },
    clearCookie: () => {
      try {
        document.cookie = `${THEME_STORAGE_KEY}=; Path=/; SameSite=Lax; Max-Age=0`
      } catch {
        /* as above */
      }
    },
  }
}

// ONE store for the whole tab. Not a singleton out of laziness: the theme is
// read by the chrome (which needs a class) and by every hand-drawn SVG (which
// needs a colour, because an SVG attribute cannot carry a Tailwind class), and
// per-component state would leave the second group on the old theme forever.
const store: ThemeStore = createThemeStore(browserThemeEnvironment())

export { THEME_STORAGE_KEY }
export type { Theme, ResolvedTheme }

export function useTheme(): { theme: Theme; resolved: ResolvedTheme; setTheme: (theme: Theme) => void } {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  return { theme: snapshot.theme, resolved: snapshot.resolved, setTheme: store.set }
}
