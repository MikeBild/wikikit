import { createContext, useContext } from 'react'

/**
 * The sidebar's shared state, lifted out of `components/ui/sidebar.tsx`.
 *
 * The registry keeps the context and the hook in the same module as the
 * components, which `eslint-plugin-react-refresh` refuses: a module that exports
 * both a component and something else loses fast refresh, so every sidebar edit
 * would remount the whole console instead of hot-swapping. `components/ui/button.tsx`
 * carries the same rule for its variant table, and the answer there was the same
 * — move the non-component out rather than add an exception.
 */
export interface SidebarState {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

export const SidebarContext = createContext<SidebarState | null>(null)

export function useSidebar(): SidebarState {
  const context = useContext(SidebarContext)
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider.')
  return context
}

/**
 * Where the collapse is remembered — `wk-cockpit-`, like every other console
 * preference (`wk-cockpit-theme`, `wk-cockpit-space`, `wk-cockpit-view:*`).
 *
 * WHY localStorage and not the cookie the vendored component shipped: a cookie
 * on `path=/` is attached to every request this origin ever receives — every
 * /v1/* call the console makes and every /mcp call an agent makes through the
 * same browser — in order to carry a fact no server here has any use for. The
 * one thing that would justify that price is a server render deciding the
 * sidebar's first paint, and this console is a static bundle with no server
 * render in it. See `components/ui/sidebar.tsx` for the rest of that decision.
 */
export const SIDEBAR_STORAGE_KEY = 'wk-cockpit-sidebar'

/**
 * What the sidebar starts as: what was remembered, or the caller's default when
 * nothing was.
 *
 * The stored words are the same two the component puts in `data-state`, so the
 * value in devtools reads as the thing it controls rather than as a bare
 * `true`. An unrecognised value falls back to the default rather than throwing:
 * this key sits somewhere the reader can edit, and a console that refuses to
 * start because somebody typed into localStorage is a bad trade — the same call
 * `lib/theme-store.ts` makes for the theme key.
 */
export function resolveSidebarOpen(stored: string | null, defaultOpen: boolean): boolean {
  if (stored === 'collapsed') return false
  if (stored === 'expanded') return true
  return defaultOpen
}

/** The remembered collapse, or null when storage is empty or denied. */
export function readStoredSidebar(): string | null {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeSidebar(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, open ? 'expanded' : 'collapsed')
  } catch {
    // A browser with storage denied still drives the console fine — it just
    // opens with the sidebar expanded every time. Not a reason to fail.
  }
}
