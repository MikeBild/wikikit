// Scheduled maintenance — the worker that makes the loop turn without anyone
// triggering it (plan Phase 4, CONTRACTS §4, table §1 wk_schedules).
//
// WHY this exists at all: every hygiene surface WikiKit has is PULL. lintSpace,
// coverage stats and the review queue are all endpoints someone has to think to
// call, and the production finding that motivated this module is what happens
// when nobody does — 436 pending proposals in one wiki, the oldest untouched for
// three weeks, with the server perfectly healthy the whole time. Nothing was
// broken; nothing said anything. So the briefing exists to say it, and it says
// the AGE of the oldest waiting change, not only the count, because a count of
// 436 looks the same on the day it appears as it does a month later.
//
// WHY in-process rather than an external trigger: WikiKit ships as one binary an
// operator starts once. A cron entry calling back in would need a credential, a
// URL, and a second thing to keep alive — three ways for "every morning" to stop
// happening silently. The durable state is the wk_schedules row; this module is
// only a timer over it, exactly as src/webhooks.ts is a timer over the outbox
// and src/ingest/pipeline.ts is a timer over the job queue.
//
// The claim discipline is the pipeline's, deliberately: a due row is taken with
// FOR UPDATE SKIP LOCKED and its next_run_at is advanced INSIDE the claiming
// transaction, so two binaries against one database produce exactly ONE briefing
// per window — the second one finds the row locked, then finds it not due. That
// is the property the integration test asserts.
//
// Two ways this is SIMPLER than the ingest pipeline, both on purpose:
//   * No lease, no heartbeat, no reaper. Both job bodies are LLM-free and
//     finish in milliseconds, so the crash window a lease protects against is
//     not worth a column. next_run_at is advanced BEFORE the body runs, which
//     trades "a crashed run loses that window's briefing" for "two instances can
//     never both write one". A missing briefing is repaired by tomorrow's; a
//     duplicate briefing is noise in the record forever.
//   * One loop, not N. Schedules fire at most twice a day per wiki, so there is
//     nothing to parallelise and SKIP LOCKED already arbitrates the fleet.
//
// WHY the briefing spends no model tokens: it is an assembly of counts, titles
// and slugs — no prose, no synthesis. A daily job that costs money is a daily
// job somebody switches off, and the moment it is switched off the wiki goes
// quiet again in exactly the way this module exists to prevent. It also makes
// the output deterministic, so a test can assert its content instead of its
// shape.
//
// NOT here, deliberately: no e-mail. Delivery is the Output row plus the
// wikikit.health.reported webhook; an installation that wants mail hangs a
// consumer off the webhook rather than putting an SMTP client in the binary.
//
// One name to keep straight: the 'briefing' this module writes is a MAINTENANCE
// report for the operator (what moved, what waits, where it is thin). It is not
// src/agent/briefing.ts, which builds a token-budgeted digest of concept pages
// for an agent starting a session. Same word, different reader, no shared code.
import { z } from 'zod'
import type { Db } from './db/postgres.ts'
import type { Logger } from './logger.ts'
import { recordOutput as recordOutputImpl } from './domain/outputs.ts'
import {
  spaceHealth as spaceHealthImpl,
  type SpaceHealth,
  type SpaceHealthArgs,
  type SpaceHealthDeps,
} from './domain/health.ts'
import { isoString } from './domain/sources.ts'
import { DEFAULT_SOURCE_INDEX_DAYS } from './config.ts'

const DAY_MS = 86_400_000

/** Poll interval. Schedules have minute resolution, so 30s is already twice as precise as the data. */
const DEFAULT_POLL_MS = 30_000

/** Bounds on what one generated document lists, so a wiki with 400 findings does not produce a 400-line report. */
const MAX_ITEMS_PER_SECTION = 20

export const SCHEDULE_KINDS = ['briefing', 'health'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

// ---------------------------------------------------------------------------
// Wire + input contract
//
// zod at the boundary because three callers reach these functions: the REST
// route (GET|PUT /v1/spaces/{space}/schedules), a future MCP surface, and the
// scheduler's own seeding path. The timezone check is the interesting one — it
// asks the runtime's zone database rather than matching a pattern, because
// "Europe/Berlin" and "Europe/Berlyn" are indistinguishable to any regex and
// the second one would only fail later, inside a tick, on a row nobody is
// looking at.

/** HH:MM, 24-hour. Seconds are not offered: a schedule that fires at 07:00:30 is a schedule nobody meant to write. */
const AT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached) return cached
  // hourCycle h23 so midnight reads as 00 rather than 24 — the difference
  // silently breaks the fixed-point search below.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  formatters.set(timeZone, formatter)
  return formatter
}

/** True when the runtime's zone database knows this name. */
export function isTimeZone(value: string): boolean {
  try {
    formatterFor(value)
    return true
  } catch {
    return false
  }
}

export const zScheduleInput = z.object({
  kind: z.enum(SCHEDULE_KINDS),
  at_time: z.string().regex(AT_TIME, 'at_time must be HH:MM (24-hour)'),
  /** null (or omitted) = daily; 0 = Sunday … 6 = Saturday. */
  weekday: z.number().int().min(0).max(6).nullish(),
  timezone: z.string().refine(isTimeZone, 'unknown IANA time zone'),
  enabled: z.boolean().optional(),
})
export type ScheduleInput = z.infer<typeof zScheduleInput>

/**
 * The PUT body: the COMPLETE set of schedules for a wiki, not a patch.
 *
 * A replace rather than a per-kind POST/DELETE pair because there are exactly
 * two kinds and one row each — "here is what I want running" is a sentence an
 * operator can hold in their head, and it makes the route idempotent for free.
 * A kind left out of the body is switched off; that loses its last_run_at, which
 * is telemetry about a schedule that no longer exists.
 */
