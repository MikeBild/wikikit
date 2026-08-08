// What the webhooks page may claim about a delivery list.
//
// The page exists for one errand: "our webhooks stopped last Tuesday, why".
// The delivery read answers `ORDER BY created_at DESC LIMIT 50` and has no
// cursor behind it, so on a busy endpoint the rows on screen may not reach back
// to Tuesday at all. A sentence that calls them "every attempt WikiKit has
// made" then sends the operator to their own firewall for the evening — the
// exact failure the circuit-breaker status on this page was written to prevent,
// arriving through the paragraph instead.
import { describe, expect, test } from 'bun:test'
import { DELIVERY_CAP_NOTE, DELIVERY_CEILING, deliverySubject } from '../../../apps/cockpit/src/pages/webhooks.logic.ts'
import { ROUTES } from '../../../src/http/routes.ts'

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
    // Guards the two assertions below: a `find` that stopped matching would
    // make them vacuously true.
    expect(route).toBeDefined()
  })

  test('50 is the ceiling because the route offers no way to ask for more', () => {
    // `listWebhookDeliveries` clamps `limit` to [1, 200] with a default of 50,
    // so 200 looks reachable from the domain layer. It is not: this route
    // declares no query schema, the server validates (and therefore keeps) only
    // a declared query string, and the handler passes `{ endpointId }` alone.
    // The day somebody adds `zDeliveryListQuery` here, this test fails and the
    // console is told to go and ask for the bigger number.
    expect(route?.request?.query).toBeUndefined()
    expect(DELIVERY_CEILING).toBe(50)
  })
})

describe('the caveat under the table', () => {
  test('names the ceiling and says the rest is out of reach', () => {
    expect(DELIVERY_CAP_NOTE).toContain(String(DELIVERY_CEILING))
    expect(DELIVERY_CAP_NOTE).toContain('not reachable')
  })
})
