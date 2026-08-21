// The convention check's identity reader, held against documents rather than
// against its own source text.
//
// WHY THIS FILE EXISTS
//
// scripts/konvention-check.mjs measures against a target it starts itself — and
// until LOCAL-WI-KENNUNG-NICHT-GEPRUEFT it only answered "does something answer
// there?", not "does WIKIKIT answer there?". At CodeKit the difference happened:
// WorkKit held CodeKit's check port, and the run produced eight violations under
// CodeKit's name in 156s over a surface that was never CodeKit. No timeout, no
// crash — a complete, convincing, wrong report. A timeout gets investigated;
// eight violations get repaired.
//
// The family is built for this without wanting to be: the convention makes the
// DOM anchors of all six consoles deliberately identical, so every line of the
// check script finds something in every sibling console, and the check ports sit
// close together (CodeKit 4081 · WikiKit 4173 · SubKit 4176 · WatchKit 4183 ·
// WorkKit 4192).
//
// WHY IT NO LONGER READS THE SCRIPT'S SOURCE
//
// The first version of this file spelled the reader out: `expect(body).toContain
// ("const expected = markerIn(...)")` and eleven more of that kind. That is a
// transcript, not a hold. Measured on d407949, with all six tests green: the
// reader took the FIRST `<meta name="cockpit-product">` in the raw document, so
// an EXAMPLE marker inside the comment above the real one won — `markerIn(prose
// + example + real)` returned "OtherProduct" (LOCAL-WI-KENNUNG-BEISPIEL-GEWINNT).
// Dropping the `g` from this file's own comment stripper changed its md5 and
// left it 6 pass / 0 fail as well.
//
// So the reader now lives in scripts/kennung.ts and is IMPORTED here. The
// fixtures below are built from the real apps/cockpit/index.html, including the
// rejecting ones: a rejection fixture that is a minimal shell proves that the
// reader rejects minimal shells. That is where SubKit's version passed while its
// hole stood open.
//
// Pattern taken from WatchKit's test of the same name, COPIED and not imported
// (§7: no shared code between the products).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { IDENTITY_META, markerIn } from '../../scripts/kennung.ts'
import { forms, HEAD_ANCHOR, PRODUCT, shell, withExample, withoutMarker } from '../helpers/kennung-formen.ts'

const root = process.cwd()
const source = readFileSync(join(root, 'scripts', 'konvention-check.mjs'), 'utf8')

describe('the identity reader, measured against documents', () => {
  test('the real document names this product', () => {
    expect(markerIn(shell)).toBe(PRODUCT)
  })

  test('prose + example + real: the real marker wins', () => {
    const html = withExample(shell)
    expect(html, 'the example was planted').not.toBe(shell)
    expect(markerIn(html)).toBe(PRODUCT)
  })

  test('prose + example, no real marker: no identity', () => {
    const html = withExample(withoutMarker())
    expect(html.includes('OtherProduct'), 'the example was planted').toBe(true)
    expect(html.includes('WELCHES PRODUKT DIESE KONSOLE IST'), 'the real prose is still there').toBe(true)
    expect(markerIn(html)).toBeNull()
  })

  test('the real document without its marker: no identity', () => {
    expect(markerIn(withoutMarker())).toBeNull()
  })

  /*
    Every shape from test/helpers/kennung-formen.ts, held EXACTLY. Not "a name
    or null": the wrong answer in the dangerous half IS this product's name, so
    a set the answer may fall into cannot see it.

    That every `reads` is what a browser really reads is not asserted here — it
    is measured in test/integration/kennung-am-browser.test.ts, against a live
    Chromium over real HTTP, on the same table.
  */
  for (const { name, html, landed, reads } of forms) {
    test(`${name}: the reader answers ${JSON.stringify(reads)}`, () => {
      /*
        The fixture has to have landed WHERE IT CLAIMS — held against the
        planted construct, not against "the document differs from the real one".
        The weaker form hid a fixture that never posed its case: `.replace(
        'name=', 'NAME=')` without `g` hit `<meta NAME="viewport">`, the marker
        stayed lower case and inside the comment, and the document differed for
        two unrelated reasons (LOCAL-WI-KENNUNG-FIXTURE-DANEBEN).
      */
      expect(html, `${name}: the construct stands in the document`).toContain(landed)
      expect(markerIn(html)).toBe(reads)
    })
  }

  test('two real markers are an ambiguity, not an identity', () => {
    const html = shell.replace(
      HEAD_ANCHOR,
      `<meta name="${IDENTITY_META}" content="OtherProduct" />\n    ${HEAD_ANCHOR}`,
    )
    expect(html, 'the second marker was planted').not.toBe(shell)
    expect(markerIn(html)).toBeNull()
  })
})

