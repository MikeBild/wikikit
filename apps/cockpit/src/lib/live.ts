/**
 * Which statuses are still moving, and how often to ask again.
 *
 * The console had a stopwatch over a frozen status: the ingest list, the ingest
 * detail, the source page and the proposal queue each ticked a private clock,
 * so the DURATION of a running ingest advanced once a second while the STATUS
 * behind it only ever changed on a manual reload. An operator watching a
 * document get archived, chunked and synthesized into a proposal therefore
 * watched a number climb next to a word that was, quite often, already wrong.
 *
 * The fix is not a faster clock — it is asking the server again while the work
 * is in flight, and stopping the moment it is not. That is a decision about a
 * status string, so it lives here, pure, and the pages pass it straight to
 * TanStack's `refetchInterval`.
 *
 * The SSE change stream supersedes all of this and is deliberately not started
 * here: it needs a server endpoint this deployment does not serve. Until it
 * lands, polling is the honest answer, and it is confined to one module so
 * there is exactly one thing to delete.
 */

/**
 * Statuses that will never change again on their own.
 *
 * Listed rather than derived from a status-to-state table: `pending` is not
 * terminal (a reviewer's decision moves it) while `queued` and `running` are
 * the two ingest states that are about to move on their own. Nor does the
 * WORD tell you: `quota_blocked` sounds settled and resumes by itself, while
 * `split` sounds mid-flight and never moves again. A table that mapped states
 * to "keep asking" by their shape would do both wrong — so the statuses are
 * named, one at a time, and a status nobody listed is treated as still moving.
 */
export const TERMINAL_STATUSES: readonly string[] = [
  // Ingest jobs. `wk_ingest_jobs.status` is exactly
  // queued | running | done | failed | quota_blocked, of which only `done` and
  // `failed` have settled.
  //
  // `queued` and `running` are deliberately absent: those are the two states
  // the worker moves out of by itself, and they are the whole reason this
  // module exists. `quota_blocked` is absent for the SAME reason and is the
  // one that reads terminal but is not — a quota hit parks the job with a
  // `resume_at` instead of failing it, and the worker flips it back to
  // `queued` once the provider window reopens. Listing it would leave the
  // operator staring at "blocked" on a job that quietly finished overnight.
  'done',
  'failed',
  // `captured` and `discarded` are settled AS FAR AS POLLING GOES: nothing on
  // the server moves either by itself — only a human triage resolution does,
  // and that mutation invalidates the query it changes. A list of parked notes
  // that re-asked every few seconds would be polling for an event that can
  // only arrive through this console's own buttons.
  'captured',
  'discarded',
  // Change proposals: pending | approved | rejected | failed | split, of which
  // only `pending` still moves. A decided proposal is decided — nothing on the
  // server turns an approval back into a pending review, so a queue that kept
  // asking would be asking a settled question once every three seconds for as
  // long as the tab is open. (`failed` is shared with the ingest half above.)
  'approved',
  'rejected',
  // A fully split parent is terminal too: the split moved its staged rows to
  // fresh pending children and stamped the parent, and `wk_split_proposal`
  // only ever accepts a `pending` proposal, so nothing can move it again.
  'split',
]

/**
 * Whether this status has settled.
 *
 * An unknown status is NOT terminal: a status this bundle has never heard of
 * comes from a server newer than it, and a console that stops watching
 * something it cannot name is a console that goes quiet exactly when the
 * deployment has changed under it.
 */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && TERMINAL_STATUSES.includes(status)
}

/** True while anything in the list is still moving. */
export function anyInFlight(statuses: readonly (string | null | undefined)[]): boolean {
  return statuses.some((status) => !isTerminalStatus(status))
}

/**
 * How often to ask again, in milliseconds — or `false`, which is what TanStack
 * reads as "stop".
 *
 * Three seconds while something is running: fast enough that a status change is
 * seen within one glance, slow enough that a list of forty ingests is not a
 * request per second. `false` the moment nothing is moving, which is the whole
 * point — a finished ingest is a row that costs nothing to leave on screen.
 */
export const LIVE_INTERVAL_MS = 3_000

export function pollWhile(inFlight: boolean, intervalMs: number = LIVE_INTERVAL_MS): number | false {
  return inFlight ? intervalMs : false
}

/**
 * A read on a FIXED cadence, for a surface whose statuses do not decide it.
 *
 * The Overview tiles are the case: "proposals awaiting review" is a queue an
 * operator leaves open on a second screen precisely so it can interrupt them,
 * and a count that only moves when the tab is focused is a count that never
 * interrupts anybody. Same `refetchIntervalInBackground` reasoning as
 * `liveReadOptions`, stated once so a fixed-cadence read cannot quietly get
 * the default back.
 */
export function pollAlways(intervalMs: number) {
  return { refetchInterval: intervalMs, refetchIntervalInBackground: true }
}

/** The shape TanStack hands a `refetchInterval` callback — the query, not the data. */
interface LiveQuerySnapshot<T> {
  state: { data: T | undefined }
}

/**
 * The whole live-read wiring, as one object a page spreads into `useQuery`.
 *
 * WHY this exists rather than four hand-written `refetchInterval` closures:
 * `pollWhile` returning 3000 is necessary and was never sufficient. TanStack
 * schedules the interval and then, on every tick, refuses to fetch unless
 * `refetchIntervalInBackground` is set OR the document is focused
 * (`QueryObserver.#updateRefetchInterval`). The console's default is neither —
 * and `refetchOnWindowFocus` is deliberately off here too — so a tab that was
 * ever backgrounded made ZERO requests for as long as it stayed there and did
 * not catch up on return. The status froze; only the duration beside it kept
 * moving, which is the exact failure the polling was added to end.
 *
 * A console is a thing people leave open on a second screen and in a second
 * tab — an operator kicks off an ingest of a forty-page document and goes back
 * to reading. Keeping the interval honest while it is not the foreground tab is
 * the point of it, so `refetchIntervalInBackground` is part of what "live"
 * means here and not a per-page decision four pages can each get wrong.
 *
 * NOT covered by a test in this repository — the cockpit has none yet, and the
 * `refetchIntervalInBackground` half of this is precisely the part a test of
 * `pollWhile`'s return value would report as working while the tab made zero
 * requests. Anyone adding cockpit tests should start with a real QueryObserver
 * over a backgrounded document rather than with this function's return value.
 */
export function liveReadOptions<T>(statusesOf: (data: T) => readonly (string | null | undefined)[]) {
  return {
    refetchInterval: (query: LiveQuerySnapshot<T>): number | false => {
      const data = query.state.data
      // Nothing read yet is not "nothing is moving": the first answer has not
      // arrived, and TanStack recomputes this the moment it does.
      if (data === undefined) return false
      return pollWhile(anyInFlight(statusesOf(data)))
    },
    refetchIntervalInBackground: true,
  }
}

/**
 * A fraction the server actually sent, or `null`.
 *
 * The rule this exists to enforce: never draw a percentage where nothing
 * measured one. An ingest has chunks, and `2/5 chunks` is a count of things
 * that happened; "40%" is a claim about how far through the work is, which
 * nobody on either side of the wire has made. Where there is no fraction, the
 * surface says "running, since X" instead — a fact — and this returns null so
 * it can.
 */
export function fractionOf(done: number | null | undefined, total: number | null | undefined): number | null {
  if (typeof done !== 'number' || typeof total !== 'number') return null
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(1, done / total))
}
