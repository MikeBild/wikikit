// The Care page's rules — the page that exists because of a measured failure
// rather than a feature request.
//
// A production wiki was sitting on hundreds of change proposals whose oldest had
// not been touched in three weeks, and every surface in the product reported the
// installation as healthy the whole time. A count alone would not have helped
// either: "436 waiting" looks the same on the day it appears as it does a month
// later, and it is the AGE that turns a queue into a backlog.
//
// So these rules are mostly about not lying with a number, and about making sure
// every line of the report leads somewhere a person can act.
import { describe, expect, test } from 'bun:test'
import {
  backlogStanding,
  displayFindings,
  draftsFrom,
  findingTarget,
  isTimeZoneName,
  lintMessage,
  ruleWhy,
  scheduleBody,
  scheduleProblem,
  SCHEDULE_KINDS,
  waitedDays,
  waitedHours,
  WEEKDAYS,
  type ScheduleDraft,
} from '../../../apps/cockpit/src/pages/care.logic.ts'
import { LINT_SEVERITY } from '../../../src/domain/lint.ts'

describe('the review queue: two states, not a scale', () => {
  test('an empty queue is GOOD NEWS and reads as such', () => {
    expect(backlogStanding(0)).toEqual({ label: 'Nothing is waiting', tone: 'success' })
  })

  test('anything waiting is BLOCKED — stopped until a human acts', () => {
    // Which is exactly what a pending change is, whether there is one of them or
    // four hundred. How bad four hundred is remains the reader's judgement: the
    // console draws no threshold, because the server refuses to and the policy
    // belongs to whoever owns the wiki.
    expect(backlogStanding(1)).toEqual({ label: 'Waiting for a decision', tone: 'warning' })
    expect(backlogStanding(436)).toEqual(backlogStanding(1))
  })
})

describe('a wait, in the words a person would use', () => {
  test('null is an em dash’s worth of nothing, never "0 days"', () => {
    // oldest_days is null exactly when nothing is waiting, and "the oldest
    // change has waited zero days" is a sentence about nothing (CUI-SEV-2).
    expect(waitedDays(null).phrase).toBeNull()
    expect(waitedDays(undefined).phrase).toBeNull()
    expect(waitedDays(Number.NaN).phrase).toBeNull()
    expect(waitedDays(-1).phrase).toBeNull()
  })

  test('a measured zero is TODAY, which is a fact and not an absence', () => {
    expect(waitedDays(0)).toEqual({ phrase: 'today' })
    expect(waitedDays(0).phrase).not.toBe(waitedDays(null).phrase)
  })

  test('one day is singular; more is interpolated by the translator', () => {
    // The phrases go out as SOURCE strings with the count as a value, so the
    // number never has to survive a round trip through a lookup table.
    expect(waitedDays(1)).toEqual({ phrase: '1 day' })
    expect(waitedDays(21)).toEqual({ phrase: '{count} days', values: { count: 21 } })
    expect(waitedDays(21.8)).toEqual({ phrase: '{count} days', values: { count: 21 } })
  })

  test('the ingest queue is measured in HOURS, and that is why it is a second function', () => {
    // A healthy ingest queue drains in minutes, so "0 days" would read like
    // reassurance about a queue that has been stuck since lunchtime.
    expect(waitedHours(null).phrase).toBeNull()
    expect(waitedHours(0.4)).toEqual({ phrase: 'under an hour' })
    expect(waitedHours(4.5)).toEqual({ phrase: '{count} h', values: { count: 5 } })
  })
})

