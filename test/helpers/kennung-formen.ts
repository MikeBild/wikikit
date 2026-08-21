// The shapes an HTML parser reads differently than a pattern does — built from
// the REAL apps/cockpit/index.html, because a rejection fixture that is a
// minimal shell only proves that the reader rejects minimal shells.
//
// ONE table, two holders:
//   test/unit/konvention-check-kennung.test.ts   the reader answers `reads`
//   test/integration/kennung-am-browser.test.ts  a live Chromium over real HTTP
//                                                justifies every `reads`
//
// Split apart, a fixture drifts away from the measurement that justifies it,
// and the transcribed number keeps looking valid (LOCAL-WI-KENNUNG-FIXTURE-DANEBEN).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { IDENTITY_META } from '../../scripts/kennung.ts'

export const shell = readFileSync(join(process.cwd(), 'apps', 'cockpit', 'index.html'), 'utf8')

/*
  The product's own spelling, taken from the marker itself rather than from
  package.json: the package is called "wikikit" and the marker says "WikiKit",
  and an identity is compared verbatim.
*/
export const PRODUCT = new RegExp(`<meta name="${IDENTITY_META}" content="([^"]+)"`).exec(shell)![1]!

/*
  The anchor for a marker planted OUTSIDE any comment. Not `<title>` from the
  prose: the real document mentions `<title>` inside the comment, 30 lines up —
  measured, a fixture anchored there plants its marker into the comment and
  proves the opposite of what it claims.
*/
export const HEAD_ANCHOR = `<title>${PRODUCT} Cockpit</title>`

/** The one line that carries the identity in the real document. */
const REAL = new RegExp(`^.*<meta name="${IDENTITY_META}" content="[^"]+" />.*$\\n`, 'm')

/** The real document with its marker line taken out — prose and all. */
export const withoutMarker = (): string => shell.replace(REAL, '')

/** An example marker, planted inside the real prose comment ABOVE the real one. */
export const withExample = (html: string): string =>
  html.replace(
    'Die Konvention macht die DOM-Verankerungen',
    `Zum Beispiel: <meta name="${IDENTITY_META}" content="OtherProduct" />\n      Die Konvention macht die DOM-Verankerungen`,
  )

/** The same tag in every spelling the parser accepts. */
const foreign = {
  plain: `<meta name="${IDENTITY_META}" content="OtherProduct" />`,
  upper: `<META NAME="${IDENTITY_META}" CONTENT="OtherProduct" />`,
  quoted: `<meta name='${IDENTITY_META}' content='OtherProduct' />`,
  bare: `<meta name=${IDENTITY_META} content=OtherProduct>`,
  swapped: `<meta content="OtherProduct" name="${IDENTITY_META}" />`,
  entityName: `<meta name="cockpit&#45;product" content="OtherProduct" />`,
  entityValue: `<meta name="${IDENTITY_META}" content="Other&#80;roduct" />`,
  twiceContent: `<meta name="${IDENTITY_META}" content="OtherProduct" content="${PRODUCT}" />`,
  commented: `<!-- <meta name="${IDENTITY_META}" content="OtherProduct" /> --!>`,
  slashEaten: `<meta name=${IDENTITY_META} content=OtherProduct/>`,
  entityNameNoSemi: `<meta name="cockpit&#45product" content="OtherProduct" />`,
  entityValueNoSemi: `<meta name="${IDENTITY_META}" content="Other&#80roduct" />`,
  namedRefValue: `<meta name="${IDENTITY_META}" content="Other&copy;Product" />`,
  namedRefNoSemi: `<meta name="${IDENTITY_META}" content="Other&amp Product" />`,
}

/*
  The tag's `/` glued onto an UNQUOTED value — written with THIS product's own
  name, which is what makes it the sharp case: the document says `WikiKit/`, and
  `WikiKit/` is not `WikiKit`.

  The parser ends an unquoted value at whitespace or at `>`, at nothing else. A
  reader that treats the slash as the tag's self-closing mark answers this
  product's name for a document that carries a foreign one, the assert passes,
  and the run measures on (LOCAL-WI-KENNUNG-SCHRAEGSTRICH-IM-WERT).
*/
const OWN_SLASH_EATEN = `<meta name=${IDENTITY_META} content=${PRODUCT}/>`

