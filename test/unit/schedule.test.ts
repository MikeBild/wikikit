// The scheduler's due-time arithmetic — pure, so it is tested here across two
// IANA zones and both DST transitions without a database, a clock or a worker.
//
// WHY this file is mostly about one hour a year: the classic defect in every
// hand-rolled scheduler is that a wall-clock schedule stops being a wall-clock
// schedule on the day the zone shifts. Adding 24 hours to the last run drifts
// "every morning at seven" to six or eight; naively resolving the wall clock
// fires TWICE in the autumn fold (02:30 exists at two instants) and SKIPS the
// day in the spring gap (02:30 exists at none). A duplicate briefing is noise in
// the record forever, and a skipped one is a morning where nobody was told about
// the review queue. Neither is visible in production until it happens, once,
// months after the release.
//
// So the assertions are on the LOCAL wall clock as well as the instant: the
// promise "07:00 stays 07:00" is a statement about what the operator's clock
// reads, and asserting only UTC would let a broken hop pass whenever the offset
// happened to agree.
import { describe, expect, test } from 'bun:test'
import {
  computeNextRun,
  isTimeZone,
  parseDefaultBriefing,
  renderBriefing,
  zScheduleInput,
  zScheduleSet,
} from '../../src/schedule.ts'

/** The wall clock a zone shows at this instant — `YYYY-MM-DD, HH:MM`. */
function wallClock(timeZone: string, instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant)
}

/** `count` consecutive firings, each computed from the previous one — the way the worker does it. */
function walk(schedule: { at_time: string; weekday: number | null; timezone: string }, from: Date, count: number) {
  const runs: Date[] = []
  let cursor = from
  for (let index = 0; index < count; index++) {
    cursor = computeNextRun(schedule, cursor)
    runs.push(cursor)
  }
  return runs
}

const BERLIN_DAILY = { at_time: '07:00', weekday: null, timezone: 'Europe/Berlin' }
const AUCKLAND_DAILY = { at_time: '07:00', weekday: null, timezone: 'Pacific/Auckland' }

describe('computeNextRun — daily', () => {
  test('the next run is strictly after `from`, so a fired schedule never re-fires', () => {
    // The worker computes the next window from `now()` while holding the row,
    // which is the instant the current run is due. A boundary that returned the
    // same instant would leave the row due forever.
    const due = new Date('2026-07-15T05:00:00Z') // 07:00 Berlin, CEST
    expect(computeNextRun(BERLIN_DAILY, due).toISOString()).toBe('2026-07-16T05:00:00.000Z')
  })

  test('the same wall clock is a different instant in a different zone', () => {
    const from = new Date('2026-07-15T00:00:00Z')
    expect(computeNextRun(BERLIN_DAILY, from).toISOString()).toBe('2026-07-15T05:00:00.000Z')
    expect(computeNextRun(AUCKLAND_DAILY, from).toISOString()).toBe('2026-07-15T19:00:00.000Z')
  })

  test('winter and summer differ in UTC and agree on the operator’s clock', () => {
    const summer = computeNextRun(BERLIN_DAILY, new Date('2026-07-15T10:00:00Z'))
    const winter = computeNextRun(BERLIN_DAILY, new Date('2026-01-10T10:00:00Z'))
    expect(summer.toISOString()).toBe('2026-07-16T05:00:00.000Z') // CEST, UTC+2
    expect(winter.toISOString()).toBe('2026-01-11T06:00:00.000Z') // CET, UTC+1
    expect(wallClock('Europe/Berlin', summer).endsWith('07:00')).toBe(true)
    expect(wallClock('Europe/Berlin', winter).endsWith('07:00')).toBe(true)
  })
})

