// The convention check's identity assert, held against its own shape.
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
// WHAT IS CHECKED HERE AND WHAT IS NOT
//
// Not THAT the assert exists — every run shows that. The three properties that
// distinguish it from the family's first implementation and that a later rewrite
// could remove silently: the expected value is DERIVED rather than typed out,
// the check runs BEFORE the browser starts, and there is exactly one node-side
// `fetch` — so exactly one place that needs a deadline.
//
// Pattern taken from WatchKit's test of the same name, COPIED and not imported
// (§7: no shared code between the products).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const source = readFileSync(join(root, 'scripts', 'konvention-check.mjs'), 'utf8')

/*
  Line comments and block comment bodies out before counting.

  Not cosmetics: that file explains its own broken predecessors in several places
  ("it used to ask with a `fetch` without a deadline"), and a counter that counts
  the explanation measures the prose instead of the program. The second replace
  catches the continuation lines of that file's block comments, which are written
  without a leading `*`.
*/
const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

/** A top-level function's body, from its head to the `}` in column 0. */
function bodyOf(head: string): string {
  const start = code.indexOf(head)
  expect(start, `${head} is findable`).toBeGreaterThan(0)
  const end = code.indexOf('\n}\n', start)
  expect(end, `${head} has an end`).toBeGreaterThan(start)
  return code.slice(start, end)
}

describe('the identity assert derives instead of typing out', () => {
  test('apps/cockpit/index.html is the single place of definition', () => {
    const shell = readFileSync(join(root, 'apps', 'cockpit', 'index.html'), 'utf8')
    const matches = [...shell.matchAll(/<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/g)]
    expect(matches.length, 'exactly one <meta name="cockpit-product"> in the source').toBe(1)

    // And the value is the product name, not just any: a marker that can drift
    // away from its own name would be worse than none.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    expect(matches[0]![1]!.toLowerCase()).toBe(pkg.name.toLowerCase())
  })

  test('the expected value comes from the file and appears nowhere in the assert', () => {
    const body = bodyOf('function assertTargetIdentity(html, location)')

    // Derived: read, not written — and from the same constant classifyTarget()
    // compares against.
    expect(code).toContain("const COCKPIT_SOURCE_HTML = 'apps/cockpit/index.html'")
    expect(body).toContain('const sourceUrl = new URL(`../${COCKPIT_SOURCE_HTML}`, import.meta.url)')
    expect(body).toContain("const expected = markerIn(readFileSync(sourceUrl, 'utf8'))")

    /*
      And typed out nowhere. The BODY is checked rather than the whole file:
      "WikiKit" legitimately stands there as PRODUCT_NAME because §6 checks the
      spelling in prose — and that is exactly why the identity assert must not USE
      that constant. An identity that is also under test turns every real §6
      violation into "that is not WikiKit at all" and measures nothing afterwards.
      For the same reason, not the <title> either.
    */
    const marker = /<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/.exec(
      readFileSync(join(root, 'apps', 'cockpit', 'index.html'), 'utf8'),
    )?.[1]
    expect(marker, 'the source carries the marker').toBeTruthy()
    expect(body.includes(`'${marker}'`) || body.includes(`"${marker}"`), 'no literal of the marker').toBe(false)
    expect(body).not.toContain('PRODUCT_NAME')
    expect(body).not.toContain('<title>WikiKit')
  })

  test('the three branches say three different sentences', () => {
    const body = bodyOf('function assertTargetIdentity(html, location)')
    // A foreign console is NAMED, not merely rejected. That is the progress over
    // the first implementation: "something foreign" sends the reader searching,
    // "its title reads …" does not.
    expect(body).toContain('Its title reads')
    expect(body).toContain('this is not ${expected} but ${delivered}')
    // A renamed ATTRIBUTE is a finding about THIS repository and no statement
    // about the target — the message that otherwise points the wrong way.
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
    // second place with its own deadline for nothing: measured, marksIn() over
    // this text yields the same two references in both modes (dev and preview)
    // that the earlier DOM measurement did.
    expect(code).toContain('target = classifyTarget(marksIn(shellHtml))')
    expect(code).not.toContain('classifyTarget(shell.delivered)')
  })

  test('a foreign target ends with "not measured" rather than with a report', () => {
    // 0 is "measured and green", 1 is "measured and red", 2 is "not measured". A
    // foreign cockpit is not a convention violation but a run that did not
    // happen — the difference is the whole lesson from CodeKit's eight
    // violations.
    const body = bodyOf('function assertTargetIdentity(html, location)')
    expect(body).toContain('throw new Error(')
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

    const getWithin = bodyOf('async function getWithin(url, timeoutMs)')
    expect(getWithin).toContain('await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })')
    // The body is read UNDER the same signal: "the headers arrived" is not "the
    // server answers", and the gap between the two is the second hang.
    expect(getWithin).toContain('return { ok: response.ok, body: await response.text() }')

    const start = code.indexOf('async function getWithin(url, timeoutMs)')
    expect(nodeSide[0]).toBeGreaterThan(start)
    expect(nodeSide[0]).toBeLessThan(start + getWithin.length)
  })
})
