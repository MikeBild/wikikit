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

const root = process.cwd()
const source = readFileSync(join(root, 'scripts', 'konvention-check.mjs'), 'utf8')
const shell = readFileSync(join(root, 'apps', 'cockpit', 'index.html'), 'utf8')
/*
  The product's own spelling, taken from the marker itself rather than from
  package.json: the package is called "wikikit" and the marker says "WikiKit",
  and an identity is compared verbatim. That the two agree apart from case is a
  separate assertion further down.
*/
const PRODUCT = new RegExp(`<meta name="${IDENTITY_META}" content="([^"]+)"`).exec(shell)![1]!

/*
  The anchor for a marker planted OUTSIDE any comment. Not `<title>`: the real
  document mentions `<title>` in its prose ("Ausdrücklich NICHT der <title>"),
  30 lines up and inside the comment — measured, a fixture anchored there plants
  its marker into the comment and proves the opposite of what it claims.
*/
const HEAD_ANCHOR = '<title>WikiKit Cockpit</title>'

/*
  `<!-->` is an EMPTY comment, closed abruptly — not the start of one. The
  parser ends it at that `>`, so the marker behind it is LIVE. Measured at a
  live Chromium over HTTP this document reads ["OtherProduct", "WikiKit"]: two
  live markers, an ambiguity.

  The foreign marker has to be BEHIND the `<!-->` and ALIVE. The earlier fixture
  put `<!-->` in front of the already commented prose, where a reader that
  mistakes it for an opening swallows nothing that counts — and so posed
  nothing (LOCAL-WI-KENNUNG-LEERKOMMENTAR).
*/
const EMPTY_COMMENT_PLANT = `<!--><meta name="${IDENTITY_META}" content="OtherProduct" />`
const withEmptyComment = () => shell.replace('<head>', `<head>\n    ${EMPTY_COMMENT_PLANT}`)

/** The one line that carries the identity in the real document. */
const REAL = new RegExp(`^.*<meta name="${IDENTITY_META}" content="[^"]+" />.*$\\n`, 'm')

/** The real document with its marker line taken out — prose and all. */
const withoutMarker = () => {
  expect(REAL.test(shell), 'the real marker line is findable').toBe(true)
  return shell.replace(REAL, '')
}

/** An example marker, planted inside the real prose comment ABOVE the real one. */
const withExample = (html: string) =>
  html.replace(
    'Die Konvention macht die DOM-Verankerungen',
    `Zum Beispiel: <meta name="${IDENTITY_META}" content="OtherProduct" />\n      Die Konvention macht die DOM-Verankerungen`,
  )

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
    The shapes an HTML parser reads differently than a regex does. Every one of
    them is measured on the REAL document, and every one must end in `null` or in
    this product's name — never in a foreign name. `null` is the fail-safe
    answer: the caller turns it into "not measured" (exit 2), not into a name.
  */
  const forms: [string, string][] = [
    [
      'a "-->" string inside the comment',
      shell.replace('Die Konvention macht', 'Ein "-->" hier. Die Konvention macht'),
    ],
    ['an empty <!--> comment before a live foreign marker', withEmptyComment()],
    ['a nested <!-- inside the comment', shell.replace('Die Konvention macht', 'Ein <!-- hier. Die Konvention macht')],
    ['an example in UPPERCASE attributes', withExample(withoutMarker()).replace('name=', 'NAME=')],
    [
      'an example in single quotes',
      withoutMarker().replace(
        HEAD_ANCHOR,
        `<meta name='${IDENTITY_META}' content='OtherProduct' />\n    ${HEAD_ANCHOR}`,
      ),
    ],
    [
      'content before name',
      withoutMarker().replace(
        HEAD_ANCHOR,
        `<meta content="OtherProduct" name="${IDENTITY_META}" />\n    ${HEAD_ANCHOR}`,
      ),
    ],
    [
      'a comment closed with --!>',
      shell.replace('<head>', `<head>\n    <!-- <meta name="${IDENTITY_META}" content="OtherProduct" /> --!>`),
    ],
    [
      'an unclosed comment before the real marker',
      shell.replace('<meta name="cockpit-product"', '<!-- unclosed\n    <meta name="cockpit-product"'),
    ],
  ]

  for (const [name, html] of forms) {
    test(`${name} never yields a foreign name`, () => {
      // The fixture has to have LANDED. A `.replace()` whose anchor moved leaves
      // the document untouched and the case passes without ever being posed.
      expect(html, `${name}: the fixture differs from the real document`).not.toBe(shell)
      const read = markerIn(html)
      expect([PRODUCT, null], `${name} read as "${read}"`).toContain(read)
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

  /*
    Same promise, and the form in which the reader broke it: an empty `<!-->`
    hides the second marker from a stripper that mistakes it for an opening.
    Then the run measures on under THIS product's name against a document whose
    first marker names another — the shape that cost CodeKit 156 s.

    `[PRODUCT, null]` above cannot see it, because the wrong answer here IS this
    product's name.
  */
  test('an empty <!--> comment does not hide a second marker', () => {
    const html = withEmptyComment()
    expect(html, 'the plant landed').toContain(EMPTY_COMMENT_PLANT)
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
