/**
 * Where a list's window is, and how it gets back.
 *
 * Every list read in this console answers a whole array — `/v1/spaces`,
 * `/v1/spaces/{space}/concepts`, `/v1/spaces/{space}/sources`,
 * `/v1/spaces/{space}/proposals` and the rest hand back every row they have for
 * the filter they were given, with no `cursor` parameter and no `next_cursor`
 * in the body. So the cursor a `Pagination` walks is minted by the console: a
 * decimal row offset into a result the console fully holds (see
 * `windowOf` in `./table-view`). A client-minted cursor is still a real cursor —
 * it addresses a position in a result that exists.
 *
 * The state is modelled as a walk rather than as a page number because the day a
 * read starts paging server-side, the cursor becomes opaque and the walk is all
 * that survives. Two consequences, and they are the reason this is a value
 * instead of two `useState` calls in a page:
 *
 * "Previous" cannot be asked for, only remembered — `seen` is that memory, the
 * cursors already spent, oldest first. And "page 7" is not addressable through an
 * opaque cursor, so the number below is a position the operator walked to,
 * printed as a fact, never offered as a link.
 *
 * Nothing here imports React, so all of it is callable from test/unit.
 */

export interface CursorPage {
  /** The cursor this page was fetched with. `null` is the first page. */
  cursor: string | null
  /** The cursors of the pages before it, oldest first. */
  seen: readonly (string | null)[]
}

export const firstPage: CursorPage = { cursor: null, seen: [] }

/**
 * Forward, if there is a forward.
 *
 * Both guards return the state unchanged, by identity, so a caller can compare
 * and skip work. The second one is not theoretical: the cursor forward comes
 * from the rows currently on screen and does not move until new ones arrive, so
 * a second click on Next — or a held key — would otherwise push the same cursor
 * twice and make Previous walk back through a page nobody saw.
 */
export function nextPage(page: CursorPage, nextCursor: string | null | undefined): CursorPage {
  if (!nextCursor) return page
  if (nextCursor === page.cursor) return page
  return { cursor: nextCursor, seen: [...page.seen, page.cursor] }
}

/** Back to the cursor this page came from. The first page has nowhere to go. */
export function previousPage(page: CursorPage): CursorPage {
  if (page.seen.length === 0) return page
  return { cursor: page.seen[page.seen.length - 1] ?? null, seen: page.seen.slice(0, -1) }
}

export function hasPrevious(page: CursorPage): boolean {
  return page.seen.length > 0
}

/** Whether there is a page after this one. Only the rows on screen can say. */
export function hasNext(nextCursor: string | null | undefined): boolean {
  return Boolean(nextCursor)
}

/** How deep the operator has walked, counting from 1. */
export function pageNumber(page: CursorPage): number {
  return page.seen.length + 1
}

/**
 * Back to the start, for a filter change.
 *
 * A cursor belongs to the result that produced it. Keeping one across a new
 * status or space filter lands the operator in the middle of a list they have
 * not seen the start of — and against a server-side cursor it would answer from
 * the middle of a different list entirely.
 */
export function resetPage(): CursorPage {
  return firstPage
}
