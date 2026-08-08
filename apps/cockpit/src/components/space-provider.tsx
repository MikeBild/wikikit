import { useCallback, useMemo, type ReactNode } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { readStoredSpace, resolveSpace, SpaceContext, storeSpace, type SpaceValue } from '@/lib/space'

/**
 * Puts the chosen wiki in reach of every page below it.
 *
 * The rule it applies lives in `lib/space.ts`; this is only the part that needs
 * a router. Splitting them keeps the rule testable without a browser and keeps
 * fast refresh working on this file, which is the one that renders.
 */
export function SpaceProvider({
  available,
  lockedTo,
  children,
}: {
  available: readonly string[]
  /** Non-null when the session is bound to one space; the switcher then hides. */
  lockedTo: string | null
  children: ReactNode
}) {
  const navigate = useNavigate()
  const search = useRouterState({ select: (state) => state.location.search as { space?: string } })
  const fromUrl = typeof search.space === 'string' ? search.space : null

  const space = lockedTo ?? resolveSpace(fromUrl, readStoredSpace(), available)

  const setSpace = useCallback(
    (next: string) => {
      storeSpace(next)
      // Replace, not push: switching wiki is changing what you are looking at,
      // not a step in a journey. Pushing would make Back walk through every
      // wiki somebody clicked past.
      void navigate({ to: '/', search: { space: next }, replace: true })
    },
    [navigate],
  )

  const value = useMemo<SpaceValue>(
    () => ({ space, available, setSpace, locked: lockedTo !== null }),
    [space, available, setSpace, lockedTo],
  )

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>
}