/*
  `<!-->` is an EMPTY comment, closed abruptly — not the start of one. The
  parser ends it at that `>`, so the marker behind it is LIVE.

  The foreign marker has to be BEHIND the `<!-->` and ALIVE. The earlier fixture
  put `<!-->` in front of the already commented prose, where a reader that
  mistakes it for an opening swallows nothing that counts — and so posed nothing
  (LOCAL-WI-KENNUNG-LEERKOMMENTAR).
*/
export const EMPTY_COMMENT_PLANT = `<!-->${foreign.plain}`

/** Planted into the head, outside every comment. */
const beside = (tag: string) => shell.replace(HEAD_ANCHOR, `${tag}\n    ${HEAD_ANCHOR}`)
const alone = (tag: string) => withoutMarker().replace(HEAD_ANCHOR, `${tag}\n    ${HEAD_ANCHOR}`)

export type Form = {
  /** What the case is called. */
  name: string
  /** The document. */
  html: string
  /** The construct that has to STAND in it — a fixture must land where it claims. */
  landed: string
  /** What the reader has to answer. `null` is "not measured", exit 2. */
  reads: string | null
  /**
   * What a live Chromium reads from the same document over real HTTP —
   * every `meta[name="cockpit-product"]` it ends up with, in order.
   * Measured, not reasoned: test/integration/kennung-am-browser.test.ts holds
   * this list against the browser itself, so a wrong entry turns red.
   */
  browser: string[]
  /**
   * Set only where the reader is KNOWN to disagree with the browser, naming the
   * open finding. The integration test then requires the disagreement to still
   * be there — a marker cannot be left behind after the hole is closed.
   */
  known?: string
}

