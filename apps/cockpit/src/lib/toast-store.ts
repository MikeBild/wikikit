/**
 * The toast queue, as a pure store.
 *
 * WHY a store of our own and not a toast library: this console already made
 * this decision once, for the theme. `lib/theme-store.ts` is a factory over an
 * injected environment precisely so the behaviour that matters can be proven by
 * a test runner with no browser in it — and the behaviour that matters here is
 * a SCHEDULE. "An error never expires, a confirmation expires in four seconds"
 * is a claim about timers, and a claim about timers is worth exactly as much as
 * the test that can advance one. A dependency would put that schedule inside
 * somebody else's module, where this repository's test runner cannot reach it,
 * to save about a hundred lines.
 *
 * So the clock is a parameter. Nothing in this file reads `Date.now`, calls
 * `setTimeout` or touches the DOM; `lib/toast.ts` supplies the browser half and
 * the tab's single instance, exactly as `lib/theme.ts` does for the theme.
 *
 * Nothing here is React either — `detail` is a string, never a node. That is
 * not laziness: a toast's detail is the SERVER'S OWN WORDS (CUI-LOAD-2), and a
 * type that only admits a string is the cheapest way to keep a caller from
 * quietly composing a prettier sentence over the top of a refusal.
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastInput {
  tone: ToastTone
  /** One line. What happened, in the operator's terms. */
  title: string
  /** The server's own words, when there are any. Never paraphrased. */
  detail?: string
  /**
   * `next_best_actions`, carried rather than dropped.
   *
   * Every `DomainError` this server raises carries them, and they are the whole
   * difference between a refusal an operator can act on and one they can only
   * re-attempt. `Alert` already renders them; a toast that swallowed them would
   * make the same failure less useful in the surface that shows it more often.
   */
  actions?: readonly string[]
}

export interface ToastRecord extends ToastInput {
  id: number
  raisedAt: number
  /** How many times this exact toast has been raised while it was on screen. */
  count: number
  /** True when nothing will take it away but the operator. */
  sticky: boolean
}

/**
 * How long each tone stays, in milliseconds.
 *
 * Errors and warnings stay until they are dismissed. The reason is the failure
 * this console shipped with: fourteen mutation sites raised no toast at all,
 * and an error raised by a mutation whose dialog closes on settle was lost
 * outright — the operator saw a dialog vanish and had to infer from the list
 * whether anything happened. A refusal that names the missing scope is the only
 * evidence they get, and evidence that expires in four seconds while somebody
 * is looking at another window is evidence nobody has.
 *
 * A confirmation is the opposite. Leave those up and the corner fills with
 * stale good news that has to be cleared by hand, which is how an operator
 * learns to clear the corner without reading it — and then the one that mattered
 * goes the same way.
 *
 * `Alert` in `components/ui/alert.tsx` already says this in its `dismissible`
 * comment ("a warning or an error that disappears on its own is a fact the
 * operator did not get to read"). Same rule, same product, two surfaces.
 */
export const TOAST_DURATION_MS: Record<ToastTone, number> = {
  info: 4_000,
  success: 4_000,
  warning: Number.POSITIVE_INFINITY,
  danger: Number.POSITIVE_INFINITY,
}

/** A tone nothing will remove on its own. Derived from the table, never restated. */
export function isSticky(tone: ToastTone): boolean {
  return !Number.isFinite(TOAST_DURATION_MS[tone])
}

/**
 * How many toasts may be on screen at once.
 *
 * A cap is a policy about what gets HIDDEN, so it is deliberately narrow: only
 * a toast that was already going to expire on its own can be evicted early. A
 * stack of six refusals stays six — an operator who managed to provoke six
 * refusals is exactly the operator who must not have five of them deleted by a
 * layout rule.
 */
export const MAX_TOASTS = 4

export type TimerHandle = number

/** The two facts this store needs from a runtime, named so a test can supply them. */
export interface ToastClock {
  now(): number
  /** Run `task` after `ms`. Only ever called with a finite `ms`. */
  schedule(task: () => void, ms: number): TimerHandle
  cancel(handle: TimerHandle): void
}

export interface ToastStore {
  subscribe(listener: () => void): () => void
  /** Identity-stable: `useSyncExternalStore` compares snapshots by reference. */
  snapshot(): readonly ToastRecord[]
  raise(input: ToastInput): number
  /** One toast by id, or every toast when called with nothing. */
  dismiss(id?: number): void
}

/** One shared empty array so an emptied queue is reference-equal to a never-used one. */
const NONE: readonly ToastRecord[] = Object.freeze([])

