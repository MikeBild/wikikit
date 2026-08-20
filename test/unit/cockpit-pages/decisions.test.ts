// The one number of open decisions, and the banner sentence built from it.
//
// This file exists because the console shows that number in four places — the
// sidebar badge, the Zone-A card, the incident banner and the queue itself —
// and four call sites are four chances to count something slightly different.
// An operator who reads "1" beside the navigation entry and "3" on the front
// page does not conclude that one of them is wrong; they conclude that neither
// can be trusted. Nothing is broken in that failure, which is what makes it
// expensive.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGING_DAYS,
  ageInDays,
  GLOBAL_ATTENTION_QUERY,
  bannerSubset,
  bySpace,
  countOpenDecisions,
  decisionId,
  dedupe,
  parseSynthesisSummary,
  summaryLine,
  type OpenDecisionItem,
} from '../../../apps/cockpit/src/pages/decisions.logic.ts'

const NOW = Date.parse('2026-08-19T12:00:00.000Z')
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString()

function item(overrides: Partial<OpenDecisionItem> & { key: string }): OpenDecisionItem {
  return {
    space: 'handbuch',
    kind: 'proposal',
    created_at: daysAgo(0),
    ...overrides,
  }
}

describe('identity across wikis', () => {
  test('a position is identified by wiki AND key, because keys are per-wiki', () => {
    // Two wikis with a proposal each are two decisions. Counting by key alone
    // would silently merge them and report one.
    expect(decisionId({ space: 'handbuch', key: 'proposal:a' })).toBe('handbuch:proposal:a')
    expect(decisionId({ space: 'onboarding', key: 'proposal:a' })).not.toBe(
      decisionId({ space: 'handbuch', key: 'proposal:a' }),
    )
  })

  test('the same position echoed twice is one position, first occurrence kept', () => {
    const unique = dedupe([
      item({ key: 'proposal:a', created_at: daysAgo(9) }),
      item({ key: 'proposal:b' }),
      item({ key: 'proposal:a', created_at: daysAgo(1) }),
    ])
    expect(unique.map((entry) => entry.key)).toEqual(['proposal:a', 'proposal:b'])
    expect(unique[0]!.created_at).toBe(daysAgo(9))
  })

  test('the same key in two wikis survives deduplication', () => {
    const unique = dedupe([item({ key: 'proposal:a' }), item({ key: 'proposal:a', space: 'onboarding' })])
    expect(unique).toHaveLength(2)
  })
})

describe('an age in whole days, or nothing', () => {
  test('counts whole elapsed days and never goes negative', () => {
    expect(ageInDays(daysAgo(3), NOW)).toBe(3)
    expect(ageInDays(daysAgo(0), NOW)).toBe(0)
    // A row stamped in the future is a clock disagreement, not a negative age.
    expect(ageInDays(new Date(NOW + 86_400_000).toISOString(), NOW)).toBe(0)
  })

  test('an unparseable timestamp is null rather than a number nobody measured', () => {
    expect(ageInDays('not a date', NOW)).toBeNull()
  })
})

describe('the count is the SERVER’s count, never the length of a page of rows', () => {
  test('total follows counts.open even when the list is shorter', () => {
    // The list is paginated; the count is not. A number derived from rows says
    // "3 waiting" on a queue of four hundred and stops somebody from looking.
    const open = countOpenDecisions({
      items: [item({ key: 'proposal:a' }), item({ key: 'proposal:b' })],
      counts: { open: 400, oldest_days: 21, by_kind: { proposal: 398, triage: 2 } },
      nowMs: NOW,
    })
    expect(open.total).toBe(400)
    expect(open.capped).toBe(true)
  })

  test('a duplicate in the list does not make a complete list look capped', () => {
    // Six rows, five positions, five open. Deduplicating BEFORE the comparison
    // is what keeps the banner from hedging with "mindestens" for no reason.
    const open = countOpenDecisions({
      items: [
        item({ key: 'proposal:a', created_at: daysAgo(9) }),
        item({ key: 'proposal:b', created_at: daysAgo(5) }),
        item({ key: 'proposal:a', created_at: daysAgo(9) }),
        item({ key: 'proposal:c' }),
        item({ key: 'triage:d', kind: 'triage' }),
        item({ key: 'proposal:e', space: 'onboarding' }),
      ],
      counts: { open: 5, oldest_days: 9, by_kind: { proposal: 4, triage: 1 } },
      nowMs: NOW,
    })
    expect(open.capped).toBe(false)
    expect(open.total).toBe(5)
    expect(open.subsets.aging).toBe(2)
  })

  test('byKind always carries both kinds, because a missing key and a zero are different sentences', () => {
    const open = countOpenDecisions({
      items: [],
      counts: { open: 0, oldest_days: null, by_kind: { proposal: 0, triage: 0 } },
      nowMs: NOW,
    })
    expect(open.byKind).toEqual({ proposal: 0, triage: 0 })
    expect(open.subsets).toEqual({ blocking: 0, overdue: 0, aging: 0 })
    expect(open.oldestAgeDays).toBeNull()
  })

  test('the aging rubric starts at three whole days, not at "roughly three"', () => {
    const open = countOpenDecisions({
      items: [
        item({ key: 'a', created_at: daysAgo(AGING_DAYS) }),
        item({ key: 'b', created_at: daysAgo(AGING_DAYS - 1) }),
      ],
      counts: { open: 2, oldest_days: 3, by_kind: { proposal: 2, triage: 0 } },
      nowMs: NOW,
    })
    expect(open.subsets.aging).toBe(1)
  })

  test('falls back to the oldest row when the server states no age', () => {
    const open = countOpenDecisions({
      items: [item({ key: 'a', created_at: daysAgo(4) }), item({ key: 'b', created_at: daysAgo(1) })],
      counts: { open: 2, oldest_days: null, by_kind: { proposal: 2, triage: 0 } },
      nowMs: NOW,
    })
    expect(open.oldestAgeDays).toBe(4)
  })
})

