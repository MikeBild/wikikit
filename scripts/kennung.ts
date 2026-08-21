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

/*
  Every `<meta …>` element, with the inside of its tag — INCLUDING a trailing
  `/`, because that slash is not always the tag's.

  In an UNQUOTED attribute value the parser reads `/` as an ordinary character;
  only whitespace and `>` end such a value. Measured at a live Chromium over
  real HTTP, `<meta name=cockpit-product content=WikiKit/>`:

    parser                    -> ["WikiKit/"]   a product that is not this one
    reader with `\/?>` here   -> "WikiKit"      the assert passes, the run goes on

  That was a REGRESSION against the reader this file replaced: d21686e's
  pattern resolved no attributes at all and answered `null` here, which the
  caller turns into exit 2 (LOCAL-WI-KENNUNG-SCHRAEGSTRICH-IM-WERT).

  So the slash stays in the tag body and ATTRIBUTE below decides whose it is:
  an unquoted value takes it, an attribute NAME never does, and after a quoted
  value it belongs to the tag and matches nothing.
*/
const META = /<meta(\s[^>]*?)>/gi

/** One attribute: its name, and its value in double, single or no quotes. */
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]*)))?/g

/** The character references a value or an attribute NAME may be written with. */
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' } as const

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
  const found = identitiesIn(withoutComments(html))
  return found.length === 1 ? found[0]! : null
}

/*
  Every `<meta>` element the PARSER counts as the identity, and the value it
  carries — null for one it cannot resolve.

  WHY THIS IS AN ATTRIBUTE READER AND NOT A PATTERN

  A pattern recognises one spelling. The parser accepts many, and every spelling
  the pattern misses is a SECOND marker the reader does not see — so the count
  stays at one and the reader answers confidently with THIS product's name while
  the document also names another. That is the same class as the empty comment
  (LOCAL-WI-KENNUNG-LEERKOMMENTAR), and four spellings sat in it. All measured
  at a live Chromium over real HTTP, each planted BESIDE the real marker, parser
  reading ["WikiKit", "OtherProduct"] every time:

    <META NAME=… CONTENT=…>              reader -> "WikiKit"   attribute names are case-insensitive
    <meta name='…' content='…'>          reader -> "WikiKit"   single quotes are quotes
    <meta name="cockpit&#45;product" …>  reader -> "WikiKit"   references are decoded in the NAME too
    <meta name=… content=…>              reader -> "WikiKit"   quotes are optional

  The fixtures posed all four with NO real marker beside them, where they are
  fail-safe, and so never asked the question that matters
  (LOCAL-WI-KENNUNG-ZWEITER-MARKER-UNSICHTBAR).

  Reading attributes instead closes the class rather than four members of it: a
  second identity element is now COUNTED under any of these spellings, and two
  are an ambiguity.

  NUMERIC references — the general escape hatch, and what a foreign document
  would reach for — are closed: decimal and hex, WITH the `;` and without it,
  including the three results that are not the number itself (see decoded()).

  THE KNOWN LIMIT IS THE NAMED REFERENCE, and it is narrower than 73d671e
  claimed. NAMED holds six names and they are decoded only WITH their `;`. The
  parser's table is far larger and it also accepts a legacy subset without one.
  Measured at a live Chromium, both in the SAFE direction — the reader answers a
  value the DOM does not carry, the assert sees a mismatch and the run ends at
  exit 2, never under this product's name:

    content="A&copy;B"   parser -> "A©B"   reader -> "A&copy;B"
    content="A&amp B"    parser -> "A& B"  reader -> "A&amp B"

  In an attribute NAME the same gap would be in the DANGEROUS direction: an
  undecoded name is not counted, and an uncounted second marker is the whole
  point of this class. Whether any name in the parser's table decodes to a
  character `cockpit-product` is made of is NOT measured here — the limit is
  named, not bounded (LOCAL-WI-KENNUNG-NAMENSREFERENZ, open). Both shapes above
  stand in the form table as known holes, so the gap cannot close unnoticed and
  the marker cannot outlive it.
*/
function identitiesIn(html: string): (string | null)[] {
  const found: (string | null)[] = []
  for (const tag of html.matchAll(META)) {
    const value = new Map<string, string>()
    const twice = new Set<string>()
    for (const attribute of tag[1]!.matchAll(ATTRIBUTE)) {
      // Attribute NAMES are case-insensitive and decoded; values are neither
      // lower-cased (an identity is compared verbatim) nor left encoded.
      const name = decoded(attribute[1]!).toLowerCase()
      if (value.has(name)) twice.add(name)
      else value.set(name, decoded(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''))
    }
    // The parser keeps the FIRST attribute of a name and drops the repeat, a
    // pattern with a greedy prefix reads the LAST. Neither guess is worth a
    // name, so a repeat of either deciding attribute is an ambiguity
    // (LOCAL-WI-KENNUNG-ZWEIMAL-CONTENT).
    if (value.get('name') !== IDENTITY_META) continue
    const content = value.get('content')
    found.push(twice.has('name') || twice.has('content') || !content ? null : content)
  }
  return found
}

/*
  A NUMERIC reference needs no `;`. The parser reports a parse error and decodes
  anyway — which is how `name="cockpit&#45product"` reaches the DOM as
  `cockpit-product` while a reader that insists on the semicolon sees a
  different name, does not count the element, and answers confidently with the
  one marker it did count (LOCAL-WI-KENNUNG-ZIFFERNREFERENZ-OHNE-SEMIKOLON).

  A NAMED reference does need its `;` here — see the limit above. The two
  branches are therefore separate alternatives and not one with an optional
  tail: `&ampB` really is literal text in the DOM as well, because inside an
  attribute value the parser declines a `;`-less name followed by a letter.
*/
const REFERENCE = /&#x([0-9a-f]+);?|&#([0-9]+);?|&([a-z]+);/gi

/*
  The parser's replacement table for 0x80-0x9F. Those numbers do not name the
  C1 controls they look like but the Windows-1252 characters at that position —
  `&#128;` is "€" in the DOM, and an unmapped reader puts an invisible U+0080
  there instead. Index 0 is 0x80.
*/
const WINDOWS_1252 =
  '20AC 0081 201A 0192 201E 2026 2020 2021 02C6 2030 0160 2039 0152 008D 017D 008F 0090 2018 2019 201C 201D 2022 2013 2014 02DC 2122 0161 203A 0153 009D 017E 0178'
    .split(' ')
    .map((hex) => parseInt(hex, 16))

/** `&#45;`, `&#45` and `&amp;` the way the parser reads them — in names and in values. */
function decoded(text: string): string {
  return text.replace(REFERENCE, (whole: string, hex?: string, decimal?: string, named?: string) => {
    if (named !== undefined) return NAMED[named.toLowerCase() as keyof typeof NAMED] ?? whole
    const code = hex === undefined ? parseInt(decimal!, 10) : parseInt(hex, 16)
    // Zero, past the last code point, and the surrogate range are the three the
    // parser answers with U+FFFD rather than with the number.
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd'
    return String.fromCodePoint(code >= 0x80 && code <= 0x9f ? WINDOWS_1252[code - 0x80]! : code)
  })
}