/**
 * Failure to toast, without this module knowing what an `ApiError` is.
 *
 * Structural on purpose. `api/client.ts` builds the whole typed openapi client
 * at import time; a pure store that imported it to read three fields would drag
 * the network layer into every test of a duration table. `ApiError` satisfies
 * this shape by construction, and `lib/toast.ts` is where the two meet.
 */
export interface FailureLike {
  status?: number
  message?: string
  nextBestActions?: readonly string[]
}

/**
 * The tone a failed request deserves.
 *
 * 403 is a warning and not a danger, and that is the same judgement
 * `DataState` already makes: WikiKit knows exactly who you are, it knows your
 * key carries `knowledge:propose` and not `knowledge:approve`, and the answer
 * is no. Nothing broke, nothing will break, and painting it as an error tells
 * an operator to go looking for a fault that does not exist. Every other
 * failure is `danger` — including 401, because a session that expired mid-edit
 * did lose the operator their work.
 */
export function toneForStatus(status: number | undefined): ToastTone {
  return status === 403 ? 'warning' : 'danger'
}

/**
 * A thrown value, as the toast for it.
 *
 * The title is the caller's — it is the only part that knows what was being
 * attempted ("Could not approve this proposal"). Everything below it is the
 * server's: its sentence as `detail`, its `next_best_actions` as `actions`.
 * Neither is rewritten here, which is the point of the function existing rather
 * than each of the fourteen call sites assembling its own.
 */
export function toastForFailure(title: string, error: unknown): ToastInput {
  const failure = (error ?? {}) as FailureLike
  const detail = typeof failure.message === 'string' && failure.message ? failure.message : undefined
  const actions =
    Array.isArray(failure.nextBestActions) && failure.nextBestActions.length ? failure.nextBestActions : undefined
  const input: ToastInput = { tone: toneForStatus(failure.status), title }
  if (detail !== undefined) input.detail = detail
  if (actions !== undefined) input.actions = actions
  return input
}

/** Two raises describe the same event when tone, title and detail all agree. */
function sameEvent(record: ToastRecord, input: ToastInput): boolean {
  return record.tone === input.tone && record.title === input.title && record.detail === input.detail
}

export function createToastStore(clock: ToastClock, options: { max?: number } = {}): ToastStore {
  const max = options.max ?? MAX_TOASTS
  const listeners = new Set<() => void>()
  const timers = new Map<number, TimerHandle>()
  let items: readonly ToastRecord[] = NONE
  let nextId = 1

  function publish(next: readonly ToastRecord[]): void {
    items = next.length === 0 ? NONE : next
    for (const listener of listeners) listener()
  }

  function disarm(id: number): void {
    const handle = timers.get(id)
    if (handle === undefined) return
    clock.cancel(handle)
    timers.delete(id)
  }

  function arm(record: ToastRecord): void {
    if (record.sticky) return
    timers.set(
      record.id,
      clock.schedule(() => dismiss(record.id), TOAST_DURATION_MS[record.tone]),
    )
  }

  /** Drop the oldest toasts that were leaving anyway, until the cap is met. */
  function underCap(next: ToastRecord[]): ToastRecord[] {
    while (next.length > max) {
      const index = next.findIndex((record) => !record.sticky)
      // Every remaining toast is one the operator has to dismiss themselves.
      // The cap yields; a refusal is not overflow.
      if (index === -1) break
      const [evicted] = next.splice(index, 1)
      if (evicted) disarm(evicted.id)
    }
    return next
  }

  function raise(input: ToastInput): number {
    // The same failure raised five times by five retries is one fact, not five
    // stacked copies of it. The count is shown rather than hidden, because
    // "this refused four times" and "this refused once" are different stories
    // and only one of them is worth a second look at the request.
    const existing = items.find((record) => sameEvent(record, input))
    if (existing) {
      disarm(existing.id)
      const bumped: ToastRecord = {
        ...existing,
        ...input,
        count: existing.count + 1,
        raisedAt: clock.now(),
      }
      publish(items.map((record) => (record.id === existing.id ? bumped : record)))
      arm(bumped)
      return bumped.id
    }

    const record: ToastRecord = {
      ...input,
      id: nextId++,
      raisedAt: clock.now(),
      count: 1,
      sticky: isSticky(input.tone),
    }
    publish(underCap([...items, record]))
    arm(record)
    return record.id
  }

  function dismiss(id?: number): void {
    if (id === undefined) {
      if (items.length === 0) return
      for (const record of items) disarm(record.id)
      publish([])
      return
    }
    if (!items.some((record) => record.id === id)) return
    disarm(id)
    publish(items.filter((record) => record.id !== id))
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => items,
    raise,
    dismiss,
  }
}