describe('what the incident banner says', () => {
  const openWith = (aging: number, total: number, capped = false) => ({
    total,
    byKind: { proposal: total, triage: 0 },
    subsets: { blocking: 0, overdue: 0, aging },
    oldestAgeDays: aging ? 9 : null,
    capped,
  })

  test('nothing open, no banner — a console that shouts at an empty queue is one nobody reads', () => {
    expect(bannerSubset(openWith(0, 0))).toBeNull()
  })

  test('a subset of the open positions: N of M, and N is never the whole thing by accident', () => {
    expect(bannerSubset(openWith(2, 5))).toEqual({ kind: 'aging', count: 2, total: 5, all: false, capped: false })
  })

  test('every open position aged: the sentence says all of them', () => {
    expect(bannerSubset(openWith(5, 5))?.all).toBe(true)
  })

  test('a short list hedges rather than understates', () => {
    const subset = bannerSubset(openWith(2, 400, true))
    expect(subset).toMatchObject({ kind: 'aging', count: 2, total: 400, capped: true })
  })

  test('something open but nothing aged still raises the banner, on the total', () => {
    // §8.7 wants the banner up whenever a gate is OPEN, not only once it has
    // also gone stale — and the number it names is then the whole queue.
    expect(bannerSubset(openWith(0, 3))).toEqual({ kind: 'open', count: 3, total: 3, all: true, capped: false })
  })

  test('the open floor never hedges: the total is exact even when the list is short', () => {
    expect(bannerSubset(openWith(0, 400, true))?.capped).toBe(false)
  })

  test('urgency wins over age when the feed grows deadlines', () => {
    const blocked = { ...openWith(2, 5), subsets: { blocking: 1, overdue: 2, aging: 2 } }
    expect(bannerSubset(blocked)?.kind).toBe('blocking')
    const overdue = { ...openWith(2, 5), subsets: { blocking: 0, overdue: 2, aging: 2 } }
    expect(bannerSubset(overdue)?.kind).toBe('overdue')
  })
})

describe('the wiki chips above the queue', () => {
  test('names every wiki with something open, largest share first', () => {
    const tallies = bySpace([
      item({ key: 'a', space: 'onboarding', space_name: 'Onboarding' }),
      item({ key: 'b', space: 'handbuch', space_name: 'Handbuch' }),
      item({ key: 'c', space: 'handbuch', space_name: 'Handbuch' }),
      item({ key: 'd', space: 'onboarding', space_name: 'Onboarding' }),
      item({ key: 'e', space: 'handbuch', space_name: 'Handbuch' }),
    ])
    expect(tallies).toEqual([
      { space: 'handbuch', name: 'Handbuch', count: 3 },
      { space: 'onboarding', name: 'Onboarding', count: 2 },
    ])
  })

  test('a wiki with nothing open has no chip — categories come from the data', () => {
    expect(bySpace([])).toEqual([])
  })

  test('counts positions, not rows: a duplicate does not inflate a chip', () => {
    const tallies = bySpace([
      item({ key: 'a', space_name: 'Handbuch' }),
      item({ key: 'a', space_name: 'Handbuch' }),
      item({ key: 'b', space_name: 'Handbuch' }),
    ])
    expect(tallies).toEqual([{ space: 'handbuch', name: 'Handbuch', count: 2 }])
  })

  test('falls back to the slug when the feed names no wiki', () => {
    expect(bySpace([item({ key: 'a' })])[0]!.name).toBe('handbuch')
  })

  test('ties break by name, so the chip order does not wobble between renders', () => {
    const tallies = bySpace([
      item({ key: 'a', space: 'zebra', space_name: 'Zebra' }),
      item({ key: 'b', space: 'alpha', space_name: 'Alpha' }),
    ])
    expect(tallies.map((tally) => tally.space)).toEqual(['alpha', 'zebra'])
  })
})

