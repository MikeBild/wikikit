// The Wikis page's rules for the cross-wiki overview: what happens when only
// one of its two reads has answered, which wiki comes first, and how the
// backlog splits by provenance. All of it without a DOM, per PAGES.md.
import { describe, expect, test } from 'bun:test'
import {
  attentionOrder,
  backlogSplit,
  mergeOverview,
  type OverviewItem,
} from '../../../apps/cockpit/src/pages/spaces.logic.ts'

function item(
  space: string,
  overrides: Partial<OverviewItem['review_queue']> = {},
  rest?: Partial<OverviewItem>,
): OverviewItem {
  return {
    space,
    review_queue: { pending: 0, oldest_days: null, pending_derived: 0, ...overrides },
    created_7d: 0,
    concepts: 0,
    ...rest,
  }
}

describe('mergeOverview: identity before numbers', () => {
  test('a pending or failed overview keeps every row, with ov null — dashes, never zeros', () => {
    const rows = mergeOverview([{ slug: 'alpha' }, { slug: 'beta' }], null)
    expect(rows).toEqual([
      { space: { slug: 'alpha' }, ov: null },
      { space: { slug: 'beta' }, ov: null },
    ])
  })

  test('joins by slug and leaves a wiki the overview does not mention un-measured', () => {
    const alpha = item('alpha', { pending: 2 })
    const rows = mergeOverview([{ slug: 'alpha' }, { slug: 'fresh' }], { items: [alpha] })
    expect(rows[0]).toEqual({ space: { slug: 'alpha' }, ov: alpha })
    // Added between the two reads: un-measured, not zero.
    expect(rows[1]).toEqual({ space: { slug: 'fresh' }, ov: null })
  })
})

describe('attentionOrder: oldest wait first, nulls last, slug tiebreak', () => {
  test('sorts by the age of the oldest change, descending', () => {
    const rows = mergeOverview([{ slug: 'young' }, { slug: 'old' }], {
      items: [item('young', { pending: 9, oldest_days: 2 }), item('old', { pending: 1, oldest_days: 21 })],
    })
    // The COUNT does not decide — one change waiting three weeks outranks
    // nine waiting two days. The age is what turns a queue into a backlog.
    expect(attentionOrder(rows).map((row) => row.space.slug)).toEqual(['old', 'young'])
  })

  test('a measured empty queue and an unmeasured wiki both sort last, by slug', () => {
    const rows = mergeOverview([{ slug: 'c-unmeasured' }, { slug: 'b-empty' }, { slug: 'a-waiting' }], {
      items: [item('b-empty'), item('a-waiting', { pending: 1, oldest_days: 3 })],
    })
    expect(attentionOrder(rows).map((row) => row.space.slug)).toEqual(['a-waiting', 'b-empty', 'c-unmeasured'])
  })

  test('returns a sorted copy — the input array may belong to a query cache', () => {
    const rows = mergeOverview([{ slug: 'b' }, { slug: 'a' }], null)
    const sorted = attentionOrder(rows)
    expect(sorted).not.toBe(rows)
    expect(rows.map((row) => row.space.slug)).toEqual(['b', 'a'])
  })
})

describe('backlogSplit: provenance, never a verdict', () => {
  test('splits the queue into human and derived', () => {
    expect(backlogSplit({ pending: 5, pending_derived: 2 })).toEqual({ human: 3, derived: 2 })
  })

  test('a mixed-provenance change counts as human — the server under-counts derived on purpose', () => {
    // pending_derived only counts changes whose EVERY source is derived, so
    // the human side absorbs everything mixed. The split must preserve that.
    expect(backlogSplit({ pending: 4, pending_derived: 0 })).toEqual({ human: 4, derived: 0 })
  })
})
