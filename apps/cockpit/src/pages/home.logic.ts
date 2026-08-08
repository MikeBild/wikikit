import { CONSOLE_LOCALE } from '@/lib/relative-time'
import { CHANGES_REQUESTED_STATE, STATUS_STATE, type DomainState } from '@/lib/tokens'

/**
 * The front page's rules, with no DOM attached.
 *
 * Every one of them is a decision about a number the server may not have
 * measured, and that is the whole reason this file exists: `/stats/*` answers
 * with three different flavours of "nothing" — a null (`median_hours` when
 * nothing was decided), an explicit `value_state: 'missing'` on a usage metric,
 * and a zero denominator (`freshness.concepts === 0`, so no share of anything
 * can be computed). Rendered naively all three come out as `0`, and a wiki that
 * prints "0% of pages are stale" when it holds no pages is lying about a
 * measurement it never made (CUI-SEV-2).
 */

/**
 * The tones `Badge` accepts, restated so this module stays free of JSX and can
 * be tested without a renderer.
 */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent' | 'unknown'

/**
 * Domain state → badge tone.
 *
 * Deliberately NOT derived from `STATE_TOKEN`. That table maps a state onto a
 * CSS custom property (`--success`, `--muted-foreground`) because an SVG stroke
 * needs a colour; `Badge` takes a tone, a smaller vocabulary in which
 * `muted-foreground` is not a member and `destructive` is spelled `danger`.
 * Deriving one from the other would mean a lookup that silently produces an
 * invalid tone the day a token is renamed, which is exactly the failure the
 * separate `tone` prop was introduced to make impossible.
 */
const BADGE_TONE: Record<DomainState, Tone> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'accent',
  blocked: 'warning',
  unknown: 'unknown',
}

export function toneFor(state: DomainState): Tone {
  return BADGE_TONE[state]
}

/**
 * A usage-stats metric, structurally. The generated type carries `value_kind`
 * and three optional sample fields as well; naming only what this module reads
 * keeps the rule testable from a two-field literal.
 */
export interface UsageMetric {
  value: number
  value_state: 'observed' | 'zero' | 'missing'
}

/**
 * The number a usage metric actually measured, or null when it measured nothing.
 *
 * `value` is 0 in both the `zero` and the `missing` case — the server sends the
 * discriminator precisely because the two are different facts. "No reviewer
 * opened a change in this window" is a measurement; "this window was never
 * sampled" is not, and only the second one gets an em dash.
 */
export function measured(metric: UsageMetric | null | undefined): number | null {
  if (!metric) return null
  return metric.value_state === 'missing' ? null : metric.value
}

/** A count, in the console's own locale — or `—` when nobody sent one (CUI-SEV-2). */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString(CONSOLE_LOCALE)
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * "the last 24 hours" — the window the statistics describe, in the reader's
 * words rather than as two ISO instants.
 *
 * Read from the response's own `from`/`to` and never assumed. The console asks
 * for the server's default window today; the moment a page passes a range, a
 * hard-coded "in the last 24 hours" underneath the numbers becomes a caption
 * that contradicts them. Returns null for a window that makes no sense, so the
 * caller can print the numbers without a sentence rather than print a wrong one.
 */
export function windowLabel(from: string, to: string): string | null {
  const start = new Date(from).valueOf()
  const end = new Date(to).valueOf()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const span = end - start
  if (span < 2 * HOUR_MS) {
    const minutes = Math.round(span / MINUTE_MS)
    return minutes === 60 ? 'the last hour' : `the last ${minutes} minutes`
  }
  if (span < 2 * DAY_MS) return `the last ${Math.round(span / HOUR_MS)} hours`
  return `the last ${Math.round(span / DAY_MS)} days`
}

/** A span of hours, at the coarseness a person would say it. `—` when unmeasured. */
export function durationHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours) || hours < 0) return '—'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${Math.round(hours)} h`
  return `${Math.round(hours / 24)} days`
}

/** The same, for the ingest job durations, which the server reports in seconds. */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 90) return `${Math.round(seconds)}s`
  return durationHours(seconds / 3600)
}

/**
 * The average time an ingest job took, or `—` when no job finished.
 *
 * The server sends `{total: 0, count: 0, avg: 0, max: 0}` for a window in which
 * nothing ran, and `avg: 0` there means "no sample", not "instantaneous". The
 * `count` is the only field that can tell those apart, which is why the whole
 * object is the argument rather than just the average.
 */
export function averageSeconds(duration: { count: number; avg: number } | null | undefined): string {
  if (!duration || duration.count <= 0) return '—'
  return formatSeconds(duration.avg)
}

/**
 * The share of pages nobody has touched in ninety days.
 *
 * A wiki with no pages has no stale share — not 0%. Printing "0% stale" for an
 * empty wiki reads as a clean bill of health for a body of knowledge that does
 * not exist, so the zero denominator returns the em dash instead.
 */
export function staleShare(concepts: number, stale: number): string {
  if (!Number.isFinite(concepts) || concepts <= 0) return '—'
  if (!Number.isFinite(stale) || stale < 0) return '—'
  return `${Math.round((stale / concepts) * 100)}%`
}

/**
 * The five words a change can be in, in the reviewer's language rather than the
 * table's.
 *
 * `changes_requested` is the case this function exists for. It is a BOOLEAN on a
 * still-`pending` proposal, so a queue that renders `status` alone shows a change
 * a reviewer has already read and sent back exactly like one nobody has opened —
 * and the reader loses the one distinction that tells them whose move it is.
 */
const CHANGE_WORD: Record<string, string> = {
  pending: 'Waiting',
  approved: 'Approved',
  rejected: 'Rejected',
  failed: 'Failed',
  split: 'Split',
}

export function changeStanding(status: string, changesRequested: boolean): { label: string; tone: Tone } {
  if (status === 'pending' && changesRequested) {
    return { label: 'Changes requested', tone: toneFor(CHANGES_REQUESTED_STATE) }
  }
  // An unrecognised status prints itself rather than being folded into one of
  // the five: a word the console does not know is still a word the server
  // means, and inventing a nicer one for it hides a vocabulary drift.
  return { label: CHANGE_WORD[status] ?? status, tone: toneFor(STATUS_STATE[status] ?? 'unknown') }
}
