/**
 * "2 hours ago" — and the instant it was derived from, never instead of it.
 *
 * A revision row that reads `29/07/2026, 21:43:19` makes the operator do the
 * arithmetic to answer "was that before or after the source was archived?". A
 * row that reads only "2 hours ago" takes the instant away from them, which is
 * the one thing an append-only revision history is for. So every relative
 * sentence here comes with the exact timestamp it stands for, and the component
 * that renders it puts both on screen: the sentence as text, the instant in
 * `<time datetime>` and in a real tooltip.
 *
 * `Intl.RelativeTimeFormat` is in every browser this console supports, so there
 * is no library. The locale is PINNED, and that is a correction: it defaulted to
 * `undefined`, which makes Intl read the browser's preference, so a console
 * whose every other word is English rendered "vor 2 Stunden" beside "Approved
 * revision 12" on a German laptop. Half-translating an interface is worse than
 * not translating it — the reader cannot tell which half to trust — and this
 * module has no standing to translate the other half. When the console grows a
 * language, `CONSOLE_LOCALE` is what it reads, and it is one constant rather
 * than an argument nobody passed at nineteen call sites.
 *
 * `formatInstant` in `lib/utils.ts` is the other half of the pair and reads the
 * same constant.
 */

export type TimeInput = string | number | Date | null | undefined
export type Locales = string | readonly string[] | undefined

/**
 * The language this console is written in.
 *
 * Every string in it is English, including the ones a formatter cannot reach —
 * status words, refusals, the sentences under the empty states. A date is not
 * exempt from the interface it sits in. The parameter stays on every function
 * below so a test can pin a different one, and so the day this console is
 * translated there is exactly one value to make dynamic.
 */
export const CONSOLE_LOCALE = 'en-US'

export interface RelativeParts {
  /** Negative in the past, positive in the future — the sign `format()` wants. */
  value: number
  unit: Intl.RelativeTimeFormatUnit
}

/**
 * Each unit with how many of it the next one holds. Weeks are in the list
 * because "10 days ago" is a number the reader has to convert and "last week" is
 * not; months are approximated from weeks, which is why nothing here claims
 * calendar accuracy past a week.
 */
const DIVISIONS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.348_125],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
]

/**
 * An absent or unparseable value is `null`, not a zero and not the epoch.
 *
 * CUI-SEV-2, at the source: a `finished_at` the server has not set yet is a
 * value nobody sent, and an ingest that is still running must never render as
 * having finished in 1970.
 */
export function instantOf(value: TimeInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.valueOf()) ? null : date
}

/**
 * The coarsest unit that still counts at least one, truncated towards zero.
 *
 * Truncation rather than rounding, and that is the whole honesty of this
 * function: an ingest that finished 59.6 seconds ago has not been finished for
 * a minute, and 23 hours 50 minutes ago was not "yesterday" — it was today,
 * which is exactly the distinction an operator reading a revision history is
 * making.
 * Rounding also produces "in 60 seconds", a sentence no unit boundary should
 * ever emit.
 */
export function relativeParts(fromMs: number, nowMs: number): RelativeParts {
  let amount = (fromMs - nowMs) / 1000
  for (const [unit, size] of DIVISIONS) {
    // `|| 0` only ever fires for -0, which is what truncating a fraction of a
    // second in the past produces. It is a value no caller should have to know
    // about: "0 seconds" and "-0 seconds" are the same moment.
    if (Math.abs(amount) < size) return { value: Math.trunc(amount) || 0, unit }
    amount /= size
  }
  // Unreachable — the last division is unbounded — but TypeScript cannot see it.
  return { value: Math.trunc(amount) || 0, unit: 'year' }
}

/** `null` when there is no instant to describe; the caller decides what to show. */
export function formatRelative(
  value: TimeInput,
  nowMs: number = Date.now(),
  locales: Locales = CONSOLE_LOCALE,
): string | null {
  const date = instantOf(value)
  if (!date) return null
  const { value: amount, unit } = relativeParts(date.valueOf(), nowMs)
  // numeric: 'auto' is what turns 0 into "now" and -1 day into "yesterday"
  // rather than "0 seconds ago" and "1 day ago".
  return new Intl.RelativeTimeFormat(locales as string | string[] | undefined, { numeric: 'auto' }).format(amount, unit)
}

/** The precision the relative sentence hides, in the console's own locale. */
export function formatExact(value: TimeInput, locales: Locales = CONSOLE_LOCALE): string | null {
  const date = instantOf(value)
  if (!date) return null
  return date.toLocaleString(locales as string | string[] | undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  })
}

/** The machine-readable instant for `<time datetime>`; UTC, so no reader's zone is implied. */
export function isoInstant(value: TimeInput): string | null {
  return instantOf(value)?.toISOString() ?? null
}

/**
 * How long the sentence stays true, in milliseconds.
 *
 * A label reading "3 seconds ago" is wrong a second later, so it re-renders
 * every second; one reading "3 hours ago" is wrong at most once an hour, and a
 * per-second timer on every row of a revision history is a cost nobody asked
 * for.
 * The middle case is deliberately tighter than its unit: checking a minutes
 * label four times a minute costs nothing and keeps "now" from lingering for a
 * full minute after it stopped being true.
 */
export function refreshAfter(unit: Intl.RelativeTimeFormatUnit): number {
  if (unit === 'second' || unit === 'seconds') return 1_000
  if (unit === 'minute' || unit === 'minutes') return 15_000
  return 60_000
}