export const zScheduleSet = z
  .object({ schedules: z.array(zScheduleInput).max(SCHEDULE_KINDS.length) })
  .refine(
    (value) => new Set(value.schedules.map((entry) => entry.kind)).size === value.schedules.length,
    'one schedule per kind (unique on space + kind)',
  )
export type ScheduleSet = z.infer<typeof zScheduleSet>

/**
 * The briefing a NEW wiki starts with — `WIKIKIT_DEFAULT_BRIEFING`, parsed.
 *
 * WHY a default at all: a timetable nobody switched on reports nothing, and the
 * one number this whole surface exists to publish — how long the oldest
 * undecided change has been waiting — is exactly the number that goes unnoticed
 * while it accrues. A wiki that has to be armed by hand is armed on the day
 * somebody remembers, which is after it mattered.
 *
 * WHY one variable and not three: `07:00`, `07:00 Europe/Berlin` and `off` are
 * the whole vocabulary. Splitting the time, the zone and the on/off switch into
 * separate keys makes three things an operator has to keep consistent to
 * express one intention.
 *
 * WHY UTC when no zone is given: the server has no other zone to know. A
 * product that defaulted to its author's zone would be wrong for everybody
 * else, and silently — so the default is the one zone that is never a guess,
 * and the cockpit shows what was seeded so it can be corrected in one edit.
 *
 * Only a briefing is seeded, never a health report: the briefing is LLM-free
 * and therefore free, while the weekly health report is a heavier document that
 * an empty wiki has nothing to say in.
 */
export interface DefaultBriefing {
  at_time: string
  timezone: string
}

/**
 * Parse `WIKIKIT_DEFAULT_BRIEFING`. Returns null for `off`/empty (seed nothing)
 * and THROWS on anything else it cannot read — a typo in a schedule is a
 * schedule that fires at a time nobody chose, so it refuses to boot rather than
 * quietly falling back to a default the operator did not write.
 */
export function parseDefaultBriefing(raw: string): DefaultBriefing | null {
  const value = raw.trim()
  if (!value || value.toLowerCase() === 'off') return null
  const [at_time, zone, ...rest] = value.split(/\s+/)
  if (rest.length)
    throw new Error(`WIKIKIT_DEFAULT_BRIEFING must be "HH:MM", "HH:MM <IANA zone>" or "off" (got "${raw}")`)
  if (!AT_TIME.test(at_time ?? ''))
    throw new Error(`WIKIKIT_DEFAULT_BRIEFING time must be HH:MM (24-hour), got "${at_time ?? ''}"`)
  const timezone = zone ?? 'UTC'
  if (!isTimeZone(timezone)) throw new Error(`WIKIKIT_DEFAULT_BRIEFING names an unknown IANA time zone: "${timezone}"`)
  return { at_time: at_time!, timezone }
}

export interface ScheduleWire {
  kind: ScheduleKind
  at_time: string
  weekday: number | null
  timezone: string
  enabled: boolean
  last_run_at: string | null
  next_run_at: string | null
}

interface ScheduleRow {
  id: string
  space_id: string
  kind: ScheduleKind
  at_time: string
  weekday: number | null
  timezone: string
  enabled: boolean
  last_run_at: string | Date | null
  next_run_at: string | Date | null
}

/** Postgres hands back `07:00:00`; the wire (and the input) speak HH:MM. */
function atTimeToWire(value: string): string {
  return String(value).slice(0, 5)
}

function toWire(row: ScheduleRow): ScheduleWire {
  return {
    kind: row.kind,
    at_time: atTimeToWire(row.at_time),
    weekday: row.weekday === null || row.weekday === undefined ? null : Number(row.weekday),
    timezone: row.timezone,
    enabled: row.enabled,
    last_run_at: row.last_run_at == null ? null : isoString(row.last_run_at),
    next_run_at: row.next_run_at == null ? null : isoString(row.next_run_at),
  }
}

// ---------------------------------------------------------------------------
// Due-time arithmetic — PURE, so it can be unit-tested across zones and a DST
// transition without a database, a clock or a running worker.

export interface ScheduleWindow {
  /** HH:MM or Postgres' HH:MM:SS — both accepted, since one comes from the wire and one from a row. */
  at_time: string
  /** null = daily; 0 = Sunday … 6 = Saturday. */
  weekday: number | null
  /** IANA zone name. */
  timezone: string
}

interface ZoneParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The wall clock this instant shows in `timeZone`. */
function zoneParts(timeZone: string, instant: Date): ZoneParts {
  const parts = formatterFor(timeZone).formatToParts(instant)
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)
    return Number(part?.value)
  }
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

/** UTC offset in force at `instant` (local minus UTC), derived from the formatter rather than a table. */
function offsetMs(timeZone: string, instant: Date): number {
  const parts = zoneParts(timeZone, instant)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  // The formatter has second resolution; drop the instant's milliseconds so
  // the difference is the offset and nothing else.
  return asUtc - (instant.getTime() - (instant.getTime() % 1000))
}

/**
 * The instant at which `timeZone` shows this wall clock.
 *
 * DST makes this a two-answer question and both answers are handled explicitly,
 * following Temporal's 'compatible' disambiguation so the behaviour matches what
 * every other scheduler does:
 *   * FOLD (the hour that happens twice, autumn): the wall clock is valid at two
 *     instants and the EARLIER one wins — the run happens once, on the first
 *     pass, and the second pass is already behind next_run_at.
 *   * GAP (the hour that never happens, spring): neither candidate shows the
 *     requested wall clock, and the pre-transition offset is used, which lands
 *     one hour later in local terms (02:30 becomes 03:30). A 02:30 briefing
 *     fires late once a year rather than being skipped for the day.
 * The two offsets are sampled a day either side of the target, which is safe
 * because no zone transitions twice within 24 hours.
 */
