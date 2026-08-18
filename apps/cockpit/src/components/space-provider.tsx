import { useEffect, useMemo, type ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { readStoredSpace, resolveSpace, SpaceContext, storeSpace, type SpaceOption, type SpaceValue } from '@/lib/space'

/**
 * Puts the chosen wiki in reach of every page below it.
 *
 * The rule it applies lives in `lib/space.ts`; this is only the part that needs
 * a router. Splitting them keeps the rule testable without a browser and keeps
 * fast refresh working on this file, which is the one that renders.
 */
export function SpaceProvider({
  options,
  lockedTo,
  children,
}: {
  options: readonly SpaceOption[]
  /** Non-null when the session is bound to one space; the switcher then hides. */
  lockedTo: string | null
  children: ReactNode
}) {
  const available = useMemo(() => options.map((option) => option.slug), [options])
  const search = useRouterState({ select: (state) => state.location.search as { space?: string } })
  const fromUrl = typeof search.space === 'string' ? search.space : null

  const space = lockedTo ?? resolveSpace(fromUrl, readStoredSpace(), available)

  // The address remains the source of truth. Remembering its resolved value is
  // only the fallback for the next visit without `?space=`; it never changes
  // the current URL and therefore cannot silently switch an open page.
  useEffect(() => {
    if (space) storeSpace(space)
  }, [space])

  const value = useMemo<SpaceValue>(() => ({ space, options }), [space, options])

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>
}
