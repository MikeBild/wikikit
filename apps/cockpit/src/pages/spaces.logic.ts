/**
 * The Wikis page's rules for the cross-wiki overview, with no DOM under them.
 *
 * The page holds TWO independent reads: the space list (identity — slug, name,
 * settings) and `/v1/stats/overview` (numbers). The rules here are all about
 * what happens when only one of them has answered, and they are the Care
 * page's rules restated across wikis:
 *
 *  - **Identity renders before numbers.** A row exists the moment the space
 *    list answers; the overview joining late (or failing) fills dashes into
 *    the number columns and never blanks the table (CUI-LOAD-4).
 *  - **A value nobody sent is `—`, never `0`** (CUI-SEV-2). `ov: null` means
 *    "the overview has not said", while `pending: 0` is a measured zero — the
 *    two must not look alike, so `mergeOverview` keeps the whole overview row
 *    nullable instead of defaulting its fields.
 *  - **Attention order is the default order**: the wiki whose oldest change
 *    has waited longest comes first, because the age — not the count — is what
 *    turns a queue into a backlog. Unmeasured rows sort last; the slug breaks
 *    ties so the order is stable across refetches.
 */

/** One row of `/v1/stats/overview`, as the page reads it. */
export interface OverviewItem {
  space: string
  review_queue: { pending: number; oldest_days: number | null; pending_derived: number }
  created_7d: number
  concepts: number
}

export interface OverviewTotals {
  pending: number
  pending_derived: number
  created_7d: number
  oldest_days: number | null
}

/** A wiki row after the join: identity always, numbers only once measured. */
export interface MergedRow<S> {
  space: S
  /** null while the overview read is pending or failed — dashes, never zeros. */
  ov: OverviewItem | null
}

/**
 * Join the space list with the overview by slug. Spaces the overview does not
 * mention (a row added between the two reads) stay `ov: null` — un-measured,
 * not zero.
 */
export function mergeOverview<S extends { slug: string }>(
  spaces: readonly S[],
  overview: { items: OverviewItem[] } | null | undefined,
): MergedRow<S>[] {
  const bySlug = new Map((overview?.items ?? []).map((item) => [item.space, item]))
  return spaces.map((space) => ({ space, ov: bySlug.get(space.slug) ?? null }))
}

/**
 * Oldest wait first, unmeasured last, slug as the tiebreak.
 *
 * A row with `pending: 0` has a null age and sorts with the quiet wikis — the
 * order is about who has been waiting, not who is largest. Returns a sorted
 * copy; the caller's array may belong to a query cache.
 */
export function attentionOrder<S extends { slug: string }>(rows: readonly MergedRow<S>[]): MergedRow<S>[] {
  const age = (row: MergedRow<S>) => row.ov?.review_queue.oldest_days ?? null
  return [...rows].sort((left, right) => {
    const leftAge = age(left)
    const rightAge = age(right)
    if (leftAge !== rightAge) {
      if (leftAge === null) return 1
      if (rightAge === null) return -1
      return rightAge - leftAge
    }
    return left.space.slug.localeCompare(right.space.slug)
  })
}

/**
 * The backlog split by provenance: changes resting entirely on the wiki's own
 * generated reports, and the rest. The label the page draws beside the derived
 * count says where those changes CAME from ("from generated reports") — never
 * what they are worth; the stamp is provenance, and mixed-provenance changes
 * count as human on purpose (the server's under-count semantics).
 */
export function backlogSplit(queue: { pending: number; pending_derived: number }): {
  human: number
  derived: number
} {
  return { human: queue.pending - queue.pending_derived, derived: queue.pending_derived }
}