describe('computeNextRun — across a DST transition', () => {
  test('Europe/Berlin spring forward: one 23-hour hop, no day skipped', () => {
    // 2026-03-29 is the day the zone loses an hour. A fixed 24-hour step would
    // move the briefing to 08:00 for the rest of the year.
    const runs = walk(BERLIN_DAILY, new Date('2026-03-27T06:00:00Z'), 4)
    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-03-28T06:00:00.000Z',
      '2026-03-29T05:00:00.000Z', // 23 hours later
      '2026-03-30T05:00:00.000Z',
      '2026-03-31T05:00:00.000Z',
    ])
    expect(runs.map((run) => wallClock('Europe/Berlin', run))).toEqual([
      '2026-03-28, 07:00',
      '2026-03-29, 07:00',
      '2026-03-30, 07:00',
      '2026-03-31, 07:00',
    ])
  })

  test('Europe/Berlin autumn fall back: one 25-hour hop, no day fired twice', () => {
    const runs = walk(BERLIN_DAILY, new Date('2026-10-23T05:00:00Z'), 4)
    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-10-24T05:00:00.000Z',
      '2026-10-25T06:00:00.000Z', // 25 hours later
      '2026-10-26T06:00:00.000Z',
      '2026-10-27T06:00:00.000Z',
    ])
    // The dates are consecutive and every one shows 07:00: neither a repeat nor
    // a gap, which are the two ways this goes wrong.
    expect(new Set(runs.map((run) => wallClock('Europe/Berlin', run).slice(0, 10))).size).toBe(4)
    expect(runs.every((run) => wallClock('Europe/Berlin', run).endsWith('07:00'))).toBe(true)
  })

  test('Pacific/Auckland — a southern-hemisphere zone shifts the other way round', () => {
    // Deliberately a second zone whose transitions fall in April and September,
    // so a table hard-wired to European dates cannot pass this file.
    const runs = walk(AUCKLAND_DAILY, new Date('2026-04-03T18:00:00Z'), 3)
    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-04-04T19:00:00.000Z', // 25 hours: NZDT → NZST overnight
      '2026-04-05T19:00:00.000Z',
      '2026-04-06T19:00:00.000Z',
    ])
    expect(runs.every((run) => wallClock('Pacific/Auckland', run).endsWith('07:00'))).toBe(true)
  })

  test('the FOLD (02:30 happens twice) fires ONCE, on the earlier instant', () => {
    // 02:30 on 2026-10-25 is a valid Berlin wall clock at 00:30Z (CEST) and
    // again at 01:30Z (CET). The earlier one wins, and — the assertion that
    // matters — the run computed FROM it is the next day, not the second pass
    // of the same hour. Firing twice would file two briefings for one morning.
    const first = computeNextRun(
      { at_time: '02:30', weekday: null, timezone: 'Europe/Berlin' },
      new Date('2026-10-24T02:00:00Z'),
    )
    expect(first.toISOString()).toBe('2026-10-25T00:30:00.000Z')
    const second = computeNextRun({ at_time: '02:30', weekday: null, timezone: 'Europe/Berlin' }, first)
    expect(second.toISOString()).toBe('2026-10-26T01:30:00.000Z')
    expect(wallClock('Europe/Berlin', second)).toBe('2026-10-26, 02:30')
  })

  test('the GAP (02:30 never happens) fires LATE that day rather than not at all', () => {
    // On 2026-03-29 Berlin jumps 02:00 → 03:00, so 02:30 exists at no instant.
    // Skipping is the tempting implementation and the wrong one: a daily report
    // that silently misses a day is a day nobody was told anything.
    const runs = walk(
      { at_time: '02:30', weekday: null, timezone: 'Europe/Berlin' },
      new Date('2026-03-28T02:00:00Z'),
      2,
    )
    expect(wallClock('Europe/Berlin', runs[0]!)).toBe('2026-03-29, 03:30')
    expect(wallClock('Europe/Berlin', runs[1]!)).toBe('2026-03-30, 02:30') // back to normal at once
  })

  test('the gap behaves the same way in the other hemisphere', () => {
    const runs = walk(
      { at_time: '02:30', weekday: null, timezone: 'Pacific/Auckland' },
      new Date('2026-09-26T13:00:00Z'),
      2,
    )
    expect(wallClock('Pacific/Auckland', runs[0]!)).toBe('2026-09-27, 03:30')
    expect(wallClock('Pacific/Auckland', runs[1]!)).toBe('2026-09-28, 02:30')
  })
})

