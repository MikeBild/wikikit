/**
 * The rules the webhooks surface runs on, with no DOM under them.
 *
 * Import-free for the same reason `sources.logic.ts` is: `test/unit/` compiles
 * against the ROOT tsconfig, which declares no `@/*` path mapping, so a logic
 * module that reaches for an alias is a logic module no unit test can load.
 */

/**
 * How many delivery attempts one read can hold — fifty, and NOT the two hundred
 * `listWebhookDeliveries` is willing to clamp to.
 *
 * The domain function takes a `limit` and clamps it to [1, 200] with a default
 * of 50, so 200 looks available from `src/webhooks.ts`. It is not, because the
 * HTTP surface in front of it never offers the parameter: the route entry for
 * `GET /v1/spaces/{space}/webhooks/{id}/deliveries` declares
 * `request: { params: 'zSpaceIdParams' }` and no query schema, and
 * `listWebhookDeliveriesHandler` calls the domain with `{ endpointId }` alone.
 * The server only validates a query string it has declared, so an undeclared
 * one is dropped rather than refused.
 *
 * The rejected alternative was to send `?limit=200` anyway and pass 200 as the
 * ceiling. It would have made the page lie twice — once about how many attempts
 * exist, and once about having asked for them — while the response stayed
 * exactly fifty rows long. Fifty is the honest number until the endpoint grows
 * a `limit`, and `test/unit/cockpit-pages/webhooks.test.ts` fails on the day it
 * does, so this constant cannot quietly stay behind the server.
 */
export const DELIVERY_CEILING = 50

/**
 * The caveat under a delivery list that came back full.
 *
 * Asserts more attempts EXIST rather than "may exist": the read is `ORDER BY
 * created_at DESC LIMIT 50` with no cursor after it, so a full answer is a
 * truncation by construction — a wiki cannot have exactly fifty attempts
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
 * busy endpoint is handed the fifty newest attempts, which on a busy endpoint
 * reach back as far as this morning; the sentence then tells them Tuesday never
 * happened. So the claim is derived from how many attempts actually arrived
 * rather than written into the page as a constant.
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