export const forms: Form[] = [
  {
    name: 'a "-->" string inside the comment',
    html: shell.replace('Die Konvention macht', 'Ein "-->" hier. Die Konvention macht'),
    landed: 'Ein "-->" hier.',
    reads: PRODUCT,
    browser: [],
    known: 'LOCAL-WI-KENNUNG-ROHTEXT',
  },
  {
    name: 'a nested <!-- inside the comment',
    html: shell.replace('Die Konvention macht', 'Ein <!-- hier. Die Konvention macht'),
    landed: 'Ein <!-- hier.',
    reads: PRODUCT,
    browser: [PRODUCT],
  },
  {
    name: 'a comment closed with --!>',
    html: shell.replace('<head>', `<head>\n    ${foreign.commented}`),
    landed: foreign.commented,
    reads: PRODUCT,
    browser: [PRODUCT],
  },
  {
    name: 'an unclosed comment before the real marker',
    html: shell.replace(`<meta name="${IDENTITY_META}"`, `<!-- unclosed\n    <meta name="${IDENTITY_META}"`),
    landed: '<!-- unclosed',
    reads: null,
    browser: [],
  },
  {
    name: 'an empty <!--> comment before a live foreign marker',
    html: shell.replace('<head>', `<head>\n    ${EMPTY_COMMENT_PLANT}`),
    landed: EMPTY_COMMENT_PLANT,
    reads: null,
    browser: ['OtherProduct', PRODUCT],
  },

  /*
    THE DANGEROUS HALF. Each spelling below is one the parser accepts and a
    pattern misses — so it is a SECOND marker the reader does not see, the count
    stays at one, and the reader answers with THIS product's name for a document
    that names another. Every one of them is therefore posed BESIDE the real
    marker; alone they are fail-safe and ask nothing
    (LOCAL-WI-KENNUNG-ZWEITER-MARKER-UNSICHTBAR).
  */
  {
    name: 'UPPERCASE attributes beside the real marker',
    html: beside(foreign.upper),
    landed: foreign.upper,
    reads: null,
    browser: [PRODUCT, 'OtherProduct'],
  },
  {
    name: 'single quotes beside the real marker',
    html: beside(foreign.quoted),
    landed: foreign.quoted,
    reads: null,
    browser: [PRODUCT, 'OtherProduct'],
  },
  {
    name: 'no quotes at all beside the real marker',
    html: beside(foreign.bare),
    landed: foreign.bare,
    reads: null,
    browser: [PRODUCT, 'OtherProduct'],
  },
  {
    name: 'content before name beside the real marker',
    html: beside(foreign.swapped),
    landed: foreign.swapped,
    reads: null,
    browser: [PRODUCT, 'OtherProduct'],
  },
  {
    name: 'a character reference in the attribute NAME beside the real marker',
    html: beside(foreign.entityName),
    landed: foreign.entityName,
    reads: null,
    browser: [PRODUCT, 'OtherProduct'],
  },
  {
    name: 'two content= on one element beside the real marker',
    html: beside(foreign.twiceContent),
    landed: foreign.twiceContent,
    reads: null,
    browser: [PRODUCT, 'OtherProduct'],
  },
  {
    name: 'a numeric reference WITHOUT its semicolon in the NAME, beside the real marker',
    html: beside(foreign.entityNameNoSemi),
    landed: foreign.entityNameNoSemi,
    reads: null,
    browser: [PRODUCT, 'OtherProduct'],
  },
  {
    name: 'an unquoted value that eats the tag slash, beside the real marker',
    html: beside(foreign.slashEaten),
    landed: foreign.slashEaten,
    reads: null,
    browser: [PRODUCT, 'OtherProduct/'],
  },

  /*
    THE SHARPEST ONE, and the reason `/?>` is gone from the META pattern: the
    marker carries THIS product's name and the parser still reads a foreign
    document, because the tag's slash belongs to the value. The reader must
    answer `WikiKit/` — a name that will not match this repository's own, so the
    assert stops the run (exit 2) instead of measuring under it.
  */
  {
    name: "this product's own name with the tag slash glued on, alone",
    html: alone(OWN_SLASH_EATEN),
    landed: OWN_SLASH_EATEN,
    reads: `${PRODUCT}/`,
    browser: [`${PRODUCT}/`],
  },

  /*
    The same spellings ALONE. Here the reader may name the foreign product — it
    is what the parser reads, the assert sees a mismatch against this
    repository's own marker and stops the run loudly (exit 2). A name that is
    true is not the danger; a name that is GUESSED is.
  */
  {
    name: 'UPPERCASE attributes, no real marker',
    html: alone(foreign.upper),
    landed: foreign.upper,
    reads: 'OtherProduct',
    browser: ['OtherProduct'],
  },
  {
    name: 'single quotes, no real marker',
    html: alone(foreign.quoted),
    landed: foreign.quoted,
    reads: 'OtherProduct',
    browser: ['OtherProduct'],
  },
  {
    name: 'no quotes at all, no real marker',
    html: alone(foreign.bare),
    landed: foreign.bare,
    reads: 'OtherProduct',
    browser: ['OtherProduct'],
  },
  {
    name: 'content before name, no real marker',
    html: alone(foreign.swapped),
    landed: foreign.swapped,
    reads: 'OtherProduct',
    browser: ['OtherProduct'],
  },
  {
    name: 'a character reference in the attribute NAME, no real marker',
    html: alone(foreign.entityName),
    landed: foreign.entityName,
    reads: 'OtherProduct',
    browser: ['OtherProduct'],
  },
  {
    name: 'a character reference in the VALUE, no real marker',
    html: alone(foreign.entityValue),
    landed: foreign.entityValue,
    reads: 'OtherProduct',
    browser: ['OtherProduct'],
  },
  {
    name: 'two content= on one element, no real marker',
    html: alone(foreign.twiceContent),
    landed: foreign.twiceContent,
    reads: null,
    browser: ['OtherProduct'],
  },
  {
    name: 'an unquoted value that eats the tag slash, no real marker',
    html: alone(foreign.slashEaten),
    landed: foreign.slashEaten,
    reads: 'OtherProduct/',
    browser: ['OtherProduct/'],
  },
  {
    name: 'a numeric reference WITHOUT its semicolon in the NAME, no real marker',
    html: alone(foreign.entityNameNoSemi),
    landed: foreign.entityNameNoSemi,
    reads: 'OtherProduct',
    browser: ['OtherProduct'],
  },
  {
    name: 'a numeric reference WITHOUT its semicolon in the VALUE, no real marker',
    html: alone(foreign.entityValueNoSemi),
    landed: foreign.entityValueNoSemi,
    reads: 'OtherProduct',
    browser: ['OtherProduct'],
  },

  /*
    THE NAMED REFERENCE, the one part of the class that is NOT closed — and the
    reason 73d671e's "closes the class rather than four members of it" was too
    strong. The reader decodes six names, all of them only WITH their `;`; the
    parser's table is far larger and accepts a legacy subset without one.

    The gap is bounded, and the bound is held by a test rather than by this
    sentence: none of the parser's 2231 named references decodes to any
    character `cockpit-product` is made of, so none can reach the attribute NAME
    where this gap would be dangerous (see scripts/kennung.ts, and the probe in
    the integration suite that poses the whole table). Both shapes below are
    therefore in the SAFE direction — the reader answers a value the DOM does
    not carry, the assert sees a mismatch and the run ends at exit 2 rather than
    under this product's name — so they stand here as KNOWN holes. The
    integration test requires them to keep disagreeing, so the marker cannot
    outlive the finding (LOCAL-WI-KENNUNG-NAMENSREFERENZ).
  */
  {
    name: 'a named reference outside the six, no real marker',
    html: alone(foreign.namedRefValue),
    landed: foreign.namedRefValue,
    reads: 'Other&copy;Product',
    browser: ['Other©Product'],
    known: 'LOCAL-WI-KENNUNG-NAMENSREFERENZ',
  },
  {
    name: 'a legacy named reference WITHOUT its semicolon, no real marker',
    html: alone(foreign.namedRefNoSemi),
    landed: foreign.namedRefNoSemi,
    reads: 'Other&amp Product',
    browser: ['Other& Product'],
    known: 'LOCAL-WI-KENNUNG-NAMENSREFERENZ',
  },
]

