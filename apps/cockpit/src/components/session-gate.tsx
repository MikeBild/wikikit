import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiError, fetchSession, loginUrl } from '@/api/client'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SessionContext } from '@/lib/session'

/**
 * Blocks the whole console until the session is known.
 *
 * No half-authenticated UI, ever. A shell that renders its navigation before it
 * knows who is signed in shows an operator a menu of things they may not be
 * allowed to do, and then fails each one individually — which reads as a broken
 * console rather than as a missing scope.
 *
 * GET /v1/session is the whoami read and NEVER errors for an anonymous tab: it
 * answers `{session: null}`. So the signed-out branch keys off the null, not
 * off a 401 — a 401 here would mean the endpoint itself broke, which is the
 * error branch's business. The two surfaces stay distinct: "we do not know who
 * you are" offers a way in, "we could not reach WikiKit" offers a retry.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: ['session'],
    queryFn: () => fetchSession(),
    staleTime: 60_000,
  })

  if (query.isPending) return <Splash>Checking your session…</Splash>

  if (query.error) {
    return (
      <Splash>
        <Alert
          tone="danger"
          title="Could not reach WikiKit"
          className="max-w-md"
          actions={query.error instanceof ApiError ? query.error.nextBestActions : undefined}
        >
          {query.error instanceof Error ? query.error.message : 'The session endpoint did not answer.'}
        </Alert>
        <Button variant="outline" onClick={() => void query.refetch()} data-testid="session-retry">
          Try again
        </Button>
      </Splash>
    )
  }

  const session = query.data ?? null
  if (!session) {
    return (
      <Splash>
        <SignIn />
      </Splash>
    )
  }

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
}

/**
 * Sign-in is a NAVIGATION, not a form in this bundle.
 *
 * Rendering an API-key field here would save a page load and cost something
 * worse: two sign-in surfaces. The server-rendered funnel and an SPA form
 * drift, get tested separately, and answer the same question differently — and
 * when an operator later configures SSO, the login they know changes shape
 * underneath them.
 *
 * One surface, always. It is also the only one that CAN serve every case: an
 * OIDC round trip is a sequence of redirects, and a single-page app cannot
 * participate in one. The API-key path is not lost — the funnel offers it.
 *
 * An anchor rather than a button with an onClick, because this IS a link
 * (CUI-ACT-1/3): the URL changes and nothing else does, and an operator can
 * middle-click it.
 */
function SignIn() {
  // The whole current location, so a deep link survives the round trip and the
  // operator lands where they were going rather than on the home page. The
  // funnel refuses anything outside /cockpit; this bundle does not second-guess it.
  const returnTo = `${window.location.pathname}${window.location.search}`
  return (
    <div className="flex w-full max-w-sm flex-col gap-3 text-center">
      <h1 className="text-base font-semibold">Sign in to WikiKit</h1>
      <p className="text-muted-foreground text-sm">Continue on the WikiKit sign-in page.</p>
      <Button asChild className="w-full">
        <a href={loginUrl(returnTo)} data-testid="sign-in">
          Sign in
        </a>
      </Button>
    </div>
  )
}

/**
 * One voice with the funnel: the sign-in page says "wikikit", so this says
 * "wikikit" too. Shouting WIKIKIT COCKPIT one navigation before a page headed
 * "Sign in to WikiKit" would make one act look like two products.
 */
function Splash({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="text-muted-foreground text-sm font-semibold">wikikit</div>
      {children}
    </div>
  )
}
