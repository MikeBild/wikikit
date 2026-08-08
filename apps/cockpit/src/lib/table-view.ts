/**
 * What a list is allowed to claim about its own order and its own size.
 *
 * This module exists because both claims are easy to fake and expensive to get
 * wrong. **A header arrow that reorders the fifty rows currently on screen, in a
 * list of four thousand, looks exactly like a sorted list and is not one.** A
 * "1–25 of 106" counted in the browser over a page the server truncated is a
 * number nobody said. So order and size are modelled here as capabilities that
 * come from the endpoint, not from the component:
 *
 *   `Paging` says whether one response holds every row. Every list read in this
 *   console does: `GET /v1/spaces`, `/v1/spaces/{space}/concepts`,
 *   `/v1/api-keys`, `/v1/identities` and the rest answer a bare array for the
 *   filter they were given, with no `cursor` and no `next_cursor` — that is
 *   `'whole'`. Nothing here pages yet, so `'cursor'` has no caller today; it is
 *   in the model because the alternative is discovering that a control lies on
 *   the day a read starts paging.
 *
 *   `sortReach` turns a column plus that paging into how far a sort on it would
 *   actually reach. `'server'` when the endpoint orders it, `'complete'` when the
 *   console orders it but holds every row anyway, `'page'` when the console would
 *   only be reordering the window it happens to have, `'none'` when the column has
 *   no order at all. **Only the first two may be offered; `'page'` is the lie and
 *   the UI must not render a control for it.** Because this console's reads answer
 *   whole arrays, every comparable column grades `'complete'` — all of it is
 *   honestly offerable, which is why the lists here can stop being a fixed order
 *   chosen by whoever wrote the page.
 *
 * Size has one more trap, and it is local: `/v1/spaces/{space}/sources` and
 * `/v1/spaces/{space}/proposals` take a `limit`. A limit is a truncation, not a
 * page — there is no second page to ask for — so a sort still covers every row
 * the console holds, but the count beside it is the number LOADED and not the
 * number that exists. In a space with four thousand archived sources, "1–25 of
 * 200" would be a sentence about the request rather than about the space.
 * `isCapped` is what makes the surface say so instead of printing a total the
 * server never claimed.
 *
 * The window over a `'whole'` list is expressed as a cursor — a decimal row
 * offset, minted here — so that both paging shapes drive the same reducer in
 * `./cursor` and the same pagination control.
 *
 * Nothing here imports React or touches the DOM, so all of it is callable from
 * test/unit (test/unit/cockpit-table-view.test.ts).
 */

// The extension is explicit because this module is imported by test/unit as well
// as by the bundler, and neither guesses one. Both tsconfigs already set
// `allowImportingTsExtensions` for exactly this.
import { firstPage, type CursorPage } from './cursor.ts'

export type SortDirection = 'asc' | 'desc'

export interface SortState {
  column: string
  direction: SortDirection
}

/** What an operator chose to see, and in what order. The URL's half of a list. */
export interface TableView {
  visible: readonly string[]
  sort: SortState | null
}

/** Where the rows come from, as far as size is concerned. */
export type Paging = 'whole' | 'cursor'

export type SortReach = 'server' | 'complete' | 'page' | 'none'

/**
 * A column, reduced to the facts that decide what may be offered for it. The
 * rendering half (label, cell, classes) lives with the component; this shape is
 * deliberately data so it can be reasoned about without a DOM.
 */
export interface ColumnCapability {
  id: string
  /** The console can put two rows of this column in order. */
  comparable?: boolean
  /** The endpoint itself accepts an order for this column. */
  server?: boolean
  /** Identifies the row or carries its actions. Hiding it breaks the list. */
  required?: boolean
  hiddenByDefault?: boolean
  /** A date column's first click should be newest-first, not oldest-first. */
  descFirst?: boolean
}

/**
 * A column as a page declares one: the capability flags, plus a comparator whose
 * PRESENCE is the `comparable` capability. A column with a comparator can be
 * ordered by the console; one without it cannot be ordered at all, and no amount
 * of configuration elsewhere can conjure the order into existence.
 */
export interface ColumnSpec extends Omit<ColumnCapability, 'comparable'> {
  compare?: unknown
}