describe('every finding has to lead somewhere', () => {
  test('the PAGE wins wherever a finding names one, because that is where the fix happens', () => {
    // A tombstoned source names both the source and the page whose claims quote
    // it, and the reader's decision — deprecate the claim or not — is made on
    // the page.
    expect(
      findingTarget({ rule: 'tombstoned-sources', concept_slug: 'wikikit', details: { source_id: 'src-1' } }),
    ).toEqual({ kind: 'page', slug: 'wikikit' })
    expect(findingTarget({ rule: 'self-derived-only', concept_slug: 'wikikit' })).toEqual({
      kind: 'page',
      slug: 'wikikit',
    })
  })

  test('the two findings that are about a QUEUE go to the queue’s row', () => {
    expect(findingTarget({ rule: 'unreviewed-proposals', details: { proposal_id: 'prop-1' } })).toEqual({
      kind: 'change',
      id: 'prop-1',
    })
    expect(findingTarget({ rule: 'dangling-sources', details: { source_id: 'src-1' } })).toEqual({
      kind: 'source',
      id: 'src-1',
    })
  })

  test('a finding this console cannot route plainly does not move', () => {
    // null is a real answer and not a fallback to somewhere plausible: sending
    // the reader to a list and letting them hunt is worse than a row that does
    // nothing.
    expect(findingTarget({ rule: 'broken-cross-space-links' })).toBeNull()
    expect(findingTarget({ rule: 'unreviewed-proposals', details: { proposal_id: '  ' } })).toBeNull()
    expect(findingTarget({ rule: 'dangling-sources', details: { source_id: 42 } })).toBeNull()
    expect(findingTarget({ rule: 'orphan-concepts', concept_slug: '' })).toBeNull()
  })

  test('the two findings whose fix happens on a PAGE of this console go to that page', () => {
    // A parked thought is processed or discarded in the Inbox; the missing
    // guidelines are written under Guidelines. Neither carries an id any detail
    // route could resolve, so the rule decides before the field probes run.
    expect(findingTarget({ rule: 'stale-captures', details: { ingest_id: 'job-1', days_parked: 45 } })).toEqual({
      kind: 'inbox',
    })
    expect(findingTarget({ rule: 'missing-charter' })).toEqual({ kind: 'charter' })
    // The stale change goes to THE change, like its census sibling.
    expect(
      findingTarget({ rule: 'stale-proposals', details: { proposal_id: 'prop-2', title: 'Old', days_open: 21 } }),
    ).toEqual({ kind: 'change', id: 'prop-2' })
  })

  test('every rule the server ships carries a "why it counts" sentence', () => {
    // The three-part finding: what the linter said, why it matters, where the
    // fix happens. The map is keyed by the server's own rule union, so a rule
    // added there without a rationale here is a failing test, not a silent
    // help icon that never appears.
    for (const rule of Object.keys(LINT_SEVERITY)) {
      expect(ruleWhy(rule), `${rule} has no why-it-counts text`).toBeTruthy()
    }
    expect(ruleWhy('some-future-rule')).toBeNull()
  })
})

describe('lint messages use the Cockpit language', () => {
  test('uses the structured rule and arguments for German instead of translating wiki content', () => {
    const finding = {
      rule: 'stale-proposals',
      message: {
        key: 'stale-proposals',
        args: { days_open: 21, title: 'Auth rollout' },
        default_text: 'proposal "Auth rollout" has waited 21 days for a review',
      },
    }
    expect(lintMessage('de', finding)).toBe('Ein Vorschlag wartet seit 21 Tagen auf eine menschliche Prüfung.')
    expect(lintMessage('en', finding)).toBe(finding.message.default_text)
  })

  test('has a German sentence for every lint rule and keeps unknown server rules readable', () => {
    for (const rule of Object.keys(LINT_SEVERITY)) {
      const rendered = lintMessage('de', {
        rule,
        concept_slug: 'beispiel',
        message: { key: rule, args: {}, default_text: `english ${rule}` },
      })
      expect(rendered, `${rule} has no German lint message`).not.toBe(`english ${rule}`)
    }
    expect(
      lintMessage('de', {
        rule: 'future',
        message: { key: 'future', args: {}, default_text: 'future server message' },
      }),
    ).toBe('future server message')
  })
})

describe('one queue, one row: stale vs. census proposal findings', () => {
  const census = (id: string) => ({ rule: 'unreviewed-proposals', details: { proposal_id: id } })
  const stale = (id: string) => ({ rule: 'stale-proposals', details: { proposal_id: id, days_open: 21 } })

  test('the census note of a change that also has a stale warning is folded into it', () => {
    const { shown, folded } = displayFindings([stale('a'), census('a'), census('b')])
    expect(shown.map((finding) => finding.rule)).toEqual(['stale-proposals', 'unreviewed-proposals'])
    expect(shown.at(-1)!.details!.proposal_id).toBe('b')
    expect(folded).toBe(1)
  })

  test('without a stale warning nothing is folded and nothing is copied', () => {
    const findings = [census('a'), census('b')]
    expect(displayFindings(findings)).toEqual({ shown: findings, folded: 0 })
  })

  test('every other rule passes through untouched', () => {
    const other = { rule: 'missing-citations', concept_slug: 'wikikit' }
    const { shown, folded } = displayFindings([stale('a'), other])
    expect(shown).toEqual([stale('a'), other])
    expect(folded).toBe(0)
  })
})

