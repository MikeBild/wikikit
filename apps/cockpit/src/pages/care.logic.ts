import { toneFor, type Tone } from '@/pages/home.logic'
import type { Locale } from '@/lib/i18n'

/**
 * The Care page's rules, with no DOM under them.
 *
 * This page exists because of a measured failure rather than a feature request:
 * a production wiki was sitting on hundreds of change proposals whose oldest
 * had not been touched in three weeks, and every surface in the product
 * reported the installation as healthy the whole time. Nothing was broken.
 * Nothing said anything. A count alone would not have helped either — "436
 * waiting" looks the same on the day it appears as it does a month later, and
 * it is the AGE that turns a queue into a backlog.
 *
 * So the rules here are mostly about not lying with a number:
 *
 *  - **`oldest_days` is null exactly when nothing is waiting**, and null is an
 *    em dash, never "0 days" (CUI-SEV-2). "The oldest change has waited zero
 *    days" is a sentence about nothing.
 *  - **No threshold, no verdict.** The server refuses to say whether a queue is
 *    too long, because how many pending changes is too many is policy and
 *    belongs to whoever owns the wiki. The console does not get to invent one
 *    either, so the only tone distinction drawn here is the honest one:
 *    something is waiting, or nothing is.
 *  - **Every finding has to lead somewhere.** A report you cannot act from is a
 *    report nobody opens twice, so `findingTarget` answers where a row goes,
 *    and it answers `null` rather than guessing when a finding names nothing.
 *
 * The severity vocabulary is NOT restated here: `system.logic.ts` already owns
 * the `warn` → `warning` translation and the worst-first grouping, and a second
 * reading of the linter's words is how one page ends up calling a warning a
 * note.
 */

export interface Standing {
  label: string
  tone: Tone
}

/**
 * Whether anybody has to do something about the review queue.
 *
 * Two states, not a scale. An empty queue is GOOD NEWS and reads as such
 * (CUI-LOAD-4); a queue with anything in it is `blocked` — stopped until a
 * human acts — which is exactly what a pending change is, whether there is one
 * of them or four hundred. The four hundred is said by the number beside it,
 * and how bad four hundred is remains the reader's judgement.
 */
export function backlogStanding(pending: number): Standing {
  return pending === 0
    ? { label: 'Nothing is waiting', tone: toneFor('succeeded') }
    : { label: 'Waiting for a decision', tone: toneFor('blocked') }
}

/**
 * A whole-day wait, in the words a person would use — or the em dash for a wait
 * that does not exist.
 *
 * Returns the SOURCE phrases rather than formatted German: the caller runs them
 * through the translator, and `{count} days` is interpolated there so the
 * number never has to survive a round trip through a lookup table.
 */
export interface Waited {
  /** A phrase for the translator; `null` when there is nothing to say. */
  phrase: string | null
  values?: Readonly<Record<string, number>>
}

export function waitedDays(days: number | null | undefined): Waited {
  if (days === null || days === undefined || !Number.isFinite(days) || days < 0) return { phrase: null }
  const whole = Math.floor(days)
  if (whole === 0) return { phrase: 'today' }
  if (whole === 1) return { phrase: '1 day' }
  return { phrase: '{count} days', values: { count: whole } }
}

/**
 * The same for the ingest queue, in HOURS.
 *
 * Hours rather than days, and that is the point of a second function: a healthy
 * ingest queue drains in minutes, so "0 days" would read like reassurance about
 * a queue that has been stuck since lunchtime.
 */
export function waitedHours(hours: number | null | undefined): Waited {
  if (hours === null || hours === undefined || !Number.isFinite(hours) || hours < 0) return { phrase: null }
  if (hours < 1) return { phrase: 'under an hour' }
  return { phrase: '{count} h', values: { count: Math.round(hours) } }
}

/** The fields of a lint finding this page routes on. The response carries more. */
export interface RoutableFinding {
  rule: string
  concept_slug?: string
  details?: Readonly<Record<string, unknown>>
}

export interface PresentableLintFinding extends RoutableFinding {
  message: { key: string; args: Readonly<Record<string, unknown>>; default_text: string }
}

/**
 * Render server lint keys in the selected UI language without translating the
 * wiki's own authored content. The structured key is the contract; the English
 * default is only the forward-compatible fallback for a rule this Cockpit does
 * not know yet.
 */