/*
  THE GENERATOR.

  The table above poses what its author thought of. This poses more, and the
  difference is not academic: 15 shapes nobody had written down found a live
  regression in half a minute (LOCAL-WI-KENNUNG-SCHRAEGSTRICH-IM-WERT — the
  tag's `/` eaten by an unquoted value). Without it the suite certifies the
  reader to the width of whoever wrote it, and in six products that happens six
  times.

  WHAT IS CLAIMED, EXACTLY: the SIX axes named below are posed, each one crossed
  with both halves (beside the real marker and alone), and every disagreement
  they produce is named in KNOWN_HOLES with the finding it belongs to.

  WHAT IS NOT CLAIMED: that these are the axes the parser has. That sentence
  stood here and was wrong — the sixth axis below is one WatchKit had and this
  generator did not, and the shape it poses passes the gate under this product's
  own name (LOCAL-WI-KENNUNG-GENERATOR-OHNE-KOMMENTARACHSE). It was the fourth
  completeness claim in this file to break in one day. A count of blind spots is
  a claim about what nobody has looked for yet; that is not measurable, so it is
  not asserted here (BEFUND-PROSA-NEBEN-CODE, rule 3). An axis is added by
  measuring a shape the corpus does not pose — not by widening a sentence.

  NOTHING HERE IS TRANSCRIBED. A generated form carries no recorded `browser`
  and no recorded `reads`; the browser suite holds only the PROPERTY against a
  live Chromium — a name may come back only when the parser reads exactly that
  one marker, and `null` is always allowed. So there is no number to keep up to
  date and nothing that can quietly go stale.

  DETERMINISTIC ON PURPOSE. A random fuzzer that goes red once is a bug report
  nobody can reproduce, and in a gate stage that is indistinguishable from flaky.
*/
export type Generated = { name: string; html: string }

const QUOTINGS = [
  { id: 'double', around: (value: string) => `"${value}"` },
  { id: 'single', around: (value: string) => `'${value}'` },
  { id: 'bare', around: (value: string) => value },
]

/** How the tag ends. `/>` and ` />` differ once a value is unquoted. */
const CLOSERS = [
  { id: 'space-slash', text: ' />' },
  { id: 'slash', text: '/>' },
  { id: 'plain', text: '>' },
  { id: 'space', text: ' >' },
]