/** The capability half of a page's column list, with the comparator read as a flag. */
export function capabilitiesOf(columns: readonly ColumnSpec[]): ColumnCapability[] {
  return columns.map((column) => ({
    id: column.id,
    comparable: Boolean(column.compare),
    server: column.server,
    required: column.required,
    hiddenByDefault: column.hiddenByDefault,
    descFirst: column.descFirst,
  }))
}

function byId(columns: readonly ColumnCapability[], id: string | undefined): ColumnCapability | undefined {
  return id ? columns.find((column) => column.id === id) : undefined
}

/** How far a sort on this column would reach, given where the rows come from. */
export function sortReach(column: ColumnCapability | undefined, paging: Paging): SortReach {
  if (!column) return 'none'
  // The endpoint's own order covers the whole result whatever the page size is.
  if (column.server) return 'server'
  if (!column.comparable) return 'none'
  // The console's comparator covers the whole result only when the response did.
  return paging === 'whole' ? 'complete' : 'page'
}

/** Whether a sort control may exist. `'page'` may not: it would cover one page of many. */
export function isOfferable(reach: SortReach): boolean {
  return reach === 'server' || reach === 'complete'
}

/**
 * Whether the rows on screen are all there is, or all the console asked for.
 *
 * A read that was given `limit=N` and answered N rows is at its ceiling, and the
 * console cannot tell a list of exactly N from a list of thousands. Saying so is
 * the difference between a count and a total.
 */
export function isCapped(rows: number, cap: number | null | undefined): boolean {
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 && rows >= cap
}

/* ------------------------------------------------------------------ columns */

export function defaultVisible(columns: readonly ColumnCapability[]): string[] {
  return columns.filter((column) => !column.hiddenByDefault).map((column) => column.id)
}

/** Column order is the table's, never the caller's, and required columns are never absent. */
function normalise(columns: readonly ColumnCapability[], visible: readonly string[]): string[] {
  const asked = new Set(visible)
  return columns.filter((column) => column.required || asked.has(column.id)).map((column) => column.id)
}

/**
 * Read a visible set out of a URL.
 *
 * The parameter names the columns to show, so reading the URL tells the operator
 * what they are about to see. Two failure modes are handled rather than trusted:
 * an id this version does not have (a bookmark from a later one) is dropped, and
 * a parameter with nothing recognisable in it falls back to the default view — a
 * hand-edited or stale link must never open an empty table.
 */
