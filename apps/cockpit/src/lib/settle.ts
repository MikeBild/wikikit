import type { QueryClient, QueryKey } from '@tanstack/react-query'

/**
 * Re-read what the mutation may have changed — whether or not it succeeded.
 *
 * The rule this exists to make unforgettable: **a mutation invalidates on
 * SETTLE, not on success.** Every mutation in this console invalidated in
 * `onSuccess`, which reads as caution and is the opposite. A refusal is
 * evidence about the server's state, and usually the sharpest evidence there
 * is: `proposal_not_pending` is a 409 that says the row on screen is stale —
 * somebody reviewed it from an agent, or in a chat channel, or in another tab —
 * and the queue kept showing it as Pending with a working Approve button beside
 * it. The operator's next click is then a decision on a decision, and the only
 * thing that stops it is a second refusal.
 *
 * The same holds for the failures that are not conflicts. A rejection that
 * timed out may have rejected; a key mint that 500s after the row was written
 * leaves an API key the list does not show. The cache cannot know, and that is
 * precisely why it must ask rather than keep what it has.
 *
 * What does NOT move to settle: the toast, the navigation, the dialog close and
 * the form reset. Those are consequences of the outcome and belong with the
 * outcome — `onSuccess` for what a success earns, `onError` for what a failure
 * owes. This is only the re-read.
 *
 * Keys are passed as a list because a mutation almost always touches more than
 * one read, and one call site listing them together is easier to check against
 * the route than four scattered `void`s.
 */
export function invalidateAll(client: QueryClient, keys: readonly QueryKey[]): void {
  for (const key of keys) void client.invalidateQueries({ queryKey: key })
}
