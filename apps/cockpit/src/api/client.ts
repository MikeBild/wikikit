import createClient, { type Middleware } from 'openapi-fetch'
import type { paths } from './schema'

/**
 * Same origin, always.
 *
 * No base URL, because there is nowhere else to point it: WikiKit serves this
 * bundle itself. No token, because a browser cannot keep one — the operator
 * session is an HttpOnly cookie the browser attaches on its own, and there is
 * nothing in this module that a script injected into the page could steal.
 *
 * The types come from docs/openapi.json through openapi-typescript, so a field
 * the server stops sending stops compiling here. That is the entire reason this
 * is openapi-fetch and not `fetch`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly nextBestActions: string[] = [],
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** 401: we do not know who you are. The console shows a sign-in prompt. */
  get isUnauthenticated(): boolean {
    return this.status === 401
  }

  /** 403: we know exactly who you are and the answer is no. Re-authenticating cannot help. */
  get isForbidden(): boolean {
    return this.status === 403
  }
}

/**
 * openapi-fetch answers `{data, error}`; the console prefers exceptions so
 * TanStack Query's error state does the branching in one place instead of at
 * every call site.
 *
 * `next_best_actions` is carried onto the error object rather than discarded.
 * The server goes to the trouble of saying what to do instead of retrying, and
 * an error banner that drops that advice on the floor turns a terminal
 * instruction back into a mystery.
 */
const raise: Middleware = {
  async onResponse({ response }) {
    if (response.ok) return response
    let code = 'request_failed'
    let message = `${response.status} ${response.statusText}`
    let actions: string[] = []
    try {
      const body = (await response.clone().json()) as {
        error?: string
        code?: string
        next_best_actions?: string[]
      }
      if (typeof body.code === 'string') code = body.code
      if (typeof body.error === 'string') message = body.error
      if (Array.isArray(body.next_best_actions)) actions = body.next_best_actions
    } catch {
      // A non-JSON error body — an HTML error page from a proxy, an empty 502 —
      // still has to surface as a typed failure rather than a parse crash.
    }
    throw new ApiError(response.status, code, message, actions)
  },
}

export const api = createClient<paths>({ credentials: 'same-origin' })
api.use(raise)

/** Unwraps the `{data}` envelope; failures already threw in the middleware. */
export async function unwrap<T>(promise: Promise<{ data?: T }>): Promise<T> {
  const { data } = await promise
  return data as T
}

/**
 * The same call for an operation the OpenAPI document describes in prose
 * rather than with a response schema. Every use is an entry on the list of
 * responses that still need one — which is why it is a separate, greppable
 * name and not a cast at the call site.
 */
export async function unwrapAs<T>(promise: Promise<{ data?: unknown }>): Promise<T> {
  const { data } = await promise
  return data as T
}

/**
 * A liveness probe, fetched rather than typed.
 *
 * `/health` answers `text/plain` and exists to be cheap and to work when
 * everything else does not. A non-2xx is an answer, not an exception: the
 * System page renders "down"; it does not throw, because a liveness check that
 * crashes the page reporting it fails the way it was built to catch.
 */
export async function probe(path: string): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await fetch(path, { credentials: 'same-origin' })
    return { ok: response.ok, status: response.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

/**
 * The cookie-plane endpoints, which are NOT in the OpenAPI document's typed
 * paths the same way the knowledge surface is — they belong to the browser
 * funnel, not to the agent-facing REST contract. One narrow module-level
 * definition beats openapi-fetch generics that would have to model a route
 * whose whole point is that it answers 200 with a null.
 */
export interface SessionInfo {
  name: string
  kind: 'api_key' | 'identity'
  scopes: string[]
  space_id: string | null
  provider_id: string | null
}

/**
 * Never 401s. "Nobody is signed in" is an answer the console renders, not a
 * failure it recovers from — so this returns null rather than throwing, and
 * the sign-in prompt is a branch instead of an error boundary.
 */
export async function fetchSession(): Promise<SessionInfo | null> {
  const response = await fetch('/v1/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!response.ok) throw new ApiError(response.status, 'session_unavailable', 'Could not reach WikiKit')
  const body = (await response.json()) as { session: SessionInfo | null }
  return body.session
}

/** Sign out. The Origin header the browser adds is what the server checks. */
export async function endSession(): Promise<void> {
  const response = await fetch('/v1/session', { method: 'DELETE', credentials: 'same-origin' })
  if (!response.ok && response.status !== 401) {
    throw new ApiError(response.status, 'sign_out_failed', 'Could not sign out')
  }
}

/** Where the browser goes to prove who it is. A navigation, never a fetch. */
export function loginUrl(returnTo: string): string {
  return `/v1/identity/cockpit-login?return_to=${encodeURIComponent(returnTo)}`
}
