/**
 * Two rules the session gate lives by, stated where they can be proven.
 *
 * The gate itself is JSX and needs a browser; these do not, so they are here
 * and `test/unit/cockpit-pages/session-gate.test.ts` holds them. Same split as
 * `confirm.logic.ts` next door, and the same reason PAGES.md gives for it: a
 * rule that needs a browser to prove it is a rule nobody proves.
 *
 * No imports, by design. This module is reachable from `test/unit`, where the
 * compiler has no DOM at all — which is the pressure that keeps these two
 * decisions decisions, rather than something tangled into a render.
 */

/**
 * How often a VISIBLE console re-reads `GET /v1/session`.
 *
 * The gap this closes: the operator session slides its idle deadline on every
 * authenticated read, and since 0.24.0 `GET /v1/session` re-stamps the browser
 * cookie with the deadline the sliding UPDATE actually returned — so the
 * cookie keeps up with the row. But the console read that endpoint exactly
 * once, when the bundle mounted. That covers a reload, a second tab and a cold
 * start, and it misses the case the whole mechanism was built for: ONE tab,
 * left open, navigated client-side by somebody who is working. The router
 * never remounts the gate, so nothing ever asked again, and the browser
 * dropped the cookie eight hours after sign-in — mid-review, exactly as before.
 *
 * Ten minutes is chosen against two bounds rather than picked as a round
 * number. Below: the server's idle window is eight hours, so roughly fifty
 * renewals fit inside one window and the cookie survives a suspended laptop, a
 * throttled timer and a handful of failed reads without anybody noticing.
 * Above: the console's live reads tick every three seconds (`LIVE_INTERVAL_MS`)
 * and its fixed-cadence tiles every fifteen — at six requests an hour per tab
 * this is two orders of magnitude away from anything a reader would call
 * polling, and the response is one small JSON object the server was already
 * able to answer from the same row lookup every other read does.
 *
 * The test asserts the two bounds against the real numbers on both sides, not
 * against a copy of this comment.
 */
export const SESSION_REFRESH_INTERVAL_MS = 10 * 60 * 1000

/**
 * How long an answer stays fresh — and therefore the debounce on the
 * focus-driven half of the refresh below.
 *
 * A refetch on focus only fires for a STALE query, so this is what stops an
 * operator who alt-tabs between the console and their editor twenty times a
 * minute from sending twenty reads. A minute is short enough that a genuine
 * return — from a meeting, from lunch — always refetches.
 */
export const SESSION_STALE_MS = 60 * 1000

/** Exactly the TanStack options the session query needs, and nothing else. */
export interface SessionRefreshOptions {
  readonly refetchInterval: number
  readonly refetchIntervalInBackground: boolean
  readonly refetchOnWindowFocus: boolean
  readonly staleTime: number
}