/*
  What remains of the source reading: the WIRING and the ORDERING. Both are
  properties of the script and not of the reader, so there is nothing to import
  and nothing to run against a fixture — but each is a single, narrow question,
  not a transcript of the file.
*/
const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('the check uses that reader, and uses it early', () => {
  test('the script imports the reader instead of keeping a second one', () => {
    expect(code).toContain("import { IDENTITY_META, markerIn } from './kennung.ts'")
    expect(code, 'no second definition').not.toContain('function markerIn(')
    expect(code, 'no second definition').not.toContain('const IDENTITY_META =')
  })

  test('apps/cockpit/index.html is the single place of definition', () => {
    const matches = [...shell.matchAll(new RegExp(`<meta[^>]+name="${IDENTITY_META}"[^>]+content="([^"]+)"`, 'g'))]
    expect(matches.length, `exactly one <meta name="${IDENTITY_META}"> in the source`).toBe(1)
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    expect(matches[0]![1]).toBe(PRODUCT)
    // A marker that can drift away from its own name would be worse than none.
    expect(PRODUCT.toLowerCase()).toBe(pkg.name.toLowerCase())
  })

  test('the expected value is derived, and typed out nowhere', () => {
    const start = code.indexOf('function assertTargetIdentity(html, location)')
    expect(start, 'the assert is findable').toBeGreaterThan(0)
    const body = code.slice(start, code.indexOf('\n}\n', start))

    expect(code).toContain("const COCKPIT_SOURCE_HTML = 'apps/cockpit/index.html'")
    expect(body).toContain("const expected = markerIn(readFileSync(sourceUrl, 'utf8'))")

    /*
      Typed out nowhere, and the BODY is read rather than the whole file:
      "WikiKit" legitimately stands elsewhere as PRODUCT_NAME because §6 checks
      the spelling in prose — which is exactly why the identity must not USE that
      constant. An identity that is also under test turns every real §6 violation
      into "that is not WikiKit at all" and measures nothing afterwards. For the
      same reason, not the <title> either.
    */
    expect(body.includes(`'${PRODUCT}'`) || body.includes(`"${PRODUCT}"`), 'no literal of the marker').toBe(false)
    expect(body).not.toContain('PRODUCT_NAME')
    expect(body).not.toContain('<title>WikiKit')

    // A foreign console is NAMED, not merely rejected.
    expect(body).toContain('Its title reads')
    expect(body).toContain('this is not ${expected} but ${delivered}')
    expect(body).toContain('finding about THIS repository and no statement about the target')
  })

  test('the check runs before the browser starts', () => {
    // A browser already running has a foreign surface in front of it on which
    // every selector of this script finds something. The ordering IS the
    // assurance.
    const identity = code.indexOf('assertTargetIdentity(shellHtml, location)')
    const browser = code.indexOf('await chromium.launch()')
    expect(identity, 'the assert is called').toBeGreaterThan(0)
    expect(browser, 'the browser starts').toBeGreaterThan(0)
    expect(identity, 'the identity is checked before the browser starts').toBeLessThan(browser)

    // The same fetch carries the target classification. A second fetch would be a
    // second place with its own deadline for nothing.
    expect(code).toContain('target = classifyTarget(marksIn(shellHtml))')
    expect(code).not.toContain('classifyTarget(shell.delivered)')
  })

  test('a foreign target ends with "not measured" rather than with a report', () => {
    // 0 is "measured and green", 1 is "measured and red", 2 is "not measured". A
    // foreign cockpit is not a convention violation but a run that did not
    // happen — the difference is the whole lesson from CodeKit's eight
    // violations.
    expect(code).toContain('throw new Error(')
    expect(code).toContain('await main().catch((error) => {')
    expect(code).toContain('not measured')
    expect(code).toContain('process.exit(2)')
  })

  test('there is exactly one node-side fetch, and it carries a deadline', () => {
    /*
      A deadline is a property of the CALL SITE. Every further site is one that
      can be forgotten — and as a gate stage a hanging run is the worst of the
      three exits, because somebody aborts it and calls it flaky. The second
      `fetch` in the file runs IN THE BROWSER (in checkFavicon()'s body,
      serialised into page.evaluate) and hangs on playwright's frame lifetime,
      not on node's.
    */
    const browserSide = code.indexOf("fetch(href, { cache: 'no-store' })")
    expect(browserSide, 'the in-page favicon fetch is findable').toBeGreaterThan(0)

    const sites = [...code.matchAll(/\bfetch\s*\(/g)].map((match) => match.index!)
    const nodeSide = sites.filter((at) => at !== browserSide)
    expect(nodeSide.length, `node-side fetch calls: ${nodeSide.length}, expected 1`).toBe(1)

    const start = code.indexOf('async function getWithin(url, timeoutMs)')
    const getWithin = code.slice(start, code.indexOf('\n}\n', start))
    expect(getWithin).toContain('await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })')
    // The body is read UNDER the same signal: "the headers arrived" is not "the
    // server answers", and the gap between the two is the second hang.
    expect(getWithin).toContain('return { ok: response.ok, body: await response.text() }')
    expect(nodeSide[0]).toBeGreaterThan(start)
    expect(nodeSide[0]).toBeLessThan(start + getWithin.length)
  })
})
