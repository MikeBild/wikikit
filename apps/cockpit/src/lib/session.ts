import { createContext, useContext } from 'react'
import type { SessionInfo } from '@/api/client'
import { holdsScope } from '@/lib/scopes'

/**
 * Who the operator is and what they may do, with no view attached.
 *
 * `lib/` is the layer everything else imports, so it must not import back out
 * of it: the component that fetches the session and blocks the console until it
 * resolves lives in components/session-gate.tsx.
 */
export const SessionContext = createContext<SessionInfo | null>(null)

export function useSession(): SessionInfo {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession outside SessionGate')
  return session
}

/**
 * Scope gating, in one place. Delegates to the mirrored implication table in
 * lib/scopes.ts, which a unit test compares against the server's own — the
 * console can be wrong about many things; which pages an operator is allowed to
 * open should not be one of them.
 */
export function useCan(): (scope: string) => boolean {
  const session = useSession()
  return (scope: string) => holdsScope(session.scopes, scope)
}
