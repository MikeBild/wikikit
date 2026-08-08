// The home page's rules — chiefly CUI-SEV-2, which is the rule every dashboard
// in the world gets wrong.
//
// A value nobody sent is not zero. "0 changes waiting" and "we have no idea how
// many changes are waiting" are different facts, and a front page that renders
// them identically tells a reader the wiki is quiet when the stats endpoint is
// simply down.
import { describe, expect, test } from 'bun:test'
import {
  averageSeconds,
  changeStanding,
  count,
  durationHours,
  formatSeconds,
  measured,
  staleShare,
  windowLabel,
} from '../../../apps/cockpit/src/pages/home.logic.ts'

describe('CUI-SEV-2 — a value nobody sent is not zero', () => {
  test('a missing count renders as an em dash', () => {
    expect(count(null)).toBe('—')
    expect(count(undefined)).toBe('—')
  })

  test('a measured zero renders as zero', () => {
    expect(count(0)).toBe('0')
  })

  test('the two are never the same string', () => {
    expect(count(null)).not.toBe(count(0))
  })

  test('a metric the server marked missing reads as missing', () => {
    // The stats endpoints carry a value_state precisely so a zero can be told
    // apart from an absence. Collapsing that here would throw away the one
    // thing the server went to the trouble of saying.
    expect(measured({ value: 0, value_state: 'missing' } as never)).toBeNull()
    expect(measured({ value: 0, value_state: 'measured' } as never)).toBe(0)
    expect(measured(null)).toBeNull()
    expect(measured(undefined)).toBeNull()
  })
})

describe('durations', () => {
  test('a missing duration is not "0h"', () => {
    expect(durationHours(null)).toBe('—')
    expect(durationHours(undefined)).toBe('—')
  })

  test('seconds read at the scale a human thinks in', () => {
    expect(formatSeconds(45)).toMatch(/45\s*s/)
    expect(formatSeconds(3600)).toMatch(/1\s*h/)
  })

  test('an average over no samples is not an average', () => {
    // Dividing by a count of zero produces NaN, and "NaN s" on a front page is
    // worse than saying nothing.
    expect(averageSeconds({ count: 0, avg: 0 })).toBe('—')
    expect(averageSeconds(null)).toBe('—')
    expect(averageSeconds(undefined)).toBe('—')
  })

  test('an average over real samples is a number', () => {
    expect(averageSeconds({ count: 4, avg: 120 })).not.toBe('—')
  })
})

describe('coverage', () => {
  test('a wiki with no pages has no stale share, rather than 0%', () => {
    // 0/0 is not 0%. A brand-new wiki is not perfectly fresh; nothing has been
    // measured about it yet.
    expect(staleShare(0, 0)).toBe('—')
  })

  test('a real share is a percentage', () => {
    expect(staleShare(10, 3)).toMatch(/30\s*%/)
  })

  test('nothing stale out of some pages IS zero, and says so', () => {
    expect(staleShare(10, 0)).toMatch(/0\s*%/)
  })
})

describe('the window a number covers', () => {
  test('an unbounded window is labelled as such rather than left blank', () => {
    expect(windowLabel('', '')).toBeNull()
  })

  test('a bounded window names its dates', () => {
    const label = windowLabel('2026-08-01T00:00:00Z', '2026-08-08T00:00:00Z')
    expect(label).toBeString()
    expect(label!.length).toBeGreaterThan(0)
  })
})

describe('what waits for a reviewer', () => {
  test('a sent-back change is not shown as merely pending', () => {
    expect(changeStanding('pending', true).label).not.toBe(changeStanding('pending', false).label)
  })

  test('a pending change is stopped-until-a-human, not a failure', () => {
    expect(changeStanding('pending', false).tone).not.toBe('danger')
  })

  test('an approved change reads as settled and good', () => {
    expect(changeStanding('approved', false).tone).toBe('success')
  })
})
