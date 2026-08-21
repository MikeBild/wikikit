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
import { PRODUCT, forms, fuzzForms } from '../helpers/kennung-formen.ts'
import { characterEntities } from 'character-entities'
import { characterEntitiesLegacy } from 'character-entities-legacy'

const generated = fuzzForms()

/*
  ONE further document, which poses the parser's ENTIRE named-reference table —
  so the bound stated in scripts/kennung.ts is a sentence that can go red rather
  than a sentence that was once true.

  Both tables are pinned EXACTLY in package.json, without a caret: here the
  dependency is not a tool but the oracle itself, and a silent bump would move
  the measurement this test reports.
*/
const NAMES = Object.keys(characterEntities)
/** With its `;`, then the legacy subset without one — the parser accepts both. */
const REFERENCES = [...NAMES.map((name) => `&${name};`), ...characterEntitiesLegacy.map((name) => `&${name}`)]
const REFERENCE_PROBE = "the parser's whole named-reference table"
const documents = new Map<string, string>([
  ...[...forms, ...generated].map((form) => [form.name, form.html] as [string, string]),
  [
    REFERENCE_PROBE,
    // One attribute per reference. A separator inside one attribute would not
    // do: `&verbar;`, `&vert;` and `&VerticalLine;` all decode to `|`, and a
    // reference that decodes to the separator would silently split the list.
    `<!doctype html><html><head><title>t</title></head><body><div id="probe" ${REFERENCES.map(
      (reference, index) => `data-r${index}="${reference}"`,
    ).join(' ')}></div></body></html>`,
  ],
])

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

/*
  THE BOUND ON LOCAL-WI-KENNUNG-NAMENSREFERENZ, measured against the parser
  itself rather than against a package's table.

  The reader decodes six named references and only with their `;`. That gap is
  harmless in an attribute VALUE (it answers a value the DOM does not carry, and
  the run ends at exit 2) and would be DANGEROUS in the attribute NAME, where an
  undecoded name leaves a second live marker uncounted. The bound is that the
  dangerous half is unreachable: no named reference decodes to a character
  `cockpit-product` is made of, so no named reference can spell a marker.

  Nine samples proved that once. This poses all of them, in one page load.
*/
describe('no named reference can spell a marker', () => {
  test(`all ${REFERENCES.length} of the parser's named references stay out of '${IDENTITY_META}'`, async () => {
    const page = await browser.newPage()
    try {
      const response = await page.goto(`http://127.0.0.1:${server.port}/${encodeURIComponent(REFERENCE_PROBE)}`)
      expect(response?.status(), 'the reference probe was served').toBe(200)
      const decoded = await page.evaluate((count: number) => {
        const doc = (globalThis as unknown as { document: Page }).document
        const probe = [...doc.querySelectorAll('#probe')][0]!
        return Array.from({ length: count }, (_unused, index) => probe.getAttribute(`data-r${index}`))
      }, REFERENCES.length)

      // Every reference came back — a dropped attribute would make the bound
      // below true for the wrong reason.
      expect(decoded.filter((value) => value === null).length, 'a reference did not survive the round trip').toBe(0)

      const alphabet = new Set(IDENTITY_META)
      const reaching = decoded
        .map((value, index) => [REFERENCES[index]!, value!] as const)
        .filter(([, value]) => [...value].some((character) => alphabet.has(character)))
      expect(
        reaching,
        `a named reference now decodes into '${IDENTITY_META}' — the dangerous half is no longer empty`,
      ).toEqual([])

      // And the near misses are near, which is why this is measured and not
      // assumed: `&hyphen;` is U+2010, not the U+002D in the marker's name.
      expect(decoded[REFERENCES.indexOf('&hyphen;')], '&hyphen; is not a hyphen-minus').toBe('\u2010')
    } finally {
      await page.close()
    }
  }, 60_000)
})

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

  MEASURED, on this corpus of 216 forms: the reader of 73d671e replayed against
  it disagrees 33 times — 16 over the first five axes, among them both blockers
  of that round (the tag slash eaten by an unquoted value, the two
  `fuzz/tokens/bare/slash` forms; and the numeric reference without its
  semicolon in the attribute NAME, which leaves a second live marker uncounted,
  `fuzz/name/cockpit&#45product` and `&#x2dproduct` beside the real one in all
  three quotings), and 17 over the sixth. The reader in this tree fixed the
  first sixteen and none of the seventeen, which is exactly the list below.

  HOW LONG IT TAKES, AND THE RULE THAT PRODUCES IT: one page load on a fresh tab
  per form, so the wall clock tracks the FORM COUNT and nothing else — about
  45 ms a form here. Measured on this machine (Darwin, 8 cores): 7.6 s at 174
  forms, 9.8 s and 11.2 s at 216. That rule is why the "1.3 s" that stood here
  was wrong at any corpus size, not just at this one. A disagreeing reader costs
  the same time, not more. The 120 s timeout is sized off the rule — it holds
  until the corpus is roughly twelve times this one — and not off a stopwatch.

  WHAT IS FOUND IS REPORTED, NOT PINNED. There is no recorded `browser` and no
  recorded `reads` here; the generated forms are held against the property
  alone. A disagreement must be named in KNOWN_HOLES with the finding it belongs
  to AND with the direction it points, and the assert is an EQUALITY over both,
  so a listed form that starts agreeing turns the suite red as well. A hole
  cannot be widened quietly and a marker cannot outlive its finding.
