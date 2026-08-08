/**
 * The theme, as one store rather than one `useState` per caller.
 *
 * Two very different places read it: the chrome, which only needs a class on
 * `<html>`, and every hand-drawn SVG, which needs an actual colour because an
 * SVG attribute cannot carry a Tailwind class. With per-component state the
 * toggle updates only the component holding it — the console turns dark while
 * the sparklines keep their light strokes, and no re-render is ever requested
 * because the readers' copies of the theme never changed.
 *
 * No next-themes. The blocking script in index.html has already applied the
 * class before first paint, so this only has to keep it in step afterwards, and
 * a dependency that re-implements that on top of an effect would reintroduce
 * the flash it exists to prevent.
 *
 * WHY a factory and not a module-level singleton: this module is imported by
 * unit tests that run in a process with no `window`, no `localStorage` and no
 * `matchMedia`. A singleton built at import time is a module that cannot be
 * tested without a browser — and the browser is exactly what a snapshot store
 * has no business needing to prove it publishes the right snapshots.
 */
export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'wk-cockpit-theme'

export interface ThemeSnapshot {
  theme: Theme
  resolved: ResolvedTheme
}

/** The three browser facts the store needs, named so a test can supply them. */
export interface ThemeEnvironment {
  read(key: string): string | null
  write(key: string, value: string): void
  remove(key: string): void
  /** True when the OS asks for dark. */
  prefersDark(): boolean
  /** Called with every resolved theme, including the first. Applies the class. */
  apply(resolved: ResolvedTheme): void
  /** Subscribe to OS-level changes; returns an unsubscribe. */
  watchSystem?(onChange: () => void): () => void
  /**
   * Mirror an EXPLICIT choice where the server can read it.
   *
   * The auth funnel is server-rendered with a CSP that allows no script, so it
   * cannot read localStorage — but its stylesheet carries `.scheme-light` /
   * `.scheme-dark` override classes for exactly this. The cookie is how the
   * choice crosses the boundary: the server reads it and puts the class on
   * `<html>`, and an operator who chose dark stops meeting a white login page.
   *
   * Only `light` and `dark` are ever written. `system` is the absence of the
   * cookie, same as it is the absence of the localStorage key — for the
   * majority who never chose, `prefers-color-scheme` on the funnel IS their
   * preference, byte for byte.
   */
  writeCookie?(value: ResolvedTheme): void
  clearCookie?(): void
}

export interface ThemeStore {
  subscribe(listener: () => void): () => void
  /** Identity-stable: `useSyncExternalStore` compares snapshots by reference. */
  snapshot(): ThemeSnapshot
  set(theme: Theme): void
}

function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function createThemeStore(env: ThemeEnvironment): ThemeStore {
  function read(): ThemeSnapshot {
    const stored = env.read(THEME_STORAGE_KEY)
    // An unrecognised value falls back to `system` rather than throwing: this
    // key is in a place the user can edit, and a console that refuses to start
    // because somebody typed something into localStorage is a bad trade.
    const theme: Theme = isTheme(stored) ? stored : 'system'
    const resolved: ResolvedTheme = theme === 'system' ? (env.prefersDark() ? 'dark' : 'light') : theme
    return { theme, resolved }
  }

  let snapshot = read()
  const listeners = new Set<() => void>()

  function publish(): void {
    const next = read()
    // Reference equality is the contract useSyncExternalStore checks, so the
    // snapshot object is only replaced when something actually changed. Rebuild
    // it every read and every consumer re-renders on every unrelated event.
    if (next.theme === snapshot.theme && next.resolved === snapshot.resolved) return
    snapshot = next
    env.apply(snapshot.resolved)
    for (const listener of listeners) listener()
  }

  // `system` follows the OS for as long as the console is open, which outlives
  // every component, so the subscription belongs to the store and not to a hook.
  env.watchSystem?.(publish)

  // Reconcile the cookie with the stored choice ONCE, at construction. This is
  // what heals every operator who chose dark months before the cookie existed:
  // their localStorage says so, no cookie does, and without this line their
  // login page stays white until they touch the toggle again. It also heals a
  // hand-edited localStorage and a cookie cleared by a cautious browser.
  if (snapshot.theme === 'system') env.clearCookie?.()
  else env.writeCookie?.(snapshot.theme)

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => snapshot,
    set(theme) {
      // `system` is the absence of a choice, so it is stored as the absence of
      // a key. Writing the literal string 'system' would make "follow the OS"
      // indistinguishable from "was once explicitly set to whatever the OS said".
      // The cookie mirrors both halves: an explicit choice travels to the auth
      // funnel, and returning to `system` deletes it rather than storing a word
      // the server would then have to interpret.
      if (theme === 'system') {
        env.remove(THEME_STORAGE_KEY)
        env.clearCookie?.()
      } else {
        env.write(THEME_STORAGE_KEY, theme)
        env.writeCookie?.(theme)
      }
      publish()
    },
  }
}
