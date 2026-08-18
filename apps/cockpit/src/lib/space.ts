import { createContext, useContext } from 'react'

/**
 * Which wiki the console is looking at.
 *
 * A space IS a wiki. Everything the reader sees — pages, changes, sources,
 * decisions, the charter — belongs to exactly one, so the choice is not a
 * filter on a page but the address of the page itself. That is why it lives in
 * the URL as `?space=<slug>` and not in a store: a link somebody pastes into
 * chat has to open the same wiki for the person who receives it, and a
 * screenshot of a page has to be traceable to the wiki it came from.
 *
 * localStorage holds an OPENING GUESS and nothing more — where to start when
 * the URL says nothing. It is never consulted once the URL has an answer, so a
 * stale stored slug can never override a link.
 *
 * The rule and the context live here, with no JSX; the provider that reads the
 * router is `components/space-provider.tsx`. Same split as `lib/theme.ts` and
 * for the same two reasons: a module that exports both a component and a
 * function loses fast refresh, and a rule should not need a browser to prove it
 * behaves.
 */
export const SPACE_STORAGE_KEY = 'wk-cockpit-space'

export interface SpaceOption {
  slug: string
  name: string
  environment: 'production' | 'test'
}

export function sortSpaceOptions(options: readonly SpaceOption[]): SpaceOption[] {
  return [...options].sort((left, right) =>
    left.environment === right.environment
      ? left.slug.localeCompare(right.slug)
      : left.environment === 'production'
        ? -1
        : 1,
  )
}

export interface SpaceValue {
  /** The chosen wiki, or null before the space list has resolved. */
  space: string | null
  /** Display metadata for the current wiki and links back to the overview. */
  options: readonly SpaceOption[]
}

export const SpaceContext = createContext<SpaceValue | null>(null)

export function readStoredSpace(): string | null {
  try {
    return localStorage.getItem(SPACE_STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeSpace(slug: string): void {
  try {
    localStorage.setItem(SPACE_STORAGE_KEY, slug)
  } catch {
    // A browser with storage denied still navigates fine — it just opens on
    // the first wiki every time. Not a reason to fail.
  }
}

/**
 * Resolve which wiki to show, given what the URL says, what was stored and what
 * exists. Pure, and exported so a unit test can cover the precedence without a
 * router.
 *
 * Precedence: the URL, then the stored guess, then the first available wiki.
 * A slug that names a wiki this credential cannot see is ignored rather than
 * shown as an error — a link from somebody with wider access should land the
 * reader somewhere they can read, not on a wall.
 */
export function resolveSpace(
  fromUrl: string | null,
  stored: string | null,
  available: readonly string[],
): string | null {
  if (fromUrl && available.includes(fromUrl)) return fromUrl
  if (stored && available.includes(stored)) return stored
  return available[0] ?? null
}

export function useSpaceContext(): SpaceValue {
  const value = useContext(SpaceContext)
  if (!value) throw new Error('useSpaceContext outside SpaceProvider')
  return value
}

/**
 * The current wiki's slug, for a page that cannot render without one.
 *
 * Throws rather than returning null: every caller would otherwise write the
 * same `if (!space) return null` guard, and the one that forgot would send
 * `/v1/spaces/null/concepts`. The shell does not render pages until a wiki
 * exists, so by the time a page runs this, there is one.
 */
export function useSpace(): string {
  const { space } = useSpaceContext()
  if (!space) throw new Error('useSpace before a wiki was chosen')
  return space
}