/**
 * The renewal policy, as one object the gate spreads into `useQuery`.
 *
 * BOTH halves, deliberately, because each covers what the other cannot:
 *
 * - The **interval** is the one that closes the reported gap. A tab focused
 *   continuously for eight hours never fires a focus event, so a focus-only
 *   renewal would have left the single-tab case exactly where it was.
 * - **On focus** costs nothing when nobody is looking and catches the case the
 *   interval deliberately does not: a tab that was hidden for hours. The
 *   console's global default is `refetchOnWindowFocus: false` (see
 *   `lib/query.ts`, and the reason there is sound — a review queue that
 *   refetches under a confirm dialog is how an operator approves the proposal
 *   that just moved). This query overrides it because it is the one read where
 *   the reasoning does not apply: it is not a list anybody is acting on, and
 *   TanStack's structural sharing hands back the identical object when the
 *   session has not changed, so a renewal that finds nothing new re-renders
 *   nothing.
 *
 * And `refetchIntervalInBackground` stays **false** — the one place this
 * deliberately does less than it could. TanStack only fires an interval while
 * the document is visible unless that flag is set, and the flag is exactly what
 * `lib/live.ts` turns ON for ingest polling, so leaving it off here is a
 * decision and not an oversight. An idle window exists so that a session
 * nobody is attending dies on schedule; a minimized tab that renewed itself
 * every ten minutes would convert the eight-hour idle limit into the 24-hour
 * absolute cap for every operator who never closes a tab, which is a security
 * property traded away for nobody's convenience. Hidden means not renewing;
 * coming back is what renews, through the focus half above.
 *
 * WHAT THIS STILL DOES NOT COVER, stated rather than papered over:
 *
 * 1. A tab left VISIBLE on an unattended, unlocked machine renews for as long
 *    as it is visible. TanStack reads `visibilityState`, not whether a human is
 *    there, so "visible" is the best available proxy for attendance and it is
 *    not a good one. The 24-hour absolute cap is the only real bound on this
 *    case, and it still holds: the cookie's `Max-Age` comes from what
 *    `least(absolute_expires_at, …)` wrote, so no number of renewals reads past
 *    it. At the cap the read returns `{session: null}` and the console signs
 *    out where it stands.
 * 2. A tab hidden for longer than the idle window is signed out, and correctly
 *    so — but the operator learns it on their return rather than being warned
 *    on their way out. There is no warning surface here and this does not add
 *    one.
 * 3. The renewal is only as good as the read reaching the server. A console
 *    that spends the whole window offline comes back to a dead session.
 */
export const sessionRefreshOptions: SessionRefreshOptions = {
  refetchInterval: SESSION_REFRESH_INTERVAL_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  staleTime: SESSION_STALE_MS,
}

/** What the gate puts on screen. */
export type SessionView =
  /** No answer yet. */
  | 'checking'
  /** No answer, and the last attempt failed. */
  | 'unreachable'
  /** A clear answer: nobody is signed in. */
  | 'signed-out'
  /** A session, and the console behind it. */
  | 'ready'

/**
 * A read of `GET /v1/session`, reduced to the two facts that decide the view.
 *
 * `data` is three-valued on purpose and the distinction carries the whole rule:
 * `undefined` is "never answered", `null` is the endpoint's own answer that
 * nobody is signed in — it never 401s — and a session is a session.
 */
export interface SessionRead<T> {
  readonly data: T | null | undefined
  /** Whether the LAST attempt failed. A known session outranks it; see below. */
  readonly failed: boolean
}

/**
 * A known answer outranks a failed attempt.
 *
 * THE DEFECT THIS ORDERING REPLACES, which only became reachable the moment
 * the query above started asking a second time: the gate checked `query.error`
 * before it looked at the data. TanStack keeps `data` and sets `status:
 * 'error'` when a BACKGROUND refetch fails, so one blip on one ten-minute
 * renewal — a proxy hiccup, a laptop lid — would have replaced the entire
 * console with "Could not reach WikiKit", unmounting the router and taking
 * every unsubmitted edit in it with it, over a session that was still perfectly
 * valid. Renewal must be able to fail quietly; that is the difference between a
 * background read and a foreground one.
 *
 * So a failure only decides anything when there is nothing else to go on. It is
 * still the whole story on first load, where "we could not reach WikiKit"
 * genuinely is what happened, and the console has nothing to show anyway.
 *
 * What this does NOT do is keep a dead session alive. `null` is an ANSWER, and
 * it wins the moment it arrives: a session that hit its idle deadline or its
 * 24-hour absolute cap comes back as `null` on the next renewal and the console
 * goes to the sign-in splash from wherever the operator was. That is abrupt,
 * and it is the correct abrupt — the alternative is a console that keeps
 * drawing a page for a credential the server has stopped honouring, failing one
 * request at a time.
 */
export function resolveSessionView<T>(read: SessionRead<T>): SessionView {
  if (read.data === undefined) return read.failed ? 'unreachable' : 'checking'
  return read.data === null ? 'signed-out' : 'ready'
}