export function lintMessage(locale: Locale, finding: PresentableLintFinding): string {
  if (locale !== 'de') return finding.message.default_text
  const page = finding.concept_slug?.trim() ? `Die Seite „${finding.concept_slug}“` : 'Eine Seite'
  const count = (name: string): number | null => {
    const value = finding.message.args[name]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  switch (finding.message.key) {
    case 'contradictions':
      return `${page} enthält Aussagen, die einander widersprechen.`
    case 'missing-citations':
      return `${page} enthält eine Aussage ohne Quellenbeleg.`
    case 'broken-relations':
      return `${page} verweist auf eine Seite, die nicht gelesen werden kann.`
    case 'stale-claims':
      return `${page} enthält eine Aussage, deren Gültigkeit abgelaufen ist.`
    case 'orphan-concepts':
      return `${page} ist mit keiner anderen Seite verknüpft.`
    case 'unsourced-concepts': {
      const claims = count('claims')
      return claims === null
        ? `${page} stützt sich auf keine archivierte Quelle.`
        : `${page} stützt ${claims === 1 ? 'eine Aussage' : `${claims} Aussagen`} auf keine archivierte Quelle.`
    }
    case 'self-derived-only':
      return `${page} stützt sich nur auf Antworten aus diesem Wiki und braucht eine externe Quelle.`
    case 'stub-concepts':
      return `${page} ist leer: kein Text, keine Aussagen und keine Verknüpfungen.`
    case 'scaffolded-claims':
      return `${page} ist als Verweisziel markiert, enthält aber prüfbare Aussagen.`
    case 'empty-concepts':
      return `${page} enthält keine prüfbare Aussage.`
    case 'unreviewed-proposals':
      return 'Ein Vorschlag wartet auf eine menschliche Prüfung.'
    case 'stale-proposals': {
      const days = count('days_open')
      return days === null
        ? 'Ein Vorschlag wartet schon lange auf eine menschliche Prüfung.'
        : `Ein Vorschlag wartet seit ${days} Tagen auf eine menschliche Prüfung.`
    }
    case 'stale-captures': {
      const days = count('days_parked')
      return days === null
        ? 'Ein Gedanke liegt schon lange im Eingang und muss einsortiert werden.'
        : `Ein Gedanke liegt seit ${days} Tagen im Eingang und muss einsortiert werden.`
    }
    case 'dangling-sources':
      return 'Eine archivierte Quelle wird von keiner Aussage zitiert.'
    case 'tombstoned-sources':
      return `${page} zitiert ein Dokument, das im Ursprung gelöscht wurde.`
    case 'broken-cross-space-links':
      return `${page} enthält einen Verweis in ein anderes Wiki, der kein lesbares Ziel erreicht.`
    case 'missing-charter':
      return 'Dieses Wiki hat keine Leitlinien dafür, was hineingehört.'
    default:
      return finding.message.default_text
  }
}

/**
 * Where a finding goes when somebody clicks it.
 *
 * The page wins over everything else where a finding names one, because the
 * page is where the fix happens: a tombstoned source names both the source and
 * the page whose claims quote it, and the reader's decision — deprecate the
 * claim or not — is made on the page. Findings with no page at all are the two
 * that are about the queues rather than about knowledge: an unreviewed proposal
 * goes to the change, a source nothing cites goes to the source.
 *
 * `null` is a real answer and not a fallback to somewhere plausible. A finding
 * this console cannot route is still worth showing; sending the reader to a
 * list and letting them hunt is worse than a row that plainly does not move.
 */
export type FindingTarget =
  | { kind: 'page'; slug: string }
  | { kind: 'change'; id: string }
  | { kind: 'source'; id: string }
  | { kind: 'inbox' }
  | { kind: 'charter' }
  | null

function textField(details: Readonly<Record<string, unknown>> | undefined, name: string): string | null {
  const value = details?.[name]
  return typeof value === 'string' && value.trim() ? value : null
}

export function findingTarget(finding: RoutableFinding): FindingTarget {
  // The two rules whose fix happens on a PAGE of this console rather than on an
  // object the finding names: a parked thought is processed or discarded in the
  // Inbox, and the missing guidelines are written under Guidelines. Matched by
  // rule before the field probes below, because a captured job's id is an
  // ingest id and none of the detail routes would carry it anywhere.
  if (finding.rule === 'stale-captures') return { kind: 'inbox' }
  if (finding.rule === 'missing-charter') return { kind: 'charter' }
  if (finding.concept_slug?.trim()) return { kind: 'page', slug: finding.concept_slug }
  const proposal = textField(finding.details, 'proposal_id')
  if (proposal) return { kind: 'change', id: proposal }
  const source = textField(finding.details, 'source_id')
  if (source) return { kind: 'source', id: source }
  return null
}

/**
 * Which findings the list RENDERS — the census counts stay untouched.
 *
 * `stale-proposals` and `unreviewed-proposals` deliberately overlap on the
 * server: the info census names every waiting change, the warn rule names the
 * ones a fortnight old. A list printing both rows for one change reads as two
 * problems where there is one queue, so the census row of a change that also
 * has a stale warning is folded into that warning here. The counts strip keeps
 * the full census — it is a census, not a checklist — and `folded` says how
 * many rows the fold absorbed so the page can state it instead of hiding it.
 */
export function displayFindings<T extends RoutableFinding>(
  findings: readonly T[],
): {
  shown: T[]
  folded: number
} {
  const stale = new Set<string>()
  for (const finding of findings) {
    if (finding.rule !== 'stale-proposals') continue
    const id = textField(finding.details, 'proposal_id')
    if (id) stale.add(id)
  }
  if (stale.size === 0) return { shown: [...findings], folded: 0 }
  const shown: T[] = []
  let folded = 0
  for (const finding of findings) {
    const id = finding.rule === 'unreviewed-proposals' ? textField(finding.details, 'proposal_id') : null
    if (id && stale.has(id)) {
      folded += 1
      continue
    }
    shown.push(finding)
  }
  return { shown, folded }
}

/**
 * Why a rule's finding counts — the middle of the three-part row (what the
 * linter said, why it matters, where the fix happens). Static English phrases
 * the translator maps, one per rule; a rule this console does not know yields
 * `null` and the row simply has no help icon, because inventing a rationale
 * for an unknown rule would be the console explaining something it cannot.
 */
const RULE_WHY: Readonly<Record<string, string>> = {
  contradictions:
    'Two visible claims assert different things about the same frame. Readers cannot tell which one the wiki means until a person deprecates one side.',
  'missing-citations':
    'A visible claim quotes no source, so nobody can check it. Verifiable quotes are the whole promise of this wiki.',
  'broken-relations': 'A link points at a page that cannot be read. Whoever follows it lands nowhere.',
  'stale-claims': 'The claim describes a window that has closed. It needs re-verification or retirement.',
  'orphan-concepts':
    'No link leads to or from this page, so graph navigation never finds it. Sometimes that is fine; usually a relation is missing.',
  'unsourced-concepts':
    'No archived document stands behind this page. Adding a source lets synthesis quote real evidence.',
  'self-derived-only':
    'Every source this page quotes came out of the wiki itself. Without outside evidence the wiki is confirming itself.',
  'stub-concepts': 'The page is blank in every sense: no text, no claims, no links. Delete it or give it content.',
  'scaffolded-claims':
    'The page is marked as a reference target yet holds real claims. Until one of the two is fixed, its evidence is withheld from the index.',
  'empty-concepts': 'The page states nothing checkable. Fine for a stub — worth knowing about.',
  'unreviewed-proposals':
    'A change is waiting for a decision. Nothing becomes visible knowledge until a person makes it.',
  'dangling-sources': 'An archived document no claim quotes. Often just a change still waiting for review.',
  'tombstoned-sources':
    'The claim quotes a document deleted upstream. The archived copy remains valid evidence; whether the claim stays is a human call.',
  'broken-cross-space-links':
    'A link into another wiki reaches no readable page there. The link convention is documentation; fixing it keeps documents honest.',
  'missing-charter':
    'Nothing steers what belongs in this wiki. Guidelines are optional — this note makes their absence a choice, not an accident.',
  'stale-proposals': 'This change has waited more than two weeks. Age is what turns a queue into a backlog.',
  'stale-captures':
    'This thought has been parked for over a month. An old inbox item is a signal, not an error — sort and resolve it.',
}

export function ruleWhy(rule: string): string | null {
  return RULE_WHY[rule] ?? null
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/**
 * The two things the in-process worker can be told to do, restated for the
 * browser exactly like the ingest formats in `inbox.logic.ts`: this module
 * compiles for a browser and does not reach into `src/schedule.ts`.
 */
export const SCHEDULE_KINDS: readonly string[] = ['briefing', 'health']

/** 0 = Sunday … 6 = Saturday, matching Postgres' `extract(dow)` and the wire. */
export const WEEKDAYS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
]

/**
 * One row of the schedule form.
 *
 * `frequency` is a separate field from `weekday` rather than "weekday === null
 * means daily", because a form has to remember which weekday the operator
 * picked while they look at what daily would mean. The wire keeps the server's
 * shape — null weekday IS daily — and `scheduleBody` is the one place the two
 * are reconciled.
 */
export interface ScheduleDraft {
  kind: string
  enabled: boolean
  frequency: 'daily' | 'weekly'
  /** HH:MM, 24-hour: what `<input type="time">` produces and what the server accepts. */
  atTime: string
  weekday: number
  /** An IANA zone name — "every morning" has to mean the operator's morning. */
  timezone: string
}

/** The wire rows this form reads. */
export interface ScheduleWire {
  kind: string
  at_time: string
  weekday: number | null
  timezone: string
  enabled: boolean
}

/**
 * Every kind as a row, whether the server has one or not.
 *
 * A kind with no row on the server is NOT missing from this form: it is a
 * schedule that is switched off, and a form that only shows what exists gives
 * an operator no way to switch one on. The defaults are deliberately dull —
 * seven in the morning, in whatever zone the browser is in — because a
 * suggested time somebody has to think about is a form they close.
 */
export function draftsFrom(schedules: readonly ScheduleWire[], fallbackZone: string): ScheduleDraft[] {
  return SCHEDULE_KINDS.map((kind) => {
    const found = schedules.find((entry) => entry.kind === kind)
    if (!found) {
      return {
        kind,
        enabled: false,
        frequency: kind === 'health' ? 'weekly' : 'daily',
        atTime: '07:00',
        weekday: 1,
        timezone: fallbackZone,
      }
    }
    return {
      kind,
      enabled: found.enabled,
      frequency: found.weekday === null ? 'daily' : 'weekly',
      // Postgres hands back `07:00:00`; the form and the wire speak HH:MM.
      atTime: found.at_time.slice(0, 5),
      weekday: found.weekday ?? 1,
      timezone: found.timezone,
    }
  })
}

/**
 * The PUT body: the COMPLETE set, with the switched-off kinds included.
 *
 * Leaving a kind out would also switch it off — the route is a replace — but it
 * would DELETE the row, and with it `last_run_at`, which is the only record
 * that the schedule ever ran. Sending `enabled: false` keeps that telemetry for
 * an operator who switches a report off for a fortnight and then wonders when
 * it last went out.
 */
export function scheduleBody(drafts: readonly ScheduleDraft[]): {
  schedules: { kind: string; at_time: string; weekday: number | null; timezone: string; enabled: boolean }[]
} {
  return {
    schedules: drafts.map((draft) => ({
      kind: draft.kind,
      at_time: draft.atTime,
      weekday: draft.frequency === 'weekly' ? draft.weekday : null,
      timezone: draft.timezone,
      enabled: draft.enabled,
    })),
  }
}

/** HH:MM, 24-hour. Seconds are not offered: a report that fires at 07:00:30 is one nobody meant to write. */
const AT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Whether the runtime's zone database knows this name.
 *
 * Asked of `Intl` rather than matched against a pattern, for the same reason
 * the server asks its runtime: `Europe/Berlin` and `Europe/Berlyn` are
 * indistinguishable to any regex, and the second one would otherwise only fail
 * later, inside a tick, on a row nobody is looking at.
 */
export function isTimeZoneName(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * What stops this form from being saved, in the operator's words, or `null`.
 *
 * Said before the request rather than after it: the server's refusal is a 400
 * naming one field, and an operator who mistyped a zone should not have to
 * spend a round trip to learn which of two rows it was in. The server's check
 * remains the real one; this is the courtesy copy.
 *
 * A switched-off row is not checked at all. Its time and zone still travel, but
 * nothing fires on them, and refusing to save a working briefing because the
 * care report somebody disabled last month has an empty zone would be the form
 * blocking on a field that does nothing.
 */
export function scheduleProblem(drafts: readonly ScheduleDraft[]): string | null {
  for (const draft of drafts) {
    if (!draft.enabled) continue
    if (!AT_TIME.test(draft.atTime)) return 'A time has to read HH:MM, in 24 hours.'
    if (!isTimeZoneName(draft.timezone)) return 'That is not a time zone this browser knows.'
  }
  return null
}
