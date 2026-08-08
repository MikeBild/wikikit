/**
 * Which of the four states a read is actually in — and why "pending" is not
 * the same as "we have heard nothing".
 *
 * TanStack keeps a query at `status: 'pending'` for the WHOLE retry sequence.
 * A concept read that takes a 502 from the knowledge base is pending after the
 * first refusal, pending after the second, and only becomes `'error'` once the
 * retry budget is spent. Every one of those pending frames already holds the
 * server's own sentence, in `failureReason` — and a surface that branches on
 * `isPending` alone draws a loading skeleton over it and shows the operator
 * nothing at all. With three attempts over a read whose upstream has a
 * fifteen-second timeout, "nothing at all" is most of a minute, which from the
 * chair in front of it is an eternal spinner.
 *
 * So the rule this module makes testable: **an answer that has already arrived
 * is never rendered as an absence.** A read is in the error phase the moment a
 * failure is in hand, whether or not TanStack intends to ask again. That the
 * asking continues is worth saying — it is the difference between "this is
 * broken" and "this is broken and we are checking again" — so it is carried
 * out as `retrying` rather than hidden.
 *
 * No imports, no DOM: callable from test/unit.
 */

/**
 * The slice of `UseQueryResult` this decision reads. `UseQueryResult` satisfies
 * it structurally, so a page passes the query it already has.
 */
export interface ReadSnapshot {
  isPending: boolean
  isError: boolean
  /** Set once the retry budget is spent. */
  error: unknown
  /** The most recent failure while TanStack is still retrying — set long before `error` is. */
  failureReason?: unknown
}

export type ReadPhase = 'loading' | 'error' | 'ready'

/** True when this read has a refusal in hand, settled or not. */
export function readFailure(read: ReadSnapshot): unknown {
  return read.error ?? read.failureReason ?? null
}

/**
 * Whether the failure in hand is one TanStack is still working on. A surface
 * that says so does not have to choose between lying about a transient blip
 * and hiding a refusal for the length of a retry budget.
 */
export function isRetrying(read: ReadSnapshot): boolean {
  return !read.isError && read.isPending && (read.failureReason ?? null) !== null
}

export function readPhase(read: ReadSnapshot): ReadPhase {
  if (readFailure(read) !== null) return 'error'
  if (read.isPending) return 'loading'
  return 'ready'
}
