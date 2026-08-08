/**
 * The rules the webhooks surface runs on, with no DOM under them.
 *
 * Import-free for the same reason `sources.logic.ts` is: `test/unit/` compiles
 * against the ROOT tsconfig, which declares no `@/*` path mapping, so a logic
 * module that reaches for an alias is a logic module no unit test can load.
 */

/**
 * How many delivery attempts one read can hold — the endpoint's own maximum,
 * asked for out loud.
 *
 * This used to be fifty, and the comment here used to explain why: the domain
 * function clamped to [1, 200] but `GET /v1/spaces/{space}/webhooks/{id}/deliveries`
 * declared no query schema, and the server only forwards a query string a route
 * has declared — so 200 was visible from `src/webhooks.ts` and unreachable from
 * anywhere a console could stand. The route now declares `zDeliveryListQuery`,
 * so the number the page sends and the number the server will honour are the
 * same number again.
 *
 * 200 is a bigger WINDOW, not pagination: the read is still
 * `ORDER BY created_at DESC LIMIT n` with no cursor behind it, so a full answer
 * is still a truncated one and `DELIVERY_CAP_NOTE` still has to say so. The
 * gain is that "our webhooks stopped last Tuesday" now reaches back four times
 * as far before the caveat is all the operator has.
 *
 * `test/unit/cockpit-pages/webhooks.test.ts` holds this number against
 * `zDeliveryListQuery` itself, so it cannot drift below what the endpoint
 * allows and cannot be raised past what the endpoint would refuse.
 */
export const DELIVERY_CEILING = 200

/**
 * The caveat under a delivery list that came back full.
 *
 * Asserts more attempts EXIST rather than "may exist": the read is `ORDER BY
 * created_at DESC LIMIT 200` with no cursor after it, so a full answer is a
 * truncation by construction — a wiki cannot have exactly two hundred attempts
 * against one endpoint and have the console be wrong about it in any way that
 * matters. The nuance would only soften the one sentence that has to land.
 */
export const DELIVERY_CAP_NOTE = `only the ${DELIVERY_CEILING} newest attempts are loaded — older ones are not reachable from here`

/**
 * What the paragraph above the delivery list is allowed to claim.
 *
 * "Every attempt WikiKit has made" is true right up to the moment the read
 * comes back full — and false in precisely the case this page exists for. An
 * operator who arrives with "our webhooks stopped last Tuesday" and meets a
 * busy endpoint is handed the `DELIVERY_CEILING` newest attempts, which on a
 * busy endpoint may still reach back only as far as this morning; the sentence
 * then tells them Tuesday never happened. Raising the ceiling from fifty to two
 * hundred moved that horizon without removing it, which is exactly why the
 * claim stays derived from how many attempts actually arrived rather than
 * written into the page as a constant.
 *
 * `null` is "no answer yet" and is NOT the same as zero. A count of nothing is
 * something the server said; an absent one is a read still in the air or one
 * that was refused, and neither can support a claim about what exists. Passing
 * `0` for both would put the completeness sentence over a skeleton and over a
 * failure row — a claim about a list nobody has been shown.
 */
export function deliverySubject(url: string, loaded: number | null): string {
  const tail = 'A retrying delivery is still scheduled; one it has given up on will never be sent again.'
  if (loaded === null) return `The most recent attempts against ${url}, newest first. ${tail}`
  return loaded >= DELIVERY_CEILING
    ? `The ${DELIVERY_CEILING} most recent attempts against ${url} — anything older than the oldest row below is not loaded, so an endpoint busy since then may hide the failure you are looking for. ${tail}`
    : `Every attempt WikiKit has made against ${url}. ${tail}`
}
