/**
 * The rules the search surface runs on, with no DOM under them.
 *
 * Import-free for the same reason `sources.logic.ts` is: `test/unit/` compiles
 * against the ROOT tsconfig, which declares no `@/*` path mapping, so a logic
 * module that reaches for an alias is a logic module no unit test can load.
 */

/**
 * How many hits this console asks for PER TIER.
 *
 * `zSearchQuery` allows a `limit` up to 50 and applies it to each tier
 * separately, so 50 was available and was deliberately not taken. Two reasons,
 * and the second is the one that decided it:
 *
 * A ranked list is not a log. The tail of a `ts_rank` ordering is where the
 * words stopped matching, so the answer to "my hit is not in here" is different
 * words, never more rows — unlike the delivery log or the change queue, where
 * the missing row is the whole errand and the only fix is a bigger read.
 *
 * And this page has no pagination. `approved_then_sources` at 25 already puts
 * fifty cards on one unbroken scroll; asking for the server's 50 would put a
 * hundred there and STILL end at a ceiling, one twice as far from the search
 * box that is the actual way out. So the console keeps its own smaller number
 * and — this is the part that was missing — says when it has been reached.
 */
export const RESULT_LIMIT = 25

/**
 * The sentence a tier gets when it came back full, or `null`.
 *
 * "25 hits on pages a human reviewed and published" is a count that reads as a
 * total, and at exactly the limit it is not one: the reader is looking at the
 * top of a ranking whose remainder this page never asked for. The note names
 * the ceiling and points at the only control that reaches past it — nobody can
 * scroll their way to a hit the server never sent.
 *
 * `null` below the ceiling rather than a softer sentence: a search that
 * returned nine hits returned every hit there is, and a permanent "there may be
 * more" would teach a reader to distrust the count that is true.
 */
export function resultCeilingNote(loaded: number, unit: 'hits' | 'excerpts'): string | null {
  if (loaded < RESULT_LIMIT) return null
  return `Only the ${RESULT_LIMIT} highest-ranked ${unit} are shown and there may be more — the list does not go further, so narrower words are what reach them.`
}
