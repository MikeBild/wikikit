// What the webhooks page may claim about a delivery list.
//
// The page exists for one errand: "our webhooks stopped last Tuesday, why".
// The delivery read answers `ORDER BY created_at DESC LIMIT n` and has no
// cursor behind it, so on a busy endpoint the rows on screen may not reach back
// to Tuesday at all — raising `n` from the server's silent default of fifty to
// the two hundred the endpoint now accepts moves that horizon without removing
// it. A sentence that calls them "every attempt WikiKit has
// made" then sends the operator to their own firewall for the evening — the
// exact failure the circuit-breaker status on this page was written to prevent,
// arriving through the paragraph instead.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DELIVERY_CAP_NOTE, DELIVERY_CEILING, deliverySubject } from '../../../apps/cockpit/src/pages/webhooks.logic.ts'
import { ROUTES } from '../../../src/http/routes.ts'
import { zDeliveryListQuery } from '../../../src/http/schemas.ts'

const URL = 'https://example.com/hooks/wikikit'

describe('the sentence above the delivery list', () => {
  test('claims completeness only while the read came back short of its ceiling', () => {
    expect(deliverySubject(URL, 0)).toContain('Every attempt')
    expect(deliverySubject(URL, DELIVERY_CEILING - 1)).toContain('Every attempt')
  })

  test('stops claiming completeness the moment the read comes back full', () => {
    const full = deliverySubject(URL, DELIVERY_CEILING)
    expect(full).not.toContain('Every attempt')
    expect(full).toContain(String(DELIVERY_CEILING))
    // The endpoint is still named: the two lists on this page answer different
    // questions, and a caveat that lost the URL would be a caveat about
    // nothing in particular.
    expect(full).toContain(URL)
  })

  test('claims nothing at all before the read has answered', () => {
    // A pending read and a read that answered nothing are the same empty array
    // on screen. Describing the first as "every attempt WikiKit has made" puts
    // a claim about a list over a skeleton — and over a failure row, where the
    // console knows least of all.
    const waiting = deliverySubject(URL, null)
    expect(waiting).not.toContain('Every attempt')
    expect(waiting).toContain(URL)
  })

  test('keeps the retrying/given-up distinction in every branch', () => {
    // "failed" is one attempt that will be tried again and "dead" is the one
    // that never will. Dropping that clause from the truncated branch would fix
    // one misreading by introducing the other.
    for (const loaded of [null, 0, DELIVERY_CEILING]) {
      expect(deliverySubject(URL, loaded)).toContain('given up on will never be sent again')
    }
  })
})

describe('the ceiling is the server’s, not a number this page chose', () => {
  const route = ROUTES.find(
    (entry) => entry.method === 'get' && entry.path === '/v1/spaces/{space}/webhooks/{id}/deliveries',
  )

  test('the route this page reads still exists', () => {
    // Guards the assertions below: a `find` that stopped matching would make
    // them vacuously true.
    expect(route).toBeDefined()
  })

  test('the route declares a query schema, so the limit reaches the server at all', () => {
    // This assertion used to be `expect(route?.request?.query).toBeUndefined()`
    // — written to go red the day the endpoint grew a `limit`, because until it
    // did, a console sending `?limit=200` would have been sending a parameter
    // the router drops (it validates, and therefore forwards, only a declared
    // query string) and then telling the operator it had asked for two hundred
    // rows while showing fifty. The day has come; the guard now points the
    // other way.
    expect(route?.request?.query).toBe('zDeliveryListQuery')
  })

  test('the ceiling is exactly what the schema will accept, not a number chosen here', () => {
    // The schema is the contract. If the endpoint's maximum ever rises, the
    // second line fails and the console is told to come and take the rest; if
    // this constant is raised past the maximum on its own, the first fails
    // before a 400 ever reaches an operator.
    expect(zDeliveryListQuery.parse({ limit: DELIVERY_CEILING }).limit).toBe(DELIVERY_CEILING)
    expect(() => zDeliveryListQuery.parse({ limit: DELIVERY_CEILING + 1 })).toThrow()
  })

  test('it asks for more than the fifty a limit-less request would return', () => {
    // `listWebhookDeliveries` calls clampLimit(args.limit, 50, 200): naming no
    // limit is not "everything", it is fifty, silently — which is the exact
    // shape of the failure this page was written to prevent.
    expect(DELIVERY_CEILING).toBeGreaterThan(50)
  })

  test('the page sends the ceiling instead of taking the default', () => {
    // The one thing a pure-logic test cannot reach: `DELIVERY_CEILING` being
    // right is worth nothing if the read never names it. The page itself is not
    // importable here — it is a React component, and this runner compiles with
    // no DOM — so the request is read out of the source, comment lines dropped
    // because the comments around this call site discuss the very limit they
    // would otherwise satisfy this assertion with.
    const source = readFileSync(join(import.meta.dir, '../../../apps/cockpit/src/pages/webhooks.tsx'), 'utf8')
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join('\n')
    expect(code).toContain('wk.webhooks.deliveries(space, selected!.id, { limit: DELIVERY_CEILING })')
  })
})

describe('the caveat under the table', () => {
  test('names the ceiling and says the rest is out of reach', () => {
    expect(DELIVERY_CAP_NOTE).toContain(String(DELIVERY_CEILING))
    expect(DELIVERY_CAP_NOTE).toContain('not reachable')
  })
})
