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

const MARKER = new RegExp(`<meta[^>]+name="${IDENTITY_META}"[^>]+content="([^"]+)"`, 'g')

/*
  A marker inside an HTML comment is an EXAMPLE and never an identity.

  This is not a hypothetical shape: apps/cockpit/index.html is mostly comment —
  30 lines of prose stand above the one line that counts, and they are about the
  marker. A reader that does not strip them believes the illustration.

  Both endings the HTML parser accepts, `-->` and `--!>`.
*/
function withoutComments(html: string): string {
  const stripped = html.replace(/<!--[\s\S]*?--!?>/g, '')
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
  const found = [...withoutComments(html).matchAll(MARKER)]
  return found.length === 1 ? (found[0]![1] ?? null) : null
}