export function decodeVisible(columns: readonly ColumnCapability[], param: string | null | undefined): string[] {
  const named = new Set(
    String(param ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  if (!columns.some((column) => named.has(column.id))) return defaultVisible(columns)
  return normalise(columns, [...named])
}

/** `undefined` for the default view, so the URL only carries a deliberate choice. */
export function encodeVisible(columns: readonly ColumnCapability[], visible: readonly string[]): string | undefined {
  const set = normalise(columns, visible)
  const fallback = defaultVisible(columns)
  if (set.length === fallback.length && set.every((id, index) => id === fallback[index])) return undefined
  return set.join(',')
}

/**
 * Show or hide one column.
 *
 * Two moves are refused. A required column cannot be hidden — the row would lose
 * the field that names it, or the button that opens it. And the last visible
 * column cannot be hidden either: a table of zero columns cannot say whether it
 * is empty, loading or refused, which is the one distinction this console insists
 * on everywhere else.
 */
export function toggleVisible(columns: readonly ColumnCapability[], visible: readonly string[], id: string): string[] {
  const column = byId(columns, id)
  const current = normalise(columns, visible)
  if (!column || column.required) return current
  if (!current.includes(id)) return normalise(columns, [...current, id])
  const next = current.filter((entry) => entry !== id)
  return next.length ? next : current
}

/* --------------------------------------------------------------------- sort */

export function decodeSort(
  columns: readonly ColumnCapability[],
  paging: Paging,
  param: string | null | undefined,
): SortState | null {
  const [id, direction] = String(param ?? '').split(':')
  if (!id) return null
  if (direction !== 'asc' && direction !== 'desc') return null
  if (!isOfferable(sortReach(byId(columns, id), paging))) return null
  return { column: id, direction }
}

export function encodeSort(sort: SortState | null): string | undefined {
  return sort ? `${sort.column}:${sort.direction}` : undefined
}

/**
 * One click on a header.
 *
 * Three states, not two: ascending, descending, and back to the order the
 * endpoint sent. The third is a real state and it is not otherwise reachable —
 * the proposal queue arrives newest-first, which is not a column an operator can
 * name, so "undo my sort" has to be a move rather than a guess at which column
 * was the original one.
 *
 * A click on a column whose sort would only cover one page changes nothing. The
 * header for such a column renders no control, and this is the second guard.
 */
export function nextSort(
  columns: readonly ColumnCapability[],
  paging: Paging,
  current: SortState | null,
  id: string,
): SortState | null {
  const column = byId(columns, id)
  if (!isOfferable(sortReach(column, paging))) return current
  const first: SortDirection = column?.descFirst ? 'desc' : 'asc'
  if (!current || current.column !== id) return { column: id, direction: first }
  if (current.direction !== first) return null
  return { column: id, direction: first === 'asc' ? 'desc' : 'asc' }
}

/**
 * Drop a sort that can no longer be seen or no longer holds.
 *
 * Hiding the sorted column is the case that matters: the rows stay in that order,
 * the arrow that explained it is gone, and the list now looks like the default
 * order while being something else entirely. Rows must never sit in an order
 * nothing on screen accounts for.
 */
export function reconcileSort(
  columns: readonly ColumnCapability[],
  paging: Paging,
  visible: readonly string[],
  sort: SortState | null,
): SortState | null {
  if (!sort) return null
  if (!visible.includes(sort.column)) return null
  if (!isOfferable(sortReach(byId(columns, sort.column), paging))) return null
  return sort
}

/* ------------------------------------------------------------- comparators */

/**
 * Missing text is the empty string: first ascending, last descending. Sorting a
 * list of slugs must not invent a place for the rows that have none, and the
 * symmetric answer is the one an operator can predict.
 */
export function compareText(left: string | null | undefined, right: string | null | undefined): number {
  return (left ?? '').localeCompare(right ?? '')
}

/** An unparseable or missing instant is the oldest thing in the list, never the newest. */
export function compareTime(left: string | null | undefined, right: string | null | undefined): number {
  const at = (value: string | null | undefined) => {
    const parsed = value ? new Date(value).valueOf() : Number.NaN
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
  }
  const difference = at(left) - at(right)
  // Two absent instants are equal, and -Infinity - -Infinity is NaN, which would
  // make the comparator return NaN and the order implementation-defined.
  return Number.isNaN(difference) ? 0 : difference
}

/**
 * A number nobody sent is not zero (CUI-SEV-2), and it must not sort as zero
 * either — an ingest with no duration would land between 0 and 1 second, in the
 * middle of the measured rows, indistinguishable from a fast one. Unmeasured
 * sorts below every measured value, the same rule `compareTime` uses, so an
 * operator learns one rule for the whole console: the blanks are at the bottom
 * ascending and at the top descending.
 */
export function compareNumber(left: number | null | undefined, right: number | null | undefined): number {
  const at = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
  const difference = at(left) - at(right)
  return Number.isNaN(difference) ? 0 : difference
}

/* ------------------------------------------------------------------ window */

export interface RowWindow {
  start: number
  end: number
  /** The cursor for the window after this one, or `null` at the end of the list. */
  nextCursor: string | null
}

function offsetOf(cursor: string | null | undefined, rows: number, step: number): number {
  if (!cursor) return 0
  const parsed = Number(cursor)
  if (!Number.isInteger(parsed) || parsed <= 0) return 0
  // The list shrank under the operator — a filter changed, or a refetch answered
  // fewer rows. Its start is the only position that certainly exists.
  if (parsed >= rows) return 0
  return parsed - (parsed % step)
}

/** Which rows of a fully held result this cursor names. */
export function windowOf(total: number, cursor: string | null | undefined, size: number): RowWindow {
  const step = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 1
  const rows = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  const start = offsetOf(cursor, rows, step)
  const end = Math.min(rows, start + step)
  return { start, end, nextCursor: end < rows ? String(end) : null }
}

/**
 * Forget a walk the result can no longer support.
 *
 * `CursorPage.seen` is what prints the page number, and `windowOf` clamps a
 * cursor it cannot honour to the start of the list. Left alone, those two
 * disagree: "Page 3" over rows 1–25. Returning the state unchanged by identity in
 * the common case keeps this callable on every render.
 */
export function clampPage(page: CursorPage, total: number, size: number): CursorPage {
  if (page.cursor === null) return page
  const asked = Number(page.cursor)
  const { start } = windowOf(total, page.cursor, size)
  return Number.isInteger(asked) && asked === start ? page : firstPage
}
