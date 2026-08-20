/**
 * The open-decision arithmetic, with no DOM and no API client under it.
 *
 * There is exactly ONE number of open decisions in this console, and this file
 * is where it is computed. That sounds like over-organisation for a `.length`
 * until you count the places the number is shown: the sidebar badge, the Zone-A
 * card on the overview, the incident banner above it, and the queue itself.
 * Four surfaces, four call sites, four chances to count something slightly
 * different — and an operator who reads "1" beside the navigation entry and "3"
 * on the front page does not conclude that one of them is wrong. They conclude
 * that neither can be trusted, which is the more expensive failure and the
 * harder one to notice, because nothing is broken.
 *
 * So the rules:
 *
 *  - **`total` is the SERVER's count, never `items.length`.** The list is
 *    paginated; the count is not. A number derived from a page of results says
 *    "3 waiting" on a queue of four hundred and is wrong in the direction that
 *    makes somebody stop looking.
 *  - **`capped` says when the list is short of the count**, so a surface that
 *    counts rows can say "at least" instead of quietly understating.
 *  - **Identity is `space:key`, not `key`.** The keys are per-wiki, and the
 *    global feed carries several wikis: two wikis with a proposal each are two
 *    decisions, and the same proposal echoed twice by a retry is one.
 *  - **`byKind` always carries both kinds.** A missing key and a zero are
 *    different sentences (Konvention §4) and only one of them is a measurement.
 *
 * `blocking` and `overdue` are structurally 0 today and stay in the shape on
 * purpose: the global feed does not carry deadlines or health gates yet, and a
 * subset that appears the day the field does is a subset nobody wired up. Zero
 * here means "measured, none" — the same claim §4 asks every other counter to
 * make.
 */

/** The shape the global attention feed hands over, restated free of the client. */
export interface OpenDecisionItem {
  space: string
  space_name?: string
  key: string
  kind: 'proposal' | 'triage'
  created_at: string
}

export interface OpenDecisionCounts {
  open: number
  oldest_days: number | null
  by_kind: { proposal: number; triage: number }
}

export interface OpenDecisionInput {
  items: readonly OpenDecisionItem[]
  counts: OpenDecisionCounts
  nowMs: number
}

export interface OpenDecisions {
  /** The server's count of open positions — the one number every surface shows. */
  total: number
  byKind: { proposal: number; triage: number }
  subsets: { blocking: number; overdue: number; aging: number }
  oldestAgeDays: number | null
  /** The delivered list is shorter than the count, so row-derived subsets undercount. */
  capped: boolean
}

/**
 * The one global attention read, stated once.
 *
 * The sidebar badge, the Zone-A card, the incident banner and the queue all
 * call `wk.attention.global` with THESE arguments, so react-query hands the
 * four of them one cache entry rather than four requests that can answer
 * differently while the page is open. A second literal `{ limit: 200 }`
 * somewhere would be a second cache entry and a fifth number.
 */
export const GLOBAL_ATTENTION_QUERY = { limit: 200 } as const

/** §8.2's rubric boundary: three whole days of waiting. */
export const AGING_DAYS = 3
const DAY_MS = 86_400_000

/** The identity of a position across wikis — keys are per-wiki, the feed is not. */
export function decisionId(item: Pick<OpenDecisionItem, 'space' | 'key'>): string {
  return `${item.space}:${item.key}`
}

/**
 * Distinct positions, first occurrence wins, order preserved.
 *
 * Generic over the row rather than fixed to `OpenDecisionItem`: the queue
 * deduplicates the SAME rows it then renders, and a signature that widened them
 * to the identity fields would make the caller reach for the originals again —
 * which is how a list and its count end up describing two different sets.
 */
export function dedupe<T extends Pick<OpenDecisionItem, 'space' | 'key'>>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const item of items) {
    const id = decisionId(item)
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(item)
  }
  return unique
}

export function ageInDays(createdAt: string, nowMs: number): number | null {
  const created = new Date(createdAt).getTime()
  if (!Number.isFinite(created)) return null
  return Math.max(0, Math.floor((nowMs - created) / DAY_MS))
}

export function countOpenDecisions(input: OpenDecisionInput): OpenDecisions {
  const unique = dedupe(input.items)
  const ages = unique
    .map((item) => ageInDays(item.created_at, input.nowMs))
    .filter((age): age is number => age !== null)
  const aging = ages.filter((age) => age >= AGING_DAYS).length
  const derivedOldest = ages.length ? Math.max(...ages) : null
  return {
    total: input.counts.open,
    byKind: { proposal: input.counts.by_kind.proposal, triage: input.counts.by_kind.triage },
    // Deadlines and health gates do not reach the global feed yet. Zero is the
    // measurement, not a placeholder — see the note at the top of this file.
    subsets: { blocking: 0, overdue: 0, aging },
    oldestAgeDays: input.counts.oldest_days ?? derivedOldest,
    capped: unique.length < input.counts.open,
  }
}

export type DecisionSubsetKind = 'blocking' | 'overdue' | 'aging' | 'open'

export interface BannerSubset {
  kind: DecisionSubsetKind
  /** The positions this subset names — N in "N von M". */
  count: number
  /** Every open position — M in "N von M", and always the same number as `total`. */
  total: number
  all: boolean
  /** The count came from a short list, so the honest word is "mindestens". */
  capped: boolean
}

/**
 * What the incident banner is about, or nothing at all.
 *
 * The order is urgency: a blocked gate outranks a missed deadline outranks a
 * position nobody has touched in three days. `open` is the floor — something is
 * waiting and none of the sharper things is true — because §8.7 wants the
 * banner up whenever a gate is open, not only when it has also gone stale.
 *
 * Null exactly when nothing is open. That is the other half of the rule: a
 * console that shouts on an empty queue teaches people to stop reading banners.
 */
export function bannerSubset(open: OpenDecisions): BannerSubset | null {
  if (open.total <= 0) return null
  const kind: DecisionSubsetKind =
    open.subsets.blocking > 0
      ? 'blocking'
      : open.subsets.overdue > 0
        ? 'overdue'
        : open.subsets.aging > 0
          ? 'aging'
          : 'open'
  const count = kind === 'open' ? open.total : open.subsets[kind]
  return {
    kind,
    count,
    total: open.total,
    all: count >= open.total,
    // A full list cannot be undercounting, whatever the flag says.
    capped: kind !== 'open' && open.capped,
  }
}

/** One wiki's share of the open queue. */
export interface SpaceTally {
  space: string
  name: string
  count: number
}

/**
 * The wikis the open queue currently touches, largest share first.
 *
 * The chips built from this FILTER ROWS AND NOTHING ELSE. The four numbers on
 * screen keep counting the whole installation while a chip is active, because
 * a filter that also moves the counter turns "5 waiting" into "5 waiting in
 * what I happen to be looking at" — and nobody reads a counter that way.
 *
 * Categories come from the data, never from a hardcoded list (§10): a wiki with
 * nothing open has no chip, and the day it has something it gets one.
 */
export function bySpace(items: readonly OpenDecisionItem[]): SpaceTally[] {
  const tallies = new Map<string, SpaceTally>()
  for (const item of dedupe(items)) {
    const existing = tallies.get(item.space)
    if (existing) existing.count += 1
    else tallies.set(item.space, { space: item.space, name: item.space_name ?? item.space, count: 1 })
  }
  return [...tallies.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}
