/**
 * A filtered list is an address.
 *
 * Every filter in this console lived in `useState`: five of them on the
 * proposal queue alone. That makes "the proposals awaiting review in the
 * platform space" a view an operator can reach and cannot hand to anybody — not
 * by link, not by bookmark, and not by reloading their own tab after the browser
 * dropped it. And handing it to somebody is the whole point: a review queue is a
 * thing one operator narrows and another operator has to look at. It is the same
 * rule the space tabs were given paths for, and the same rule `useTableView`
 * already applies to columns and sort.
 *
 * Deliberately a closed alphabet per filter. Every filter this console offers is
 * a select over an enum the server itself declares, so a value the URL carries is
 * either one of those or it is not a filter at all — and a parameter someone
 * hand-edited must never become a request the server has to refuse. Anything
 * unrecognised falls back to the neutral value, which is exactly what an unset
 * filter already means.
 *
 * No DOM, no React: `hooks/use-url-filters.ts` supplies the router and this
 * supplies the decisions, the same split as `lib/table-view.ts` and
 * `lib/clock-store.ts`.
 */

export interface FilterSpec {
  /** The search-parameter name, prefixed with the list's id by the hook. */
  key: string
  /** The values the server recognises. The fallback is never listed here. */
  values: readonly string[]
  /**
   * The value that means "do not filter". It is never written to the URL, so a
   * default view has a clean address and a link that names nothing is the
   * default view.
   */
  fallback: string
}

export type FilterValues = Readonly<Record<string, string>>

/** `proposals.status`, so two lists on one page cannot read each other's parameters. */
export function paramName(listId: string, key: string): string {
  return `${listId}.${key}`
}

/**
 * The filters an address names, with anything unrecognised falling back.
 *
 * A wrong value never reaches the server: it is not narrowed, not passed
 * through, and not reported as an error, because an address with a stale filter
 * in it is a link that outlived a release — showing the unfiltered list is the
 * honest reading of it.
 */
export function decodeFilters(
  listId: string,
  specs: readonly FilterSpec[],
  search: Readonly<Record<string, unknown>>,
): FilterValues {
  const values: Record<string, string> = {}
  for (const spec of specs) {
    const raw = search[paramName(listId, spec.key)]
    values[spec.key] = typeof raw === 'string' && spec.values.includes(raw) ? raw : spec.fallback
  }
  return values
}

/**
 * What to merge into the search parameters. `undefined` removes a key, which is
 * what keeps the default view's address clean.
 */
export function encodeFilters(
  listId: string,
  specs: readonly FilterSpec[],
  values: FilterValues,
): Record<string, string | undefined> {
  const search: Record<string, string | undefined> = {}
  for (const spec of specs) {
    const value = values[spec.key]
    search[paramName(listId, spec.key)] =
      value === undefined || value === spec.fallback || !spec.values.includes(value) ? undefined : value
  }
  return search
}

/** Every filter at its neutral value — what "Clear filters" writes. */
export function clearedFilters(specs: readonly FilterSpec[]): FilterValues {
  const values: Record<string, string> = {}
  for (const spec of specs) values[spec.key] = spec.fallback
  return values
}

/** Whether anything is actually narrowing the list — the only reason to offer a way out of it. */
export function isFiltered(specs: readonly FilterSpec[], values: FilterValues): boolean {
  return specs.some((spec) => values[spec.key] !== undefined && values[spec.key] !== spec.fallback)
}

/**
 * Which filters are narrowing, in the operator's words.
 *
 * An empty list under three filters reads as "there is nothing" unless the page
 * says which of them is doing the work; this is what the empty state names.
 */
export function activeFilterLabels(
  specs: readonly FilterSpec[],
  values: FilterValues,
  label: (spec: FilterSpec, value: string) => string = (spec, value) => `${spec.key}: ${value}`,
): string[] {
  return specs
    .filter((spec) => values[spec.key] !== undefined && values[spec.key] !== spec.fallback)
    .map((spec) => label(spec, values[spec.key]!))
}