function instantForWallClock(
  timeZone: string,
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  const before = offsetMs(timeZone, new Date(naive - DAY_MS))
  const after = offsetMs(timeZone, new Date(naive + DAY_MS))
  for (const candidate of [naive - before, naive - after]) {
    const parts = zoneParts(timeZone, new Date(candidate))
    if (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) === naive) return candidate
  }
  return naive - before
}

function parseAtTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = String(value).split(':')
  return { hour: Number(hour), minute: Number(minute) }
}

/**
 * The next instant this schedule is due after `from`, strictly after it.
 *
 * Walks forward over LOCAL calendar days (not fixed 24-hour steps) because the
 * whole point of storing a wall clock is that 07:00 stays 07:00 on the day a
 * zone shifts by an hour. Nine candidates is the bound: a weekly schedule whose
 * weekday is today-but-already-past needs seven more days, plus one for the day
 * boundary the local date may sit on.
 */
export function computeNextRun(schedule: ScheduleWindow, from: Date): Date {
  const timeZone = schedule.timezone || 'UTC'
  const { hour, minute } = parseAtTime(schedule.at_time)
  const start = zoneParts(timeZone, from)
  for (let offset = 0; offset <= 8; offset++) {
    // Civil-date arithmetic in UTC: a plain calendar walk with no zone in it,
    // which is also where the weekday comes from (getUTCDay and Postgres
    // extract(dow) agree on 0 = Sunday).
    const civil = new Date(Date.UTC(start.year, start.month - 1, start.day) + offset * DAY_MS)
    if (schedule.weekday != null && civil.getUTCDay() !== schedule.weekday) continue
    const candidate = instantForWallClock(
      timeZone,
      { year: civil.getUTCFullYear(), month: civil.getUTCMonth() + 1, day: civil.getUTCDate() },
      hour,
      minute,
    )
    if (candidate > from.getTime()) return new Date(candidate)
  }
  // Unreachable for any weekday in [0,6]; a row that got past the CHECK and the
  // zod schema with something else must not spin the loop silently.
  throw new Error(`no due time within 9 days for schedule (weekday=${String(schedule.weekday)})`)
}

// ---------------------------------------------------------------------------
// Read/write surface for the REST route
//
// It lives here rather than in src/http so the HTTP layer keeps writing no SQL,
// and so the route cannot arm a schedule with a different notion of "next" than
// the worker uses: both call computeNextRun.

export async function listSchedules(db: Db, spaceId: string): Promise<ScheduleWire[]> {
  const rows = await db.select<ScheduleRow>('wk_schedules', { space_id: `eq.${spaceId}`, order: 'kind.asc' })
  return rows.map(toWire)
}

/**
 * Replace a wiki's schedule set (PUT semantics).
 *
 * One transaction: the delete of the kinds that are gone and the upsert of the
 * kinds that stay must not be observable half-applied by a poll in between —
 * that window is precisely a briefing that fires with the old time or not at
 * all. The armed instant is computed HERE as well as in the worker, so a
 * schedule saved while WIKIKIT_SCHEDULER_ENABLED is false is still correct the
 * moment the feature is switched on.
 */
export async function replaceSchedules(db: Db, spaceId: string, args: unknown): Promise<ScheduleWire[]> {
  const input = zScheduleSet.parse(args)
  const now = new Date()
  return db.tx(async (tx) => {
    const kinds = input.schedules.map((entry) => entry.kind)
    // An empty array deletes every kind — a PUT with no schedules is how an
    // operator turns the whole thing off, and it must mean that.
    await tx.query(`DELETE FROM wk_schedules WHERE space_id = $1 AND kind <> ALL($2::text[])`, [spaceId, kinds])
    for (const entry of input.schedules) {
      const enabled = entry.enabled ?? true
      const window: ScheduleWindow = {
        at_time: entry.at_time,
        weekday: entry.weekday ?? null,
        timezone: entry.timezone,
      }
      await tx.insert(
        'wk_schedules',
        {
          space_id: spaceId,
          kind: entry.kind,
          at_time: entry.at_time,
          weekday: window.weekday,
          timezone: entry.timezone,
          enabled,
          // A disabled schedule is disarmed, not armed-and-skipped: NULL keeps
          // it out of the claim query and out of the partial index.
          next_run_at: enabled ? computeNextRun(window, now).toISOString() : null,
        },
        // last_run_at is deliberately NOT in the column list, so an upsert
        // preserves it: "when did this last run" survives a time change.
        { upsert: true, onConflict: 'space_id,kind', returning: false },
      )
    }
    return listSchedules(tx, spaceId)
  })
}

/**
 * Arm the default briefing on a wiki that was just created.
 *
 * BEST EFFORT ON PURPOSE, and outside the space's own insert: a wiki that
 * exists without a timetable is a wiki somebody can arm in one edit, while a
 * create that rolled back because a schedule row failed is a wiki that does not
 * exist for a reason nobody asked about. Same discipline as the read counters in
 * domain/coverage.ts — a failed convenience never fails the thing it decorates.
 *
 * It goes through replaceSchedules rather than its own INSERT so the seeded row
 * is computed by the same code that computes an operator's row: one producer of
 * next_run_at, and the upsert keeps this idempotent if a caller repeats it.
 */
