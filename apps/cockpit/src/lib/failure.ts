/**
 * What a failed read is allowed to offer the operator.
 *
 * `components/data-state.tsx` established the rule this console holds to and
 * most consoles do not: **a refusal is terminal.** WikiKit understood the
 * request and answered it, so "Try again" is a button that cannot ever work, and
 * a console that offers it teaches the operator that the system is flaky rather
 * than that the answer is settled. `lib/query.ts` obeys the same contract at the
 * transport layer, out of the same function — it stops asking the moment the
 * answer is one asking cannot change.
 *
 * THE DEFECT THIS RULE REPLACES: terminality used to be a list of one — `403`,
 * and nothing else. A concept, source or proposal that does not exist answers
 * `404`, so three detail pages printed "there is no such thing" above a Try
 * again button, and pressing it fetched the same absence again. The status was
 * never the question; what the status MEANS is.
 *
 * The rule lives here, apart from any JSX, for two reasons. A table cannot render
 * `DataState`'s banner — an `<Alert>` is not a legal child of `<tbody>` — so the
 * decision had to be reachable from a second surface, and copying the decision is
 * how two surfaces end up disagreeing about which refusals are terminal. And as a
 * pure function it is evidence rather than a claim: test/unit/cockpit-failure.test.ts.
 *
 * What is NOT decided here: the words. The server's own message is carried
 * through untouched (CUI-LOAD-2) and its `next_best_actions` are carried with it
 * — the server went to the trouble of saying what to do instead of retrying, and
 * an error surface that drops that turns a terminal instruction back into a
 * mystery.
 *
 * No imports, no DOM: callable from test/unit.
 */

/** A failed request, reduced to the three facts that decide what to render. */
export interface Failure {
  /** The HTTP status, or `null` when the request never got an answer at all. */
  status: number | null
  /** The server's own words. */
  message: string
  /** `next_best_actions`, verbatim. */
  actions: readonly string[]
  /**
   * True while the transport is still retrying this one. The refusal is real
   * and is shown; what changes is that the operator is not asked to press a
   * button that duplicates an attempt already in flight.
   */
  retrying?: boolean
}

export interface FailureNotice {
  tone: 'warning' | 'danger'
  title: string
  message: string
  actions: readonly string[]
  /**
   * Whether a retry could ever succeed. `false` means the surface renders no
   * retry control at all — not a disabled one, which is a button that says "later,
   * maybe" about an answer that is final.
   */
  retryable: boolean
}

/**
 * The statuses that mean "later, maybe" rather than "no".
 *
 * A timeout, a rate limit and an early hint are the server asking to be asked
 * again — the only 4xx answers that are about the moment rather than about the
 * request.
 */
const ASK_AGAIN = new Set([408, 425, 429])

/**
 * Could asking again ever produce a different answer?
 *
 * - No answer at all (`null`) — the request never reached anyone. Asking again
 *   is exactly the right move.
 * - `4xx` — the request was understood and refused. The thing is missing, the
 *   scope is missing, or the request is malformed; none of that changes because
 *   a button was pressed. `ASK_AGAIN` is the narrow exception.
 * - `501` — this deployment has no such capability bound. That is a
 *   configuration fact, not a hiccup, and it is settled until an operator binds
 *   something.
 * - the rest of `5xx` — the fault is on our side and may well pass. Retryable.
 *
 * Exported because `lib/query.ts` decides the SAME question about the same
 * failures, and a transport that keeps retrying what this calls terminal is two
 * answers to one question.
 */
export function askingAgainCouldHelp(status: number | null): boolean {
  if (status === null) return true
  if (ASK_AGAIN.has(status)) return true
  if (status === 501) return false
  return status < 400 || status >= 500
}

/**
 * The words for a settled refusal, by what the status MEANS.
 *
 * A refusal is not a fault — the request was understood and answered — so most
 * of these wear warning rather than danger. The two that do not are the ones
 * where the console sent something wrong, which is a defect and should look
 * like one.
 */
const REFUSALS: Record<number, { tone: FailureNotice['tone']; title: string }> = {
  400: { tone: 'danger', title: 'This request was not understood' },
  401: { tone: 'warning', title: 'Not signed in' },
  403: { tone: 'warning', title: 'Not permitted' },
  404: { tone: 'warning', title: 'There is nothing here' },
  405: { tone: 'danger', title: 'Not available here' },
  409: { tone: 'warning', title: 'This has already moved on' },
  410: { tone: 'warning', title: 'This is gone' },
  422: { tone: 'danger', title: 'This request was not understood' },
  501: { tone: 'warning', title: 'Nothing is bound for this yet' },
}

function words(message: string): string {
  const trimmed = message.trim()
  // Never a blank banner. A failure with no message is still a fact, and saying
  // that no message came is honest in a way that an invented one is not.
  return trimmed || 'The request failed and no message came back.'
}

export function describeFailure(failure: Failure): FailureNotice {
  const message = words(failure.message)
  if (!askingAgainCouldHelp(failure.status)) {
    const refusal = REFUSALS[failure.status ?? 0] ?? { tone: 'warning' as const, title: 'This cannot be loaded' }
    return { ...refusal, message, actions: failure.actions, retryable: false }
  }
  return {
    tone: 'danger',
    // A refusal that is being re-attempted is still a refusal, and the
    // operator gets to read it now rather than after the retry budget is
    // spent. Saying that the asking continues is what keeps it from reading
    // as final.
    title: failure.retrying ? 'Could not load this — trying again' : 'Could not load this',
    message,
    actions: failure.actions,
    // No button while an automatic attempt is already in the air: it would
    // offer to do the thing that is happening.
    retryable: !failure.retrying,
  }
}
