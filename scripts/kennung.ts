// Which product a cockpit document says it is.
//
// WHY THIS IS ITS OWN FILE
//
// scripts/konvention-check.mjs runs on import (top-level `await main()`), so a
// test cannot import the reader out of it. The identity test therefore spelled
// out the reader's SOURCE — and source spelled out is not behaviour held. Both
// measured on d407949: `markerIn(prose + example + real)` returned
// "OtherProduct" instead of "WikiKit", and the test stayed 6 pass / 0 fail
// (LOCAL-WI-KENNUNG-BEISPIEL-GEWINNT).

/** The attribute a cockpit document stamps its product on. */
export const IDENTITY_META = 'cockpit-product'

/** A `<meta>` element carrying the identity attribute, and the rest of the tag. */
const MARKER = new RegExp(`<meta[^>]*?\\sname="${IDENTITY_META}"([^>]*)>`, 'g')

/** Every `content=` on that element — one is a value, two are an ambiguity. */
const CONTENT = /\scontent="([^"]*)"/g

/*
  A marker inside an HTML comment is an EXAMPLE and never an identity.

  This is not a hypothetical shape: apps/cockpit/index.html is mostly comment —
  30 lines of prose stand above the one line that counts, and they are about the
  marker. A reader that does not strip them believes the illustration.

  Both endings the HTML parser accepts, `-->` and `--!>`.
*/
function withoutComments(html: string): string {
  /*
    EMPTY comments first. `<!-->` and `<!--->` are closed abruptly: the parser
    ends the comment at that `>` and everything after it is LIVE. The general
    pattern below reads their `<!--` as an OPENING and eats forward to the next
    `-->` — swallowing whatever stands in between.

    Measured at a live Chromium over HTTP, `<!-->` before a foreign marker and
    above the real one (LOCAL-WI-KENNUNG-LEERKOMMENTAR):

      parser -> ["OtherProduct", "WikiKit"]   two live markers
      without this line -> "WikiKit"          the foreign one was swallowed

    That is a name where the document is ambiguous, and it was a REGRESSION:
    the reader before this file, which stripped nothing, read "OtherProduct"
    and the assert threw.
  */
  const stripped = html.replace(/<!---?>/g, '').replace(/<!--[\s\S]*?--!?>/g, '')
  // An UNCLOSED `<!--` runs to the end of the document in a browser. What is
  // invisible there has to be invisible here.
  const unclosed = stripped.indexOf('<!--')
  return unclosed === -1 ? stripped : stripped.slice(0, unclosed)
}

/**
 * A document's marker, or `null` — when it carries none, and equally when it
 * carries more than one.
 *
 * Ambiguity is not an identity. Every shape this reader cannot resolve leaves
 * here as `null`, and the caller turns `null` into "not measured" (exit 2)
 * rather than into a name: a run that refuses can be repaired, a run under a
 * foreign name gets believed.
 */
export function markerIn(html: string): string | null {
  const found = [...withoutComments(html).matchAll(MARKER)].map((meta) => valueOf(meta[1]!))
  return found.length === 1 ? found[0]! : null
}

/*
  The value of ONE identity element, or null when it does not carry exactly one.

  Two `content=` on the same element is the dangerous half of this class. The
  parser keeps the FIRST attribute and drops the second; a single pattern with a
  greedy `[^>]+` in front of `content` backtracks onto the LAST. Measured at a
  live Chromium over real HTTP (LOCAL-WI-KENNUNG-ZWEIMAL-CONTENT):

    <meta name="cockpit-product" content="OtherProduct" content="WikiKit" />
      parser -> "OtherProduct"
      before -> "WikiKit"

  A foreign console could hand this reader THIS product's name and be another
  one in the browser. Neither guess is worth a name, so the answer is null.
*/
function valueOf(rest: string): string | null {
  const contents = [...rest.matchAll(CONTENT)]
  // An EMPTY `content=""` is counted as an attribute here — a second one next
  // to it is still an ambiguity — but it is no name either.
  return contents.length === 1 ? contents[0]![1]! || null : null
}