*/

/**
 * Which way a disagreement points, computed rather than described — the
 * sentence "both are in the safe direction" is exactly the kind of prose that
 * was wrong five times in one day (BEFUND-PROSA-NEBEN-CODE).
 *
 * `dangerous` is one single condition: the reader answered THIS product's own
 * name. Then the caller's assert compares it against this repository's marker,
 * finds them equal, and the run measures on under a name the document does not
 * carry. Anything else — `null`, or a foreign name — ends the run at exit 2,
 * which is loud and repairable.
 */
const directionOf = (reads: string | null): 'safe' | 'dangerous' => (reads === PRODUCT ? 'dangerous' : 'safe')

const KNOWN_HOLES: Record<string, { finding: string; direction: 'safe' | 'dangerous' }> = {
  // The reader decodes six named references and only with their `;`. The
  // parser's table is far larger and accepts a legacy subset without one. Both
  // are stated as the limit in scripts/kennung.ts, and the dangerous half of
  // that limit is MEASURED EMPTY there.
  'fuzz/value/Other&copy;Product/alone': { finding: 'LOCAL-WI-KENNUNG-NAMENSREFERENZ', direction: 'safe' },
  'fuzz/value/Other&amp Product/alone': { finding: 'LOCAL-WI-KENNUNG-NAMENSREFERENZ', direction: 'safe' },

  /*
    THE SIXTH AXIS, comment syntax inside the tag — LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT.

    SIX OF THESE ARE MARKED `dangerous` AND ARE KNOWINGLY GREEN. That is the
    uncomfortable half and it is stated rather than smoothed: the reader answers
    `WikiKit` for a document whose only marker says `Wiki<!--Other-->Kit`, the
    caller's assert compares the two names, finds them equal, and the run is
    believed. What this round did was make the shape VISIBLE and held — the hole
    itself belongs to the root that withoutComments() has, deciding what a
    comment is from the raw bytes without knowing where the parser would see
    one, and that root stays open on instruction together with
    LOCAL-WI-KENNUNG-ROHTEXT and LOCAL-WI-KENNUNG-SKRIPTVORLAGE. Closing it
    means parsing the document, not widening a pattern.

    Note what is NOT here: every `beside` form of this axis AGREES, because
    beside the real marker the reader counts two and answers `null`. Posed
    beside only, the axis would have looked closed — which is the mirror image
    of LOCAL-WI-KENNUNG-ZWEITER-MARKER-UNSICHTBAR, where posing alone hid it.
    Both halves, always, is not a slogan here; it is why this list is not empty.
  */
  'fuzz/in-tag/own-name-split/double/alone': { finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT', direction: 'dangerous' },
  'fuzz/in-tag/own-name-split/single/alone': { finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT', direction: 'dangerous' },
  'fuzz/in-tag/own-name-split/bare/alone': { finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT', direction: 'dangerous' },
  'fuzz/in-tag/own-name-split-bang/double/alone': {
    finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT',
    direction: 'dangerous',
  },
  'fuzz/in-tag/own-name-split-bang/single/alone': {
    finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT',
    direction: 'dangerous',
  },
  'fuzz/in-tag/own-name-split-bang/bare/alone': {
    finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT',
    direction: 'dangerous',
  },

  /*
    The same root, pointing the safe way: the reader answers a foreign name or a
    torn one, the assert sees a mismatch and the run ends at exit 2. They are
    listed because they are the same hole seen from the other side — if the root
    is fixed these have to stop disagreeing too, and the equality below says so.
  */
  'fuzz/in-tag/unclosed-in-value/double/alone': { finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT', direction: 'safe' },
  'fuzz/in-tag/unclosed-in-value/bare/alone': { finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT', direction: 'safe' },
  'fuzz/in-tag/whole-comment-in-value/double/alone': {
    finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT',
    direction: 'safe',
  },
  'fuzz/in-tag/whole-comment-in-value/single/alone': {
    finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT',
    direction: 'safe',
  },
  'fuzz/in-tag/whole-comment-in-value/bare/alone': { finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT', direction: 'safe' },
  'fuzz/in-tag/empty-comment-in-value/double/alone': {
    finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT',
    direction: 'safe',
  },
  'fuzz/in-tag/empty-comment-in-value/single/alone': {
    finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT',
    direction: 'safe',
  },
  'fuzz/in-tag/empty-comment-in-value/bare/alone': { finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT', direction: 'safe' },
  // Stripping INVENTS the identity name here: the parser reads
  // `cockpit-<!--x-->product`, which is not the marker at all, and the reader
  // reads one that was never in the document.
  'fuzz/in-tag/comment-in-name/double/alone': { finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT', direction: 'safe' },
  'fuzz/in-tag/comment-in-name/single/alone': { finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT', direction: 'safe' },
  'fuzz/in-tag/comment-in-name/bare/alone': { finding: 'LOCAL-WI-KENNUNG-KOMMENTAR-IM-WERT', direction: 'safe' },
}

describe('the generated corpus agrees with the browser', () => {
  /*
    The generator IS the tree this suite walks, exactly as the table is for the
    one above, and it narrows the same silent way: an axis dropped from a cross
    is a question that stops being asked while everything stays green
    (BEFUND-SONDE-SIEHT-IHRE-VERENGUNG-NICHT).
  */
  test('the generator still produces every form it did: 216, all distinct', () => {
    expect(generated.length, 'an axis was added or dropped — change this number deliberately').toBe(216)
    expect(new Set(generated.map((form) => form.name)).size, 'two generated forms share a name').toBe(216)
  })

  test('no disagreement the register does not already name, pointing the way it says', async () => {
    const found: string[] = []
    const detail: string[] = []
    for (const form of generated) {
      const parser = await parserReads(form.name)
      const reads = markerIn(form.html)
      if (agreesWith(parser, reads)) continue
      // The direction travels WITH the name, so a hole that turns from
      // fail-safe into "answers our own name" cannot stay green under an entry
      // that describes it as harmless.
      found.push(`${form.name} [${directionOf(reads)}]`)
      detail.push(
        `${form.name} [${directionOf(reads)}]\n    browser ${JSON.stringify(parser)}, reader ${JSON.stringify(reads)}`,
      )
    }

    // Equality in both directions: an unnamed disagreement is a new finding,
    // and a named one that has closed is a marker to take off.
    expect(found.sort(), `\n${detail.join('\n  ') || '(none)'}\n`).toEqual(
      Object.entries(KNOWN_HOLES)
        .map(([name, hole]) => `${name} [${hole.direction}]`)
        .sort(),
    )
  }, 120_000)
})