export async function seedDefaultBriefing(
  db: Db,
  spaceId: string,
  spec: DefaultBriefing | null,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<boolean> {
  if (!spec) return false
  try {
    await replaceSchedules(db, spaceId, {
      schedules: [{ kind: 'briefing', at_time: spec.at_time, weekday: null, timezone: spec.timezone, enabled: true }],
    })
    return true
  } catch (error) {
    logger?.warn('could not seed the default briefing schedule', { space_id: spaceId, error: String(error) })
    return false
  }
}

// ---------------------------------------------------------------------------
// Worker

export interface Scheduler {
  /** Begin polling. A no-op when the feature is off, so app.ts calls it unconditionally. */
  start(): void
  /** Stop claiming and wait for an in-flight job — the SIGTERM drain awaits this. */
  stop(): Promise<void>
  /**
   * Claim and run at most one due schedule; returns whether one ran. start() is
   * nothing but this in a loop, and tests (and the two-instance integration
   * test) drive it directly instead of racing a timer.
   */
  runOnce(): Promise<boolean>
}

/**
 * The Output writer, as a type rather than an import of the implementation's
 * signature: a unit test drives the loop with a stub, and this module then never
 * learns the Output table's shape — src/domain/outputs.ts owns that. `kind` is
 * narrowed to the two the scheduler may write; 'answer' belongs to /query.
 */
export type RecordOutputFn = (
  db: Db,
  spaceId: string,
  args: {
    kind: ScheduleKind
    title: string
    markdown: string
    citations?: { slug: string; title: string }[]
  },
) => Promise<{ id: string }>

/**
 * The composed health surface, injected rather than reached for, so the loop is
 * testable without lint's fourteen queries behind it. The type is the real
 * signature from src/domain/health.ts on purpose: a structural restatement here
 * would be a second definition of a shape that module documents at length, and
 * the whole argument for it being a domain module is that the route, the MCP tool
 * and this worker report the SAME numbers.
 */
export type SpaceHealthFn = (
  db: Db,
  spaceId: string,
  args: SpaceHealthArgs,
  deps: SpaceHealthDeps,
) => Promise<SpaceHealth>

export interface SchedulerDeps {
  db: Db
  logger: Logger
  /** Clock; injected so a test can place a run inside a DST window. */
  now?: () => number
  /** Poll interval. A test knob, not an env var — ops never tunes this. */
  pollMs?: number
  /** Output writer; defaults to the domain implementation. */
  recordOutput?: RecordOutputFn
  /** Composed health surface; defaults to the domain implementation. */
  spaceHealth?: SpaceHealthFn
}

/**
 * The slice of Config this worker reads. Named fields rather than the whole
 * Config so the dependency is visible: only the first is the scheduler's own
 * setting, the rest are installation facts spaceHealth requires, and passing
 * them through here keeps this module from inventing its own defaults for them
 * (the reason `scaffoldingKinds` is required in Config in the first place).
 */
export interface SchedulerConfig {
  /** WIKIKIT_SCHEDULER_ENABLED (default true). Undefined counts as on. */
  readonly schedulerEnabled?: boolean
  readonly scaffoldingKinds: readonly string[]
  readonly coverageGapTopicsEnabled?: boolean
  /** WIKIKIT_SOURCE_INDEX_DAYS; absent falls back to DEFAULT_SOURCE_INDEX_DAYS (0 = indexed forever). */
  readonly sourceIndexDays?: number
}

interface ClaimedSchedule extends ScheduleRow {
  /** last_run_at as it stood BEFORE the claim advanced it — the briefing's window start. */
  previous_run_at: Date | null
}

function oneLine(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function localDate(timeZone: string, instant: Date): string {
  const parts = zoneParts(timeZone, instant)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
}

function localStamp(timeZone: string, instant: Date): string {
  const parts = zoneParts(timeZone, instant)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${localDate(timeZone, instant)} ${pad(parts.hour)}:${pad(parts.minute)}`
}

/** `- item` lines, capped, with an honest tail instead of a truncated one. */
function bulletList(items: string[], language: 'en' | 'de' = 'en'): string[] {
  const shown = items.slice(0, MAX_ITEMS_PER_SECTION).map((item) => `- ${item}`)
  const hidden = items.length - shown.length
  if (hidden > 0) shown.push(language === 'de' ? `- …und ${hidden} weitere` : `- …and ${hidden} more`)
  return shown
}

/**
 * "Where the wiki is thin", written the one way that stays honest.
 *
 * The enabled flag travels with the list because an empty list means two
 * different things — no unanswered question was recorded, or nothing was ever
 * recorded because the installation does not collect them — and a report that
 * prints "no gaps" for the second one is telling the operator their wiki is
 * complete. Same reasoning as the gap_topics wrapper in src/domain/health.ts;
 * both documents render through here so neither can drift into the cheerful
 * version.
 */
function thinSection(
  gaps: { enabled: boolean; items: { lexeme: string; count: number }[] },
  language: 'en' | 'de' = 'en',
): string[] {
  if (!gaps.enabled) {
    return [
      language === 'de'
        ? 'Nicht gemessen – diese Installation erfasst keine unbeantworteten Fragen.'
        : 'Not measured — this installation does not record unanswered questions.',
    ]
  }
  if (!gaps.items.length) {
    return [language === 'de' ? 'Es wurde keine unbeantwortete Frage erfasst.' : 'No unanswered question was recorded.']
  }
  return [
    language === 'de'
      ? 'Themen, zu denen das Wiki keine Antwort hatte:'
      : 'Questions the wiki could not answer, by topic:',
    '',
    ...bulletList(gaps.items.map((topic) => `${topic.lexeme} — ${topic.count}`)),
  ]
}

// ---------------------------------------------------------------------------
// Briefing facts — five small space-scoped queries, no LLM, no joins beyond
// what "which pages changed" needs.

export interface BriefingFacts {
  since: string | null
  until: string
  timezone: string
  approved: { count: number; titles: string[] }
  concepts: { slug: string; title: string }[]
  pending: { count: number; oldest_days: number | null; oldest_since: string | null; oldest_title: string | null }
  thin: { enabled: boolean; items: { lexeme: string; count: number }[] }
  inbox: { queued: number; failed_since: number }
}

async function collectBriefingFacts(
  db: Db,
  spaceId: string,
  window: { since: Date; until: Date; timezone: string; sinceIsReal: boolean; gapTopicsEnabled: boolean },
): Promise<BriefingFacts> {
  const since = window.since.toISOString()

  const approved = await db.query<{ title: string }>(
    `SELECT title
       FROM wk_change_proposals
      WHERE space_id = $1 AND status = 'approved' AND reviewed_at > $2
      ORDER BY reviewed_at DESC`,
    [spaceId, since],
  )

  // Which pages the approvals actually landed on. Through the proposal (not the
  // revision's own created_at) because a revision is created when it is
  // PROPOSED and can wait weeks for review — the briefing reports what became
  // visible in this window, which is the reviewer's timestamp.
  const concepts = await db.query<{ slug: string; title: string }>(
    `SELECT DISTINCT c.slug, r.title
       FROM wk_change_proposals p
       JOIN wk_concept_revisions r ON r.proposal_id = p.id AND r.status = 'current'
       JOIN wk_concepts c ON c.id = r.concept_id
      WHERE p.space_id = $1 AND p.status = 'approved' AND p.reviewed_at > $2
      ORDER BY c.slug`,
    [spaceId, since],
  )

  // The PROD finding, in one row: not just how many are waiting but how long
  // the oldest has waited, and which one it is. A count alone reads identically
  // on the day the backlog appears and a month later.
  const pending = await db.query<{
    count: number
    oldest_days: number | null
    oldest_since: string | Date | null
    oldest_title: string | null
  }>(
    `SELECT count(*)::int AS count,
            floor(extract(epoch FROM now() - min(created_at)) / 86400)::int AS oldest_days,
            min(created_at) AS oldest_since,
            (SELECT title FROM wk_change_proposals
              WHERE space_id = $1 AND status = 'pending'
              ORDER BY created_at ASC LIMIT 1) AS oldest_title
       FROM wk_change_proposals
      WHERE space_id = $1 AND status = 'pending'`,
    [spaceId],
  )

  // Where the wiki is thin: the stemmed lexemes of questions /query answered
  // with "not in the knowledge base" (opt-in telemetry — an empty list is the
  // normal state of an installation that never switched it on).
  const thin = await db.query<{ lexeme: string; count: number }>(
    `SELECT lexeme, count(*)::int AS count
       FROM wk_coverage_gaps
      WHERE space_id = $1 AND created_at > $2
      GROUP BY lexeme
      ORDER BY count(*) DESC, lexeme ASC
      LIMIT 10`,
    [spaceId, since],
  )

  // The other half of "what needs you": sources that arrived and have not
  // produced a proposal yet, plus ingests that died in this window. A wiki whose
  // inbox is quietly failing looks exactly like a wiki nobody fed.
  const inbox = await db.query<{ queued: number; failed_since: number }>(
    `SELECT count(*) FILTER (WHERE status IN ('queued', 'running', 'quota_blocked'))::int AS queued,
            count(*) FILTER (WHERE status = 'failed' AND coalesce(finished_at, created_at) > $2)::int AS failed_since
       FROM wk_ingest_jobs
      WHERE space_id = $1`,
    [spaceId, since],
  )

  return {
    since: window.sinceIsReal ? since : null,
    until: window.until.toISOString(),
    timezone: window.timezone,
    approved: { count: approved.rows.length, titles: approved.rows.map((row) => oneLine(row.title)) },
    concepts: concepts.rows.map((row) => ({ slug: row.slug, title: oneLine(row.title) })),
    pending: {
      count: Number(pending.rows[0]?.count ?? 0),
      oldest_days: pending.rows[0]?.oldest_days == null ? null : Number(pending.rows[0].oldest_days),
      oldest_since: pending.rows[0]?.oldest_since == null ? null : isoString(pending.rows[0].oldest_since),
      oldest_title: pending.rows[0]?.oldest_title == null ? null : oneLine(pending.rows[0].oldest_title),
    },
    thin: {
      enabled: window.gapTopicsEnabled,
      items: thin.rows.map((row) => ({ lexeme: row.lexeme, count: Number(row.count) })),
    },
    inbox: {
      queued: Number(inbox.rows[0]?.queued ?? 0),
      failed_since: Number(inbox.rows[0]?.failed_since ?? 0),
    },
  }
}

/**
 * The briefing document — pure, so its content is a unit test rather than a
 * screenshot.
 *
 * It carries its window in the text, which makes it NOT content-hash stable
 * across runs. That is right for a dated report and is the opposite requirement
 * to renderOutputSource, whose determinism exists so promoting one answer twice
 * dedupes: a briefing is about a window, and two windows are two documents.
 */
export function renderBriefing(
  facts: BriefingFacts,
  options: { language?: 'en' | 'de' | 'simple'; space?: string } = {},
): string {
  const language = options.language === 'de' ? 'de' : 'en'
  const lines: string[] = []
  const until = new Date(facts.until)
  lines.push(`# ${language === 'de' ? 'Kurzbericht' : 'Briefing'} — ${localDate(facts.timezone, until)}`, '')
  lines.push(
    facts.since
      ? `${language === 'de' ? 'Zeitraum' : 'Window'}: ${localStamp(facts.timezone, new Date(facts.since))} → ${localStamp(facts.timezone, until)} (${facts.timezone})`
      : language === 'de'
        ? `Zeitraum: bis ${localStamp(facts.timezone, until)} (${facts.timezone}) – erster Lauf, daher gibt es keinen früheren Bericht zum Vergleichen.`
        : `Window: up to ${localStamp(facts.timezone, until)} (${facts.timezone}) — first run, so no earlier briefing to measure from.`,
    '',
  )

  lines.push(language === 'de' ? '## Seit dem letzten Bericht übernommen' : '## Approved since the last briefing', '')
  if (facts.approved.count === 0) {
    lines.push(
      language === 'de' ? 'In diesem Zeitraum wurde nichts freigegeben.' : 'Nothing was approved in this window.',
      '',
    )
  } else {
    lines.push(
      language === 'de'
        ? `${facts.approved.count} Änderung(en) freigegeben; ${facts.concepts.length} Seite(n) sind jetzt sichtbar.`
        : `${facts.approved.count} change(s) approved, ${facts.concepts.length} page(s) now visible.`,
      '',
    )
    lines.push(...bulletList(facts.approved.titles, language), '')
    if (facts.concepts.length) {
      lines.push(language === 'de' ? 'Seiten:' : 'Pages:', '')
      lines.push(
        ...bulletList(
          facts.concepts.map((concept) => `${concept.title} (\`${concept.slug}\`)`),
          language,
        ),
        '',
      )
    }
  }

  lines.push(language === 'de' ? '## Was du entscheiden musst' : '## What you need to decide', '')
  if (facts.pending.count === 0) {
    lines.push(
      language === 'de'
        ? 'Es wartet keine Wissensänderung auf deine Entscheidung.'
        : 'No knowledge change is waiting for your decision.',
      '',
    )
  } else {
    const age =
      facts.pending.oldest_days == null
        ? language === 'de'
          ? 'Alter unbekannt'
          : 'unknown age'
        : language === 'de'
          ? `${facts.pending.oldest_days} Tag(e)${facts.pending.oldest_since ? ` (seit ${localDate(facts.timezone, new Date(facts.pending.oldest_since))})` : ''}`
          : `${facts.pending.oldest_days} day(s) old${facts.pending.oldest_since ? ` (since ${localDate(facts.timezone, new Date(facts.pending.oldest_since))})` : ''}`
    lines.push(
      language === 'de'
        ? `${facts.pending.count} Wissensänderung(en) warten auf Prüfung.`
        : `${facts.pending.count} knowledge change(s) await review.`,
      '',
    )
    lines.push(
      `${language === 'de' ? 'Älteste' : 'Oldest'}: ${age}${facts.pending.oldest_title ? ` — ${facts.pending.oldest_title}` : ''}`,
      '',
    )
    if (options.space) {
      lines.push(
        `[${language === 'de' ? 'Entscheidungen öffnen' : 'Open decisions'}](/cockpit/decisions?space=${encodeURIComponent(options.space)})`,
        '',
      )
    }
  }

  lines.push(language === 'de' ? '## Wo Wissen fehlt' : '## Where the wiki is thin', '')
  lines.push(...thinSection(facts.thin, language), '')

  lines.push(language === 'de' ? '## Eingang' : '## Inbox', '')
  lines.push(
    language === 'de'
      ? `${facts.inbox.queued} Quelle(n) werden noch verarbeitet; ${facts.inbox.failed_since} Verarbeitung(en) sind in diesem Zeitraum fehlgeschlagen.`
      : `${facts.inbox.queued} source(s) still being processed; ${facts.inbox.failed_since} ingest(s) failed in this window.`,
    '',
  )

  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * The health document — same discipline as the briefing: pure, bounded,
 * LLM-free, and rendering only what spaceHealth measured.
 *
 * It states no verdict, because the shape it reads deliberately carries none:
 * "3 faults" is a fact, "degraded" is a policy, and health.ts explains at length
 * why the policy belongs to the operator. This renderer's whole job is to make
 * the census readable in a document somebody skims over coffee.
 */
export function renderHealth(
  health: SpaceHealth,
  at: { timezone: string; instant: Date; language?: 'en' | 'de' | 'simple' },
): string {
  const language = at.language === 'de' ? 'de' : 'en'
  const findings = health.lint.findings
  const counts = health.lint.counts
  const lines: string[] = []
  lines.push(`# ${language === 'de' ? 'Prüfbericht' : 'Health'} — ${localDate(at.timezone, at.instant)}`, '')
  lines.push(
    language === 'de'
      ? `${counts.error} Fehler, ${counts.warn} Warnung(en) und ${counts.info} Hinweis(e) in ${findings.length} Befund(en).`
      : `${counts.error} fault(s), ${counts.warn} warning(s), ${counts.info} note(s) across ${findings.length} finding(s).`,
    '',
  )

  for (const [severity, heading] of [
    ['error', language === 'de' ? 'Fehler' : 'Faults'],
    ['warn', language === 'de' ? 'Warnungen' : 'Warnings'],
    ['info', language === 'de' ? 'Hinweise' : 'Notes'],
  ] as const) {
    const scoped = findings.filter((finding) => finding.severity === severity)
    if (!scoped.length) continue
    lines.push(`## ${heading}`, '')
    lines.push(
      ...bulletList(
        scoped.map((finding) => {
          const where = finding.concept_slug ? ` (\`${finding.concept_slug}\`)` : ''
          return `${finding.rule}: ${oneLine(finding.message)}${where}`
        }),
        language,
      ),
      '',
    )
  }

  lines.push(language === 'de' ? '## Was du entscheiden musst' : '## What you need to decide', '')
  const { pending, oldest_days: oldestDays } = health.review_queue
  lines.push(
    pending === 0
      ? language === 'de'
        ? 'Es wartet keine Wissensänderung auf Prüfung.'
        : 'No knowledge change is waiting for review.'
      : language === 'de'
        ? `${pending} Wissensänderung(en) warten auf Prüfung; die älteste wartet ${oldestDays == null ? 'seit unbekannter Zeit' : `${oldestDays} Tag(e)`}.`
        : `${pending} knowledge change(s) await review; oldest ${oldestDays == null ? 'of unknown age' : `${oldestDays} day(s) old`}.`,
    '',
  )

  const freshness = health.coverage.freshness
  lines.push(language === 'de' ? '## Aktualität' : '## Freshness', '')
  // The pair, never a share: health.ts refuses a ratio whose denominator can be
  // zero, and a document is no place to reintroduce one.
  lines.push(
    language === 'de'
      ? `${freshness.concepts} Seite(n); ${freshness.stale_over_90d} seit mehr als 90 Tagen unverändert.`
      : `${freshness.concepts} page(s); ${freshness.stale_over_90d} untouched for over 90 days.`,
    '',
  )

  lines.push(language === 'de' ? '## Wo Wissen fehlt' : '## Where the wiki is thin', '')
  lines.push(...thinSection(health.coverage.gap_topics, language), '')

  const queue = health.ingest_queue
  lines.push(language === 'de' ? '## Eingang' : '## Inbox', '')
  lines.push(
    language === 'de'
      ? `${queue.depth} Quelle(n) in Verarbeitung (${queue.queued} wartend, ${queue.running} laufend)` +
          `${queue.quota_blocked ? `, ${queue.quota_blocked} wegen eines Anbieterlimits pausiert` : ''}.`
      : `${queue.depth} source(s) in flight (${queue.queued} queued, ${queue.running} running)` +
          `${queue.quota_blocked ? `, ${queue.quota_blocked} parked on a provider quota window` : ''}.`,
    '',
  )
  // Parked thoughts get their own sentence, not a clause in the flight count:
  // they are waiting for a decision, not for a worker, and the age is the fact
  // the stale-captures rule turns into a warning at thirty days.
  if (queue.captured) {
    lines.push(
      language === 'de'
        ? `${queue.captured} Notiz(en) warten auf Einordnung${queue.oldest_captured_days == null ? '' : `; älteste ${queue.oldest_captured_days} Tag(e)`}.`
        : `${queue.captured} thought(s) parked${queue.oldest_captured_days == null ? '' : `; oldest ${queue.oldest_captured_days} day(s)`}.`,
      '',
    )
  }

  return `${lines.join('\n').trimEnd()}\n`
}

export function createScheduler(deps: SchedulerDeps, config: SchedulerConfig): Scheduler {
  const { db, logger } = deps
  const now = deps.now ?? Date.now
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS
  // The domain implementations are the defaults; the deps exist so a unit test
  // (and the two-instance integration test) can drive the loop without standing
  // up the whole read model.
  const recordOutput: RecordOutputFn = deps.recordOutput ?? recordOutputImpl
  const spaceHealth: SpaceHealthFn = deps.spaceHealth ?? spaceHealthImpl
  const enabled = config.schedulerEnabled !== false

  let running = false
  let loop: Promise<void> | undefined
  // Early-wake sleep, as in the ingest pipeline: stop() resolves the pending
  // sleep so a drain never waits out a full poll interval.
  const wakers = new Set<() => void>()
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakers.delete(wake)
        resolve()
      }, ms)
      const wake = () => {
        clearTimeout(timer)
        resolve()
      }
      wakers.add(wake)
    })

  async function spaceInfo(spaceId: string): Promise<{ slug: string; language: 'en' | 'de' | 'simple' }> {
    const [space] = await db.select<{ slug: string; settings: Record<string, unknown> | string }>('wk_spaces', {
      id: `eq.${spaceId}`,
      limit: 1,
    })
    const settings = typeof space?.settings === 'string' ? JSON.parse(space.settings) : (space?.settings ?? {})
    const language = settings.language === 'de' || settings.language === 'simple' ? settings.language : 'en'
    return { slug: space?.slug ?? spaceId, language }
  }

  /**
   * Arm rows that have no computed window yet.
   *
   * Opportunistic before each claim, like the pipeline's requeueQuotaBlocked:
   * cheap, multi-instance safe (whichever poll gets there first wins, and both
   * compute the same instant). It arms WITHOUT firing — a schedule inserted by
   * a client that did not compute next_run_at itself starts at its next real
   * window, not immediately.
   */
  async function armUnscheduled(): Promise<void> {
    const rows = await db.select<ScheduleRow>('wk_schedules', {
      enabled: 'eq.true',
      next_run_at: 'is.null',
      limit: 20,
    })
    for (const row of rows) {
      try {
        const next = computeNextRun(row, new Date(now()))
        const patch = { next_run_at: next.toISOString() }
        await db.update('wk_schedules', { id: `eq.${row.id}` }, patch, { returning: false })
      } catch (error) {
        logger.error('cannot arm schedule', { schedule_id: row.id, kind: row.kind, error: String(error) })
      }
    }
  }

  /**
   * Take one due row and advance its window in the SAME transaction.
   *
   * This is the whole concurrency argument: the row lock is held only for the
   * pure arithmetic below (no LLM, no HTTP), a second instance's SKIP LOCKED
   * skips it meanwhile, and once the transaction commits the row is no longer
   * due — so a window yields exactly one run across the fleet. The job body
   * runs after the commit, deliberately outside the lock.
   */
  async function claimDue(): Promise<ClaimedSchedule | null> {
    return db.tx(async (tx) => {
      const { rows } = await tx.query<ScheduleRow>(
        `SELECT id, space_id, kind, at_time, weekday, timezone, enabled, last_run_at, next_run_at
           FROM wk_schedules
          WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now()
          ORDER BY next_run_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      )
      const row = rows[0]
      if (!row) return null
      let next: Date
      try {
        next = computeNextRun(row, new Date(now()))
      } catch (error) {
        // A row the server cannot interpret (a zone this ICU build dropped,
        // a hand-edited weekday) is parked a day ahead rather than disabled:
        // disabling would silently undo an operator's configuration, and
        // leaving next_run_at alone would log this line on every poll forever.
        logger.error('schedule has an uninterpretable window; parked for a day', {
          schedule_id: row.id,
          kind: row.kind,
          timezone: row.timezone,
          error: String(error),
        })
        await tx.query(`UPDATE wk_schedules SET next_run_at = now() + interval '1 day' WHERE id = $1`, [row.id])
        return null
      }
      await tx.query(`UPDATE wk_schedules SET last_run_at = now(), next_run_at = $2 WHERE id = $1`, [
        row.id,
        next.toISOString(),
      ])
      return { ...row, previous_run_at: row.last_run_at == null ? null : new Date(isoString(row.last_run_at)) }
    })
  }

  async function runBriefing(schedule: ClaimedSchedule): Promise<void> {
    const until = new Date(now())
    // First run has nothing to measure from, so the window is one period long —
    // a day for a daily schedule, a week for a weekly one. Guessing "since the
    // beginning of time" would make the first briefing a wall of history nobody
    // reads; guessing zero would make it empty.
    const period = schedule.weekday == null ? DAY_MS : 7 * DAY_MS
    const sinceIsReal = schedule.previous_run_at != null
    const since = schedule.previous_run_at ?? new Date(until.getTime() - period)
    const facts = await collectBriefingFacts(db, schedule.space_id, {
      since,
      until,
      timezone: schedule.timezone,
      sinceIsReal,
      gapTopicsEnabled: config.coverageGapTopicsEnabled === true,
    })
    const info = await spaceInfo(schedule.space_id)
    const markdown = renderBriefing(facts, info)
    const output = await recordOutput(db, schedule.space_id, {
      kind: 'briefing',
      title: `${info.language === 'de' ? 'Kurzbericht' : 'Briefing'} ${localDate(schedule.timezone, until)}`,
      markdown,
      // The pages that changed are the briefing's citations, so the Output
      // links into the wiki the same way an answer does.
      citations: facts.concepts,
    })
    logger.info('briefing written', {
      schedule_id: schedule.id,
      space_id: schedule.space_id,
      output_id: output.id,
      approved: facts.approved.count,
      pending: facts.pending.count,
      oldest_pending_days: facts.pending.oldest_days,
    })
  }

  async function runHealth(schedule: ClaimedSchedule): Promise<void> {
    const instant = new Date(now())
    // No window argument: the report describes "now" and spaceHealth's own
    // thirty-day default is the one a maintenance report wants. Passing the
    // briefing's window instead would make two documents about the same wiki
    // disagree about what "thin" means. The tier IS stated, although deep is
    // the default today: the persisted report is the full protocol by
    // contract, and an overridable default must not be able to narrow it.
    const health = await spaceHealth(
      db,
      schedule.space_id,
      { tier: 'deep' },
      {
        scaffoldingKinds: config.scaffoldingKinds,
        gapTopicsEnabled: config.coverageGapTopicsEnabled === true,
        sourceIndexDays: config.sourceIndexDays ?? DEFAULT_SOURCE_INDEX_DAYS,
      },
    )
    const info = await spaceInfo(schedule.space_id)
    const markdown = renderHealth(health, { timezone: schedule.timezone, instant, language: info.language })
    const counts = health.lint.counts
    const slug = info.slug
    // Output row and outbox event in ONE transaction, per the transactional
    // outbox contract src/webhooks.ts documents: the event exists iff the report
    // it announces committed, so no consumer can be told about a report that is
    // not there to read.
    const output = await db.tx(async (tx) => {
      const written = await recordOutput(tx, schedule.space_id, {
        kind: 'health',
        title: `${info.language === 'de' ? 'Prüfbericht' : 'Health'} ${localDate(schedule.timezone, instant)}`,
        markdown,
      })
      // The push seam. It carries the census and the queue, not the document:
      // a consumer that wants the prose reads the Output by id, and a webhook
      // payload that grew to hold a full report would be a payload nobody can
      // version. Registration lives in src/db/postgres.ts (WebhookEventType +
      // EVENT_TYPES) and src/webhooks.ts (the payload schema) — emitEvent
      // refuses an unregistered name at runtime on purpose.
      await tx.emitEvent(schedule.space_id, 'wikikit.health.reported', {
        space: slug,
        output_id: written.id,
        findings: { error: counts.error, warn: counts.warn, info: counts.info },
        pending_proposals: health.review_queue.pending,
        oldest_pending_days: health.review_queue.oldest_days,
      })
      return written
    })
    logger.info('health report written', {
      schedule_id: schedule.id,
      space_id: schedule.space_id,
      output_id: output.id,
      findings: health.lint.findings.length,
    })
  }

  async function runOnce(): Promise<boolean> {
    await armUnscheduled()
    const schedule = await claimDue()
    if (!schedule) return false
    try {
      if (schedule.kind === 'briefing') await runBriefing(schedule)
      else await runHealth(schedule)
    } catch (error) {
      // The window has already been advanced by the claim, so a failed job is
      // a missed report, not a retry storm. Logged as an error because a health
      // job that keeps failing is exactly the sort of thing the health job was
      // supposed to tell somebody about.
      logger.error('scheduled job failed', {
        schedule_id: schedule.id,
        kind: schedule.kind,
        space_id: schedule.space_id,
        error: String((error as Error).message || error),
      })
    }
    return true
  }

  return {
    start(): void {
      if (!enabled) {
        logger.info('scheduler disabled (WIKIKIT_SCHEDULER_ENABLED=false); schedules stay armed but nothing runs')
        return
      }
      if (running) return
      running = true
      loop = (async () => {
        while (running) {
          let processed = false
          try {
            processed = await runOnce()
          } catch (error) {
            logger.error('scheduler iteration failed', { error: String(error) })
          }
          // Drain a backlog of due rows back-to-back; only idle-sleep when
          // nothing was due.
          if (!processed && running) await sleep(pollMs)
        }
      })()
    },

    async stop(): Promise<void> {
      running = false
      for (const wake of [...wakers]) wake()
      wakers.clear()
      await loop
      loop = undefined
    },

    runOnce,
  }
}
