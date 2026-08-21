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
//
// WHAT HAS TO BE COPIED WITH IT
//
// This file alone is worth nothing. The property it holds allows `null` always,
// so a reader that answers `null` to everything passes it — the exact value is
// carried by the pinned `reads` in the table, and the table is held by the unit
// suite. Four things travel together, and a sibling product that takes three of
// them has a suite that measures less than it looks like it does:
//
//   test/helpers/kennung-formen.ts               the table AND the generator
//   test/unit/konvention-check-kennung.test.ts   holds `reads` exactly
//   this file                                    justifies every `reads`, and
//                                                runs the generator
//   .github/workflows/ci.yml                     installs the browser, or none
//                                                of the above ever runs
//
// The last one is not a footnote: it was forgotten here, and
// test/unit/ci-workflows.test.ts now derives it so the next copy cannot.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chromium, type Browser } from 'playwright'

import { IDENTITY_META, markerIn } from '../../scripts/kennung.ts'
import { forms, fuzzForms } from '../helpers/kennung-formen.ts'

const generated = fuzzForms()
const documents = new Map([...forms, ...generated].map((form) => [form.name, form.html]))

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

/** Every `content` the PARSER ends up with for that document, in order. */
async function parserReads(name: string): Promise<(string | null)[]> {
  const page = await browser.newPage()
  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/${encodeURIComponent(name)}`)
    expect(response?.status(), `the fixture '${name}' was served`).toBe(200)
    return await page.evaluate((meta: string) => {
      const doc = (globalThis as unknown as { document: Page }).document
      return [...doc.querySelectorAll(`meta[name="${meta}"]`)].map((element) => element.getAttribute('content'))
    }, IDENTITY_META)
  } finally {
    await page.close()
  }
}

/**
 * THE PROPERTY, in one place because both suites hold the same one: a name may
 * come back only when the browser reads exactly that one marker. `null` is
 * always allowed — the caller turns it into "not measured" (exit 2), never into
 * a name. A name where the browser sees something else is the run that gets
 * believed.
 */
const agreesWith = (parser: (string | null)[], reads: string | null) =>
  reads === null || (parser.length === 1 && parser[0] === reads)

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
      const parser = await parserReads(form.name)

      // The recorded measurement is true — a stale entry cannot sit here
      // looking valid.
      expect(parser, 'what the browser really reads').toEqual(form.browser)
      expect(markerIn(form.html), 'what the reader answers').toBe(form.reads)

      const agrees = agreesWith(form.browser, form.reads)
      if (form.known === undefined) {
        expect(agrees, `reads ${JSON.stringify(form.reads)}, browser ${JSON.stringify(form.browser)}`).toBe(true)
      } else {
        // And a known hole has to STAY a hole while it is marked as one, so the
        // marker cannot outlive the finding.
        expect(agrees, `${form.known} is closed — take the marker off this form`).toBe(false)
      }
    })
  }
})

/*
  THE GENERATOR, against the same live Chromium.

  The suite above poses 26 shapes somebody thought of. That is the weakness the
  verifier found by thinking of 15 more and hitting a live regression with them
  in half a minute — so the corpus is now generated rather than only written,
  and the reader is certified to the parser's width instead of the author's.

  MEASURED, on this corpus of 174 forms: against the reader of 73d671e it
  reports 16 disagreements, among them both blockers of this round — the tag
  slash eaten by an unquoted value (the two `fuzz/tokens/bare/slash` forms) and
  the numeric reference without its semicolon in the attribute NAME, which
  leaves a second live marker uncounted (`fuzz/name/cockpit&#45product` beside
  the real one, in all three quotings). Against the
  reader in this tree it reports the two below and nothing else. 1.3 s.

  WHAT IS FOUND IS REPORTED, NOT PINNED. There is no recorded `browser` and no
  recorded `reads` here; the generated forms are held against the property
  alone. A disagreement must be named in KNOWN_HOLES with the finding it belongs
  to, and the assert is an EQUALITY, so a listed form that starts agreeing turns
  the suite red as well. A hole cannot be widened quietly and a marker cannot
  outlive its finding.
*/
const KNOWN_HOLES: Record<string, string> = {
  // The reader decodes six named references and only with their `;`. The
  // parser's table is far larger and accepts a legacy subset without one. Both
  // are in the SAFE direction — the reader answers a value the DOM does not
  // carry, the assert sees a mismatch and the run ends at exit 2 — and both are
  // stated as the limit in scripts/kennung.ts.
  'fuzz/value/Other&copy;Product/alone': 'LOCAL-WI-KENNUNG-NAMENSREFERENZ',
  'fuzz/value/Other&amp Product/alone': 'LOCAL-WI-KENNUNG-NAMENSREFERENZ',
}

describe('the generated corpus agrees with the browser', () => {
  /*
    The generator IS the tree this suite walks, exactly as the table is for the
    one above, and it narrows the same silent way: an axis dropped from a cross
    is a question that stops being asked while everything stays green
    (BEFUND-SONDE-SIEHT-IHRE-VERENGUNG-NICHT).
  */
  test('the generator still produces every form it did: 174, all distinct', () => {
    expect(generated.length, 'an axis was added or dropped — change this number deliberately').toBe(174)
    expect(new Set(generated.map((form) => form.name)).size, 'two generated forms share a name').toBe(174)
  })

  test('no disagreement the register does not already name', async () => {
    const disagreed: string[] = []
    for (const form of generated) {
      const parser = await parserReads(form.name)
      const reads = markerIn(form.html)
      if (agreesWith(parser, reads)) continue
      disagreed.push(`${form.name}\n    browser ${JSON.stringify(parser)}, reader ${JSON.stringify(reads)}`)
    }

    // Equality in both directions: an unnamed disagreement is a new finding,
    // and a named one that has closed is a marker to take off.
    expect(disagreed.map((line) => line.split('\n')[0]!).sort(), `\n${disagreed.join('\n  ') || '(none)'}\n`).toEqual(
      Object.keys(KNOWN_HOLES).sort(),
    )
  }, 120_000)
})
