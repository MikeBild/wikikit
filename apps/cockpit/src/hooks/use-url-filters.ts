import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import {
  clearedFilters,
  decodeFilters,
  encodeFilters,
  isFiltered,
  type FilterSpec,
  type FilterValues,
} from '@/lib/url-filters'

/**
 * A list's filters, kept in the address instead of in component state.
 *
 * The decisions are all in `lib/url-filters.ts`; this supplies the router and
 * nothing else. `to: '.'` rewrites the current route's search rather than
 * navigating, so choosing a filter never leaves the page, and the write is a
 * real history entry — Back should undo a filter, because an operator who
 * narrowed a list by mistake reaches for Back before anything else.
 *
 * `strict: false` for the same reason `useTableView` uses it: no route in
 * router.tsx declares a search schema, so unrecognised keys survive both the URL
 * and this read.
 *
 * Deliberately no localStorage. A column choice is a preference; a filter is a
 * claim about what is on screen, and an operator opening /proposals expects
 * every proposal awaiting review, not whatever space they were narrowing to
 * last Thursday.
 */
export function useUrlFilters(
  listId: string,
  specs: readonly FilterSpec[],
): {
  filters: FilterValues
  setFilters: (patch: Partial<Record<string, string>>) => void
  clear: () => void
  filtered: boolean
} {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()

  const filters = useMemo(() => decodeFilters(listId, specs, search), [listId, specs, search])

  const write = useCallback(
    (next: FilterValues) => {
      const encoded = encodeFilters(listId, specs, next)
      void navigate({
        to: '.',
        search: ((previous: Record<string, unknown>) => ({ ...previous, ...encoded })) as never,
      })
    },
    [listId, specs, navigate],
  )

  const setFilters = useCallback(
    (patch: Partial<Record<string, string>>) => write({ ...filters, ...patch } as FilterValues),
    [filters, write],
  )

  const clear = useCallback(() => write(clearedFilters(specs)), [specs, write])

  return { filters, setFilters, clear, filtered: isFiltered(specs, filters) }
}