const ORDERS = [
  { id: 'name-first', flip: false },
  { id: 'content-first', flip: true },
]

/** Spellings of the attribute NAME the parser resolves to the same name. */
const NAME_SPELLINGS = [
  IDENTITY_META,
  'cockpit&#45;product',
  'cockpit&#45product',
  'cockpit&#x2D;product',
  'cockpit&#x2dproduct',
]

/** Spellings of the VALUE — every escape hatch, with its `;` and without. */
const VALUE_SPELLINGS = [
  'OtherProduct',
  'Other&#80;roduct',
  'Other&#80roduct',
  'Other&#x50;roduct',
  'Other&#x50roduct',
  'Other&amp;Product',
  'Other&AMP;Product',
  'Other&copy;Product',
  'Other&amp Product',
  'Other&ampProduct',
  'Other&#0;Product',
  'Other&#1114112;Product',
  'Other&#xD800;Product',
  'Other&#128;Product',
]

const CASINGS = [
  { id: 'lower', of: (text: string) => text },
  { id: 'upper', of: (text: string) => text.toUpperCase() },
  { id: 'mixed', of: (text: string) => text[0]!.toUpperCase() + text.slice(1) },
]

/** What stands around the tag. A comment is an example; an ABORTED one is not. */
const WRAPPINGS = [
  { id: 'plain', around: (tag: string) => tag },
  { id: 'commented', around: (tag: string) => `<!-- ${tag} --!>` },
  { id: 'commented-plain-end', around: (tag: string) => `<!-- ${tag} -->` },
  { id: 'empty-comment', around: (tag: string) => `<!-->${tag}` },
  { id: 'empty-comment-three', around: (tag: string) => `<!--->${tag}` },
  { id: 'unclosed-comment', around: (tag: string) => `<!-- unclosed\n    ${tag}` },
  { id: 'nested-open', around: (tag: string) => `<!-- an <!-- inside -->${tag}` },
]

/*
  THE SIXTH AXIS: comment syntax INSIDE the tag — in the attribute VALUE and in
  the attribute NAME. WRAPPINGS above only ever puts a comment AROUND the whole
  element, which is the harmless half of this class.

  A comment cannot begin inside a tag: to the parser `<!--` in an attribute
  value is four ordinary characters. A reader that strips comment syntax out of
  the RAW BYTES does not know that, and the two halves of the mistake point in
  opposite directions:

    content="Wiki<!--Other-->Kit"  parser ["Wiki<!--Other-->Kit"]  reader "WikiKit"

  is the DANGEROUS one — the reader answers THIS product's name for a document
  that does not carry it, the caller's assert passes and the run measures on.
  This is the axis WatchKit had and this file did not
  (LOCAL-WI-KENNUNG-GENERATOR-OHNE-KOMMENTARACHSE); the root is the same one
  LOCAL-WI-KENNUNG-ROHTEXT names — withoutComments() decides what a comment is
  without knowing where the parser would see one.

  The value is built from PRODUCT itself, split in half, so the sharp form
  spells this repository's own name once the bytes are stripped.
*/
const OWN_HEAD = PRODUCT.slice(0, Math.ceil(PRODUCT.length / 2))
const OWN_TAIL = PRODUCT.slice(OWN_HEAD.length)

const IN_TAG: { id: string; name?: string; value: string }[] = [
  /* Stripped, the foreign value IS this product's name. */
  { id: 'own-name-split', value: `${OWN_HEAD}<!--Other-->${OWN_TAIL}` },
  /* The same with the `--!>` ending the parser also accepts for a comment. */
  { id: 'own-name-split-bang', value: `${OWN_HEAD}<!--Other--!>${OWN_TAIL}` },
  /* An unclosed opener: a byte-level stripper cuts the document from here, so
     everything BEHIND it disappears — and a plant sits behind the real marker. */
  { id: 'unclosed-in-value', value: 'OtherProduct<!--x' },
  { id: 'whole-comment-in-value', value: 'Other<!--x-->Product' },
  { id: 'closer-in-value', value: 'Other-->Product' },
  { id: 'empty-comment-in-value', value: 'Other<!-->Product' },
  /* And the same syntax in the attribute NAME, where stripping INVENTS the
     identity name out of one the parser never read. */
  { id: 'comment-in-name', name: 'cockpit-<!--x-->product', value: 'OtherProduct' },
]