describe('computeNextRun — weekly', () => {
  const MONDAY_NY = { at_time: '09:00', weekday: 1, timezone: 'America/New_York' }

  test('lands on the requested weekday, in that zone, week after week', () => {
    const runs = walk(MONDAY_NY, new Date('2026-03-02T14:00:00Z'), 3)
    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-03-09T13:00:00.000Z', // 8 March is the US spring-forward
      '2026-03-16T13:00:00.000Z',
      '2026-03-23T13:00:00.000Z',
    ])
    // 0 = Sunday, matching Postgres extract(dow) — a weekly schedule that drifts
    // by a day is a report that arrives on the wrong morning.
    expect(runs.every((run) => wallClock('America/New_York', run).endsWith('09:00'))).toBe(true)
    expect(runs.map((run) => new Date(run).getUTCDay())).toEqual([1, 1, 1])
  })

  test('today-but-already-past waits a full week; today-but-still-ahead runs today', () => {
    expect(computeNextRun(MONDAY_NY, new Date('2026-03-09T14:00:00Z')).toISOString()).toBe('2026-03-16T13:00:00.000Z')
    expect(computeNextRun(MONDAY_NY, new Date('2026-03-09T12:00:00Z')).toISOString()).toBe('2026-03-09T13:00:00.000Z')
  })

  test('a weekday outside 0..6 throws instead of spinning the claim loop', () => {
    // Unreachable past the CHECK and the zod schema — but a row that got there
    // by hand must fail loudly, not make the worker walk forever.
    expect(() => computeNextRun({ at_time: '07:00', weekday: 9, timezone: 'UTC' }, new Date())).toThrow(
      /no due time within 9 days/,
    )
  })

  test('Postgres’ HH:MM:SS is accepted as readily as the wire’s HH:MM', () => {
    // The row comes back as `07:00:00` and the wire speaks `07:00`; both reach
    // this function, so both have to mean the same window.
    expect(
      computeNextRun({ ...BERLIN_DAILY, at_time: '07:00:00' }, new Date('2026-07-15T10:00:00Z')).toISOString(),
    ).toBe(computeNextRun(BERLIN_DAILY, new Date('2026-07-15T10:00:00Z')).toISOString())
  })
})

describe('the schedule input contract', () => {
  test('the timezone is checked against the runtime’s zone database, not a regex', () => {
    // "Europe/Berlin" and "Europe/Berlyn" are indistinguishable to any pattern,
    // and the second would only fail later, inside a tick, on a row nobody is
    // looking at.
    expect(isTimeZone('Europe/Berlin')).toBe(true)
    expect(isTimeZone('Europe/Berlyn')).toBe(false)
    expect(zScheduleInput.safeParse({ kind: 'briefing', at_time: '07:00', timezone: 'Europe/Berlyn' }).success).toBe(
      false,
    )
  })

  test('at_time is HH:MM in 24 hours — no seconds, no 24:00', () => {
    const base = { kind: 'briefing' as const, timezone: 'UTC' }
    expect(zScheduleInput.safeParse({ ...base, at_time: '07:00' }).success).toBe(true)
    expect(zScheduleInput.safeParse({ ...base, at_time: '23:59' }).success).toBe(true)
    expect(zScheduleInput.safeParse({ ...base, at_time: '07:00:30' }).success).toBe(false)
    expect(zScheduleInput.safeParse({ ...base, at_time: '24:00' }).success).toBe(false)
    expect(zScheduleInput.safeParse({ ...base, at_time: '7:00' }).success).toBe(false)
  })

  test('one schedule per kind — the PUT is a replace, not a pile', () => {
    const row = { kind: 'briefing', at_time: '07:00', timezone: 'UTC' }
    expect(zScheduleSet.safeParse({ schedules: [row, { ...row, kind: 'health' }] }).success).toBe(true)
    expect(zScheduleSet.safeParse({ schedules: [row, { ...row, at_time: '08:00' }] }).success).toBe(false)
    // An empty set is how an operator switches the whole thing off, so it has
    // to be legal.
    expect(zScheduleSet.safeParse({ schedules: [] }).success).toBe(true)
  })
})

