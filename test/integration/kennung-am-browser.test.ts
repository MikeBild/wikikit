// The identity reader held against the thing it has to agree with: a real
// browser, over real HTTP.
//
// WHY THIS IS NOT A UNIT TEST
//
// Every `reads` in test/helpers/kennung-formen.ts is a claim about what Chromium
// makes of that document. Written down by hand it is a transcription, and a
// transcription keeps looking valid after the fixture beside it has moved —
// which is how the "UPPERCASE attributes" case stood green for a round without
// ever being posed (LOCAL-WI-KENNUNG-FIXTURE-DANEBEN).
//
// `page.setContent()` would not do either: it feeds the parser a string instead
// of a response, and the two dangerous forms of this class are only visible on
// the real path.
//
// WHAT IS HELD
//
// A name may only come back when the parser reads EXACTLY that one marker.
// `null` is always allowed — the caller turns it into "not measured" (exit 2),
// never into a name. What must never happen is a name where the browser sees
// something else, because that run is believed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chromium, type Browser } from 'playwright'

import { IDENTITY_META, markerIn } from '../../scripts/kennung.ts'
import { forms } from '../helpers/kennung-formen.ts'

const documents = new Map(forms.map((form) => [form.name, form.html]))

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const body = documents.get(decodeURIComponent(new URL(request.url).pathname.slice(1)))
    return body === undefined
      ? new Response('not a fixture', { status: 404 })
      : new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  },
})

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
  server.stop(true)
})

/** `document` is not in this project's lib; the page has it, node does not. */
type Page = { querySelectorAll: (selector: string) => Iterable<{ getAttribute: (name: string) => string | null }> }

describe('the identity reader agrees with the browser', () => {
  /*
    THE COUNT IS PART OF THE SUITE. This table IS the tree both holders walk, so
    a form deleted from it is a question that stops being asked — and a suite
    that finds fewer violations than yesterday is green either way. Measured:
    one form removed left this file at 28/0 and the browser suite at 17/0, both
    silently green (BEFUND-SONDE-SIEHT-IHRE-VERENGUNG-NICHT).

    Three numbers, because the total alone can stand still while the corpus
    narrows. A form is WEAKENED, not removed, by posing it alone instead of
    beside the real marker — and alone every one of these spellings is
    fail-safe and asks nothing. And a duplicated name would let one form shadow
    another with the total intact.
  */
  test('every form in the table is posed here: 26, 9 of them beside the real marker', () => {
    expect(forms.length, 'a form was added or removed — change this number deliberately').toBe(26)
    expect(
      forms.filter((form) => form.browser.length > 1).length,
      'a form that posed a SECOND live marker no longer does',
    ).toBe(9)
    expect(new Set(forms.map((form) => form.name)).size, 'two forms share a name').toBe(forms.length)
  })

  for (const form of forms) {
    test(`${form.name}: the browser reads ${JSON.stringify(form.browser)}`, async () => {
      const page = await browser.newPage()
      try {
        const response = await page.goto(`http://127.0.0.1:${server.port}/${encodeURIComponent(form.name)}`)
        expect(response?.status(), 'the fixture was served').toBe(200)

        const parser = await page.evaluate((meta: string) => {
          const doc = (globalThis as unknown as { document: Page }).document
          return [...doc.querySelectorAll(`meta[name="${meta}"]`)].map((element) => element.getAttribute('content'))
        }, IDENTITY_META)

        // The recorded measurement is true — a stale entry cannot sit here
        // looking valid.
        expect(parser, 'what the browser really reads').toEqual(form.browser)
        expect(markerIn(form.html), 'what the reader answers').toBe(form.reads)

        /*
          THE PROPERTY. A name may come back only when the browser reads exactly
          that one marker. `null` is always allowed — the caller turns it into
          "not measured" (exit 2), never into a name. A name where the browser
          sees something else is the run that gets believed.
        */
        const agrees = form.reads === null || (form.browser.length === 1 && form.browser[0] === form.reads)
        if (form.known === undefined) {
          expect(agrees, `reads ${JSON.stringify(form.reads)}, browser ${JSON.stringify(form.browser)}`).toBe(true)
        } else {
          // And a known hole has to STAY a hole while it is marked as one, so
          // the marker cannot outlive the finding.
          expect(agrees, `${form.known} is closed — take the marker off this form`).toBe(false)
        }
      } finally {
        await page.close()
      }
    })
  }
})