/*
  Beside the real marker the foreign tag has to be COUNTED, or the reader names
  this product for a document that names two. Alone it may be named, because a
  name that is true stops the run at the assert. Both halves, always.
*/
const PLACINGS = [
  { id: 'beside', into: beside },
  { id: 'alone', into: alone },
]

function element(parts: {
  tagCase: (text: string) => string
  attributeCase: (text: string) => string
  quoting: (typeof QUOTINGS)[number]
  name: string
  value: string
  closer: string
  flip: boolean
}): string {
  const attributes = [
    `${parts.attributeCase('name')}=${parts.quoting.around(parts.name)}`,
    `${parts.attributeCase('content')}=${parts.quoting.around(parts.value)}`,
  ]
  if (parts.flip) attributes.reverse()
  return `<${parts.tagCase('meta')} ${attributes.join(' ')}${parts.closer}`
}

const BASE = {
  tagCase: CASINGS[0]!.of,
  attributeCase: CASINGS[0]!.of,
  quoting: QUOTINGS[0]!,
  name: IDENTITY_META,
  value: 'OtherProduct',
  closer: CLOSERS[0]!.text,
  flip: false,
}

/**
 * Every generated form, in a fixed order. Five crosses rather than one, so the
 * count stays in the low hundreds and each axis is crossed with the ones it can
 * actually interact with.
 */
export function fuzzForms(): Generated[] {
  const out: Generated[] = []
  const add = (name: string, tag: string, placing: (typeof PLACINGS)[number]) =>
    out.push({ name: `fuzz/${name}/${placing.id}`, html: placing.into(tag) })

  // The tokenizer cross: quoting decides whether the closer's `/` is the tag's
  // or the value's, and the order decides which attribute it lands on.
  for (const quoting of QUOTINGS)
    for (const closer of CLOSERS)
      for (const order of ORDERS)
        for (const placing of PLACINGS)
          add(
            `tokens/${quoting.id}/${closer.id}/${order.id}`,
            element({ ...BASE, quoting, closer: closer.text, flip: order.flip }),
            placing,
          )

  // The NAME cross: an undecoded name is an UNCOUNTED element, which is the
  // dangerous direction of this whole class.
  for (const name of NAME_SPELLINGS)
    for (const quoting of QUOTINGS)
      for (const placing of PLACINGS) add(`name/${name}/${quoting.id}`, element({ ...BASE, name, quoting }), placing)

  // The VALUE cross: quoting fixed, so the axis stays the reference alone.
  for (const value of VALUE_SPELLINGS)
    for (const placing of PLACINGS) add(`value/${value}`, element({ ...BASE, value }), placing)

  // The case cross: element name and attribute names are case-insensitive, the
  // value is not.
  for (const tagCase of CASINGS)
    for (const attributeCase of CASINGS)
      for (const quoting of QUOTINGS)
        for (const placing of PLACINGS)
          add(
            `case/${tagCase.id}/${attributeCase.id}/${quoting.id}`,
            element({ ...BASE, tagCase: tagCase.of, attributeCase: attributeCase.of, quoting }),
            placing,
          )

  // The comment cross: what a reader must treat as an example, and what only
  // LOOKS like one.
  for (const wrapping of WRAPPINGS)
    for (const placing of PLACINGS) add(`comment/${wrapping.id}`, wrapping.around(element({ ...BASE })), placing)

  // The in-tag cross: comment syntax where no comment can begin. Quoting is
  // crossed because it decides where the value ends — unquoted, a `>` inside
  // `-->` closes the tag instead.
  for (const shape of IN_TAG)
    for (const quoting of QUOTINGS)
      for (const placing of PLACINGS)
        add(
          `in-tag/${shape.id}/${quoting.id}`,
          element({ ...BASE, name: shape.name ?? BASE.name, value: shape.value, quoting }),
          placing,
        )

  return out
}