describe('the schedule form', () => {
  test('the kinds and the weekday numbering are the server’s', () => {
    expect([...SCHEDULE_KINDS]).toEqual(['briefing', 'health'])
    // 0 = Sunday … 6 = Saturday, matching Postgres extract(dow) and the wire —
    // the list is merely rotated so a working week starts on Monday.
    expect(WEEKDAYS.map((day) => day.value).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(WEEKDAYS[0]).toEqual({ value: 1, label: 'Monday' })
    expect(WEEKDAYS.at(-1)).toEqual({ value: 0, label: 'Sunday' })
  })

  test('a kind the server has no row for is a schedule that is OFF, not one that is missing', () => {
    // A form that only shows what exists gives an operator no way to switch one
    // on. The defaults are deliberately dull, because a suggested time somebody
    // has to think about is a form they close.
    const drafts = draftsFrom([], 'Europe/Berlin')
    expect(drafts.map((draft) => draft.kind)).toEqual(['briefing', 'health'])
    expect(drafts.every((draft) => draft.enabled === false)).toBe(true)
    expect(drafts.every((draft) => draft.atTime === '07:00' && draft.timezone === 'Europe/Berlin')).toBe(true)
  })

  test('a null weekday on the wire IS daily, and the form remembers a weekday anyway', () => {
    // frequency is a separate field rather than "weekday === null means daily",
    // because the form has to hold the weekday somebody picked while they look
    // at what daily would mean.
    const [briefing, health] = draftsFrom(
      [
        { kind: 'briefing', at_time: '06:30:00', weekday: null, timezone: 'UTC', enabled: true },
        { kind: 'health', at_time: '08:30:00', weekday: 3, timezone: 'Pacific/Auckland', enabled: true },
      ],
      'Europe/Berlin',
    )
    expect(briefing).toEqual({
      kind: 'briefing',
      enabled: true,
      frequency: 'daily',
      atTime: '06:30', // Postgres hands back HH:MM:SS; the form speaks HH:MM
      weekday: 1,
      timezone: 'UTC',
    })
    expect(health!.frequency).toBe('weekly')
    expect(health!.weekday).toBe(3)
  })

  test('the PUT body carries the switched-off kinds, because leaving one out DELETES it', () => {
    // Both switch the kind off — the route is a replace — but omitting it drops
    // the row and with it last_run_at, the only record that the schedule ever
    // ran.
    const drafts: ScheduleDraft[] = [
      { kind: 'briefing', enabled: true, frequency: 'daily', atTime: '07:00', weekday: 4, timezone: 'UTC' },
      { kind: 'health', enabled: false, frequency: 'weekly', atTime: '08:30', weekday: 1, timezone: 'UTC' },
    ]
    expect(scheduleBody(drafts)).toEqual({
      schedules: [
        // daily → the weekday the form is holding does NOT travel
        { kind: 'briefing', at_time: '07:00', weekday: null, timezone: 'UTC', enabled: true },
        { kind: 'health', at_time: '08:30', weekday: 1, timezone: 'UTC', enabled: false },
      ],
    })
  })

  test('a zone is checked against the browser’s zone database, not a pattern', () => {
    // Europe/Berlin and Europe/Berlyn are indistinguishable to any regex, and
    // the second would only fail later, inside a tick, on a row nobody is
    // looking at.
    expect(isTimeZoneName('Europe/Berlin')).toBe(true)
    expect(isTimeZoneName('Pacific/Auckland')).toBe(true)
    expect(isTimeZoneName('Europe/Berlyn')).toBe(false)
    expect(isTimeZoneName('')).toBe(false)
  })

  test('the form refuses a broken enabled row before the round trip', () => {
    const good: ScheduleDraft = {
      kind: 'briefing',
      enabled: true,
      frequency: 'daily',
      atTime: '07:00',
      weekday: 1,
      timezone: 'Europe/Berlin',
    }
    expect(scheduleProblem([good])).toBeNull()
    expect(scheduleProblem([{ ...good, atTime: '7:00' }])).toContain('HH:MM')
    expect(scheduleProblem([{ ...good, timezone: 'Europe/Berlyn' }])).toContain('time zone')
  })

  test('a switched-off row is not checked at all', () => {
    // Refusing to save a working briefing because the care report somebody
    // disabled last month has an empty zone would be the form blocking on a
    // field that does nothing.
    const off: ScheduleDraft = {
      kind: 'health',
      enabled: false,
      frequency: 'weekly',
      atTime: '',
      weekday: 1,
      timezone: '',
    }
    expect(scheduleProblem([off])).toBeNull()
  })
})