describe('one global read for four surfaces', () => {
  test('the sidebar badge, the overview card, the banner and the queue share these arguments', () => {
    // Stated once and imported four times. A second literal `{ limit: 200 }`
    // would be a second react-query cache entry — and a fifth number that can
    // disagree with the other four while the console is open.
    expect(GLOBAL_ATTENTION_QUERY).toEqual({ limit: 200 })
    const callers = [
      'apps/cockpit/src/app/shell.tsx',
      'apps/cockpit/src/pages/home.tsx',
      'apps/cockpit/src/pages/decisions.tsx',
    ]
    for (const caller of callers) {
      const source = readFileSync(join(process.cwd(), caller), 'utf8')
      expect(source, `${caller} does not read the shared global query`).toContain('GLOBAL_ATTENTION_QUERY')
    }
  })
})

describe('the one English sentence the pipeline writes into every ingest proposal', () => {
  // `Synthesized 8 concepts, 28 claims, 2 contradictions detected from source
  // <id>.` is composed by the ingest pipeline and handed to whatever renders
  // it — so it arrives in the queue in English, on a surface §5 requires to be
  // German at the top level. The numbers are the content; the English is only
  // the shape they arrived in.
  const de = (key: string, values: Readonly<Record<string, string | number>> = {}) =>
    `${values.count ?? ''} ${key.replace('summary.', '')}`.trim()

  test('reads the facts out of the sentence the server composes', () => {
    expect(
      parseSynthesisSummary(
        'Synthesized 8 concepts, 28 claims, 2 contradictions detected from source 8e065dc7-4b1a-4c33-9a77-1f0c1d3e5b62.',
      ),
    ).toEqual([
      { kind: 'concepts', count: 8 },
      { kind: 'claims', count: 28 },
      { kind: 'contradictions', count: 2 },
    ])
  })

  test('concepts and claims are always stated, the rest only when they happened', () => {
    // A missing key and a zero are different sentences (§4), and the pipeline
    // omits a clause it has nothing to say about rather than writing "0".
    expect(parseSynthesisSummary('Synthesized 1 concept, 1 claim')).toEqual([
      { kind: 'concepts', count: 1 },
      { kind: 'claims', count: 1 },
    ])
  })

  test('the narrower clauses are not swallowed by the broader ones', () => {
    const facts = parseSynthesisSummary(
      'Synthesized 2 concepts, 9 claims, 3 supersessions, 1 decision, 2 decisions already recorded (not re-staged), 4 decision updates',
    )
    expect(facts).toEqual([
      { kind: 'concepts', count: 2 },
      { kind: 'claims', count: 9 },
      { kind: 'supersessions', count: 3 },
      { kind: 'decisions', count: 1 },
      { kind: 'duplicates', count: 2 },
      { kind: 'updates', count: 4 },
    ])
  })

  test('prose it does not recognise is not a synthesis summary and is not guessed at', () => {
    // A half-translated sentence is worse than an English one.
    expect(parseSynthesisSummary('Zwei Absätze zur 14-Tage-Frist.')).toBeNull()
    expect(parseSynthesisSummary('')).toBeNull()
    expect(parseSynthesisSummary(null)).toBeNull()
  })

  test('the rendered line carries the numbers and none of the English', () => {
    const line = summaryLine(
      'Synthesized 8 concepts, 28 claims, 2 contradictions detected from source 8e065dc7-4b1a-4c33-9a77-1f0c1d3e5b62.',
      de as never,
    )
    expect(line).toBe('8 concepts, 28 claims, 2 contradictions')
    expect(line).not.toContain('Synthesized')
    expect(line).not.toContain('from source')
    expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  test('one of something asks for the singular key', () => {
    expect(summaryLine('Synthesized 1 concept, 1 claim', de as never)).toBe('1 concept, 1 claim')
  })

  test('an unrecognised summary keeps its words and loses only its identifier', () => {
    expect(summaryLine('Ein Absatz, belegt durch die Quelle 8e065dc7-4b1a-4c33-9a77-1f0c1d3e5b62.', de as never)).toBe(
      'Ein Absatz, belegt durch die Quelle.',
    )
    expect(summaryLine('', de as never)).toBe('')
  })

  test('both surfaces render summaries through it', () => {
    for (const caller of ['apps/cockpit/src/pages/home.tsx', 'apps/cockpit/src/pages/decisions.tsx']) {
      expect(readFileSync(join(process.cwd(), caller), 'utf8'), caller).toContain('summaryLine(')
    }
    // The English original is not deleted, it moves into the detail depth.
    expect(readFileSync(join(process.cwd(), 'apps/cockpit/src/pages/decisions.tsx'), 'utf8')).toContain(
      'summary.original',
    )
  })
})