describe('renderBriefing', () => {
  const facts = {
    since: '2026-07-14T05:00:00.000Z',
    until: '2026-07-15T05:00:00.000Z',
    timezone: 'Europe/Berlin',
    approved: { count: 2, titles: ['Ingest: OKF announcement', 'Update wikikit'] },
    concepts: [{ slug: 'wikikit', title: 'WikiKit' }],
    pending: {
      count: 436,
      oldest_days: 21,
      oldest_since: '2026-06-24T09:00:00.000Z',
      oldest_title: 'Ingest: quarterly report',
    },
    thin: { enabled: true, items: [{ lexeme: 'sofa', count: 2 }] },
    inbox: { queued: 3, failed_since: 1 },
  }

  test('states the AGE of the oldest waiting change, not only the count', () => {
    // The whole reason this document exists: a production wiki sat on 436
    // proposals whose oldest had not been touched in three weeks, and every
    // surface reported the installation as healthy. "436 waiting" reads the same
    // on the day it appears as it does a month later; "21 days old" does not.
    const text = renderBriefing(facts)
    expect(text).toContain('436 change(s) pending review.')
    expect(text).toContain('21 day(s) old')
    expect(text).toContain('Ingest: quarterly report')
  })

  test('is deterministic for one window and differs between two', () => {
    // Deliberately the OPPOSITE requirement to renderOutputSource: a briefing is
    // about a window, and two windows are two documents — so it carries its
    // window in the text and is not content-hash stable across runs.
    expect(renderBriefing(facts)).toBe(renderBriefing(facts))
    expect(renderBriefing({ ...facts, until: '2026-07-16T05:00:00.000Z' })).not.toBe(renderBriefing(facts))
  })

  test('an empty queue says so, and never "0 days old"', () => {
    const quiet = renderBriefing({
      ...facts,
      pending: { count: 0, oldest_days: null, oldest_since: null, oldest_title: null },
    })
    expect(quiet).toContain('The review queue is empty.')
    expect(quiet).not.toContain('day(s) old')
  })

  test('"not measured" and "nothing found" are different sentences', () => {
    // An empty gap list means two different things — no unanswered question was
    // recorded, or the installation never records them — and a report that
    // printed "no gaps" for the second would be telling the operator their wiki
    // is complete.
    const off = renderBriefing({ ...facts, thin: { enabled: false, items: [] } })
    const onButEmpty = renderBriefing({ ...facts, thin: { enabled: true, items: [] } })
    expect(off).toContain('Not measured')
    expect(onButEmpty).toContain('No unanswered question was recorded.')
    expect(off).not.toBe(onButEmpty)
  })

  test('a first run says it has no earlier briefing to measure from', () => {
    expect(renderBriefing({ ...facts, since: null })).toContain('first run')
  })

  test('long lists are capped with an honest tail rather than truncated silently', () => {
    const many = renderBriefing({
      ...facts,
      approved: { count: 30, titles: Array.from({ length: 30 }, (_, index) => `Change ${index + 1}`) },
    })
    expect(many).toContain('- Change 20')
    expect(many).not.toContain('- Change 21\n')
    expect(many).toContain('…and 10 more')
  })
})

// ---------------------------------------------------------------------------
// WIKIKIT_DEFAULT_BRIEFING
//
// One variable carries a time, an optional zone and the off switch, so the
// parser is the only thing standing between a typo in an env file and a wiki
// whose report fires at an hour nobody chose. It therefore REFUSES rather than
// falling back: a silent default here would be a schedule the operator did not
// write, discovered weeks later.
describe('parseDefaultBriefing', () => {
  test('a bare time means that time in UTC — the only zone a server never guesses', () => {
    expect(parseDefaultBriefing('07:00')).toEqual({ at_time: '07:00', timezone: 'UTC' })
  })

  test('a zone after the time is honoured, and surrounding whitespace is not content', () => {
    expect(parseDefaultBriefing('  06:30   Europe/Berlin  ')).toEqual({
      at_time: '06:30',
      timezone: 'Europe/Berlin',
    })
  })

  test('off and empty both mean seed nothing, and are not confused with a valid time', () => {
    expect(parseDefaultBriefing('off')).toBeNull()
    expect(parseDefaultBriefing('OFF')).toBeNull()
    expect(parseDefaultBriefing('')).toBeNull()
    expect(parseDefaultBriefing('   ')).toBeNull()
  })

  test('midnight and the last minute of the day are valid, 24:00 is not', () => {
    expect(parseDefaultBriefing('00:00')?.at_time).toBe('00:00')
    expect(parseDefaultBriefing('23:59')?.at_time).toBe('23:59')
    expect(() => parseDefaultBriefing('24:00')).toThrow(/HH:MM/)
  })

  test('a malformed time refuses instead of defaulting', () => {
    for (const bad of ['7:00', '0700', '07:60', 'morning', '07:00:00']) {
      expect(() => parseDefaultBriefing(bad)).toThrow()
    }
  })

  test('an unknown zone refuses — the name is asked of the zone database, not a regex', () => {
    expect(() => parseDefaultBriefing('07:00 Europe/Berlyn')).toThrow(/unknown IANA time zone/)
  })

  test('a third word is a mistake, not extra information', () => {
    expect(() => parseDefaultBriefing('07:00 Europe/Berlin daily')).toThrow(/"HH:MM"/)
  })

  test('what it returns is exactly what the schedule contract accepts', () => {
    const spec = parseDefaultBriefing('07:00')!
    expect(() =>
      zScheduleInput.parse({ kind: 'briefing', at_time: spec.at_time, weekday: null, timezone: spec.timezone }),
    ).not.toThrow()
  })
})
