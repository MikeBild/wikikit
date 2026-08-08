import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  capabilitiesOf,
  decodeSort,
  decodeVisible,
  encodeSort,
  encodeVisible,
  reconcileSort,
  type ColumnSpec,
  type Paging,
  type TableView,
} from '@/lib/table-view'

/**
 * Where a list's columns and order live: in the URL, with the last choice
 * remembered as the opening guess.
 *
 * **A view is an address**, for the same reason a tab is one (PAGES.md, and the
 * space tabs that had to be given paths). "Look at this list" is a link somebody
 * sends a colleague; if the sort and the columns live in `useState`, the
 * colleague opens a different list and neither of them knows it. The search
 * parameter is the truth, and it is readable: `?proposals.sort=raised:desc` says
 * what is about to be on screen.
 *
 * localStorage is not a second truth, only the guess for a URL that names no
 * view — the console's own navigation links carry no view parameters, so leaving
 * /proposals for /sources and coming back drops them. The stored value is
 * adopted once, with `replace`, which puts it back in the URL where the rest of
 * the session can see it, and it never overrules a view the URL did name.
 *
 * Parameters are prefixed with the list's id, so two lists on one page cannot
 * read each other's column ids, and `to: '.'` rewrites the current route's search
 * rather than navigating, so choosing a column never leaves the page.
 *
 * This lives in `hooks/` rather than beside `DataTable` deliberately: a module
 * that exports a component and a hook defeats fast refresh, and
 * `eslint-plugin-react-refresh` is active on apps/cockpit.
 *
 * `columns` must be a stable array — declared at module scope, or `useMemo`d when
 * a cell closes over something the page holds. An array rebuilt on every render
 * re-derives the view on every render and re-sorts the rows behind it; nothing
 * breaks, but the list does the work of a fresh sort for every keystroke in a
 * filter box.
 */
export function useTableView(
  listId: string,
  columns: readonly ColumnSpec[],
  paging: Paging = 'whole',
): { view: TableView; setView: (view: TableView) => void } {
  const specs = useMemo(() => capabilitiesOf(columns), [columns])
  const columnsKey = `${listId}.cols`
  const sortKey = `${listId}.sort`
  const storageKey = `wk-cockpit-view:${listId}`
  // `strict: false` because no route in router.tsx declares a search schema, and
  // the router is not in strict search mode: unrecognised keys survive both the
  // URL and this read. Same escape hatch the pages use for `useParams`.
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()

  const rawColumns = typeof search[columnsKey] === 'string' ? (search[columnsKey] as string) : undefined
  const rawSort = typeof search[sortKey] === 'string' ? (search[sortKey] as string) : undefined

  // The URL wins whenever it says anything at all, so a link that deliberately
  // names the default view is not overruled by what this browser last chose.
  const named = rawColumns !== undefined || rawSort !== undefined
  const remembered = useMemo(() => (named ? null : readStored(storageKey)), [named, storageKey])
  const visible = useMemo(
    () => decodeVisible(specs, rawColumns ?? remembered?.cols),
    [specs, rawColumns, remembered?.cols],
  )
  const sort = useMemo(
    () => reconcileSort(specs, paging, visible, decodeSort(specs, paging, rawSort ?? remembered?.sort)),
    [specs, paging, visible, rawSort, remembered?.sort],
  )

  const write = useCallback(
    (next: TableView, replace: boolean) => {
      const cols = encodeVisible(specs, next.visible)
      // Reconciled on the way OUT as well as on the way in: hiding the sorted
      // column and writing the sort anyway would put the rows in an order the
      // header no longer explains.
      const order = encodeSort(reconcileSort(specs, paging, next.visible, next.sort))
      writeStored(storageKey, cols, order)
      void navigate({
        to: '.',
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          [columnsKey]: cols,
          [sortKey]: order,
        })) as never,
        replace,
      })
    },
    [specs, paging, navigate, columnsKey, sortKey, storageKey],
  )

  const setView = useCallback((next: TableView) => write(next, false), [write])

  // The remembered view is put back into the URL rather than merely applied, so a
  // link copied after the adoption carries it. `replace`, so Back does not walk
  // into a URL the operator never chose.
  //
  // Once per mount, and the latch is what makes it once: the effect's dependencies
  // are the values it writes, so it is re-entered on the very render its own
  // navigation causes.
  const adopted = remembered !== null && (remembered.cols !== undefined || remembered.sort !== undefined)
  const done = useRef(false)
  useEffect(() => {
    if (!adopted || done.current) return
    done.current = true
    write({ visible, sort }, true)
  }, [adopted, write, visible, sort])

  return { view: { visible, sort }, setView }
}

/**
 * Every storage access is guarded: it throws outright in a tab where the operator
 * has blocked site data, and a column choice is not worth a blank screen. The
 * console in private mode still works; it just forgets between visits.
 */
function readStored(key: string): { cols?: string; sort?: string } | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    return {
      cols: typeof record.cols === 'string' ? record.cols : undefined,
      sort: typeof record.sort === 'string' ? record.sort : undefined,
    }
  } catch {
    return null
  }
}

function writeStored(key: string, cols: string | undefined, sort: string | undefined): void {
  try {
    // Only a deliberate view is remembered; the default view stores nothing, so a
    // later release that adds a column is not overruled by an old guess.
    if (cols === undefined && sort === undefined) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify({ cols, sort }))
  } catch {
    /* blocked site data: the view still holds for this tab's lifetime */
  }
}
