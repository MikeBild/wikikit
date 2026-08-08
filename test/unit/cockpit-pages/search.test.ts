// What the search page may claim about its own results.
//
// Two claims, both of them about not overstating what the wiki holds.
//
// "25 hits on pages a human reviewed and published" is a count that reads as a
// total. At exactly the limit it is not one — it is the top of a ranking whose
// remainder the console never asked for — and a reader who takes it for a total
// concludes the wiki holds nothing else on the subject. That conclusion is the
// opposite of what a knowledge base is for.
//
// And a hit that says how well the archive backs it is making a claim about
// evidence on the one screen that also shows unreviewed material. Which hits
// are allowed to make it, and what the answer means, are the rules below.
import { describe, expect, test } from 'bun:test'
import { pageEvidence, rendersAsDash } from '../../../apps/cockpit/src/pages/page.logic.ts'
import {
  RESULT_LIMIT,
  hitEvidence,
  resultCeilingNote,
  searchMeasuresEvidence,
  type EvidenceBearingHit,
} from '../../../apps/cockpit/src/pages/search.logic.ts'
import { zSearchQuery } from '../../../src/http/schemas.ts'

describe('the ceiling note', () => {
  test('is silent while the tier came back short — that count IS a total', () => {
    expect(resultCeilingNote(0, 'hits')).toBeNull()
    expect(resultCeilingNote(1, 'hits')).toBeNull()
    expect(resultCeilingNote(RESULT_LIMIT - 1, 'hits')).toBeNull()
  })

  test('speaks the moment a tier fills, naming the ceiling', () => {
    const note = resultCeilingNote(RESULT_LIMIT, 'hits')
    expect(note).not.toBeNull()
    expect(note).toContain(String(RESULT_LIMIT))
    expect(note).toContain('there may be more')
  })

  test('points at narrower words, because scrolling cannot reach the rest', () => {
    // The list is unpaged by design: there is no control that fetches hit 26,
    // so a caveat that only said "there may be more" would leave the reader
    // hunting for a Next button that does not exist.
    expect(resultCeilingNote(RESULT_LIMIT, 'hits')).toContain('narrower words')
  })

  test('uses each tier’s own noun — an excerpt is not a hit on approved knowledge', () => {
    expect(resultCeilingNote(RESULT_LIMIT, 'excerpts')).toContain('excerpts')
    expect(resultCeilingNote(RESULT_LIMIT, 'hits')).toContain('hits')
  })
})

// Which hits are allowed to say how the archive backs them.
//
// A result list is a choice about what to open, so the evidence behind a page
// belongs beside its rank. The danger is that it leaks onto the hits that are
// not pages: an unreviewed source excerpt wearing "12 claims · 4 sources" would
// read as the best-backed thing on the screen, which is the exact confusion the
// two-tier split on this page exists to prevent.
describe('a hit’s evidence', () => {
  const counts = { claims: 12, uncited_claims: 2, sources: 4 }

  test('is `pageEvidence`’s reading and not a second one', () => {
    // The whole point of routing through `page.logic`: the pages index and this
    // page must never disagree about what three integers mean. Held field for
    // field rather than by spot-check, so a local re-interpretation — a
    // different tone, a softer sentence, a rounded count — fails here.
    expect(hitEvidence({ tier: 'approved', kind: 'concept', evidence: counts })).toEqual(pageEvidence(counts))
  })

  test('never appears on a source-evidence hit, even when the response carries one', () => {
    // Not defensive noise: the tier gate is the console's own guarantee. Nobody
    // approved this line, nothing vouches for it, and it is not a page for
    // anything to back — so there is no reading of `evidence` that belongs on
    // it, whatever a future server decides to attach.
    expect(hitEvidence({ tier: 'source_evidence', kind: 'source_chunk', evidence: counts })).toBeNull()
    expect(hitEvidence({ tier: 'source_evidence', kind: 'concept', evidence: counts })).toBeNull()
  })

  test('never appears on a claim hit — and that is not an unmeasured value', () => {
    // A claim hit is one sentence off a page, not the page. The counts were
    // never in scope, so `null` (draw nothing) rather than `unmeasured` (draw
    // the em dash), which would report a gap in the answer that is not one.
    expect(hitEvidence({ tier: 'approved', kind: 'claim', evidence: counts })).toBeNull()
    expect(hitEvidence({ tier: 'approved', kind: 'claim' })).toBeNull()
  })

  test('is unmeasured on a page hit whose counts never arrived — a rolling upgrade, not a zero', () => {
    const missing = hitEvidence({ tier: 'approved', kind: 'concept' })
    expect(missing?.level).toBe('unmeasured')
    // The em dash's job, and the reason it may not be spent on anything else.
    expect(missing?.count).toBeNull()
    expect(missing?.flag).toBeNull()
  })

  test('keeps a measured zero apart from an absent one (CUI-SEV-2)', () => {
    // The same distinction the pages index defends, restated here because this
    // is the surface where losing it would be invisible: both would just be a
    // quiet line under an excerpt.
    const none = hitEvidence({
      tier: 'approved',
      kind: 'concept',
      evidence: { claims: 0, uncited_claims: 0, sources: 0 },
    })
    expect(none?.level).toBe('none')
    expect(none?.flag).toBe('No claims')
    expect(none?.level).not.toBe(hitEvidence({ tier: 'approved', kind: 'concept' })?.level)
  })

  test('gives a fully cited page no token that reads as verified (CUI-AI-1)', () => {
    const backed = hitEvidence({
      tier: 'approved',
      kind: 'concept',
      evidence: { claims: 4, uncited_claims: 0, sources: 2 },
    })
    expect(backed?.level).toBe('backed')
    expect(backed?.flag).toBeNull()
    expect(backed?.tone).not.toBe('success')
  })

  test('says in words what a page with holes in it is missing (CUI-A11Y-5)', () => {
    // `none` and `partial` share the amber tone, so the words are what separate
    // them — a colour alone says nothing.
    const partial = hitEvidence({ tier: 'approved', kind: 'concept', evidence: counts })
    expect(partial?.level).toBe('partial')
    expect(partial?.flag).toBe('2 uncited')
    expect(partial?.count).toBe('12 claims')
    expect(partial?.detail).toBe('4 sources')
  })
})

// Why a search hit draws the em dash — and why the two reasons may never become
// one sentence.
//
// A concept hit arrives without counts for two unrelated reasons that look
// identical in the hit:
//
//   (a) the page is a REFERENCE TARGET — a row an import created so reviewed
//       relations had somewhere to land, whose own body says the knowledge lives
//       on the pages it points at. The server declines to measure it. Nothing is
//       pending, nothing is broken, there is no ingest to run.
//   (b) the RESPONSE measured nothing — a tab that outlived a rolling upgrade,
//       answered by a build that predates the counts. Nothing here is known
//       about any page, and the next reload fixes it.
//
// Until now this screen said (b) under every dash, including the dashes on
// reference targets in responses whose other hits carried counts — a surface
// stating something false about a page, said only in `sr-only` text, so the
// reader most likely to be told the untrue thing was the one using a screen
// reader. These tests are what keeps the two apart.
describe('the dash on a search hit', () => {
  const backedCounts = { claims: 12, uncited_claims: 2, sources: 4 }

  // One response, three concept hits: a page with evidence, a page that
  // genuinely rests on nothing, and a reference target. Plus the two kinds that
  // never carry evidence, because a real response has them mixed in.
  const measuringResponse: readonly EvidenceBearingHit[] = [
    { tier: 'approved', kind: 'concept', evidence: backedCounts },
    { tier: 'approved', kind: 'concept', evidence: { claims: 0, uncited_claims: 0, sources: 0 } },
    { tier: 'approved', kind: 'concept' },
    { tier: 'approved', kind: 'claim' },
    { tier: 'source_evidence', kind: 'source_chunk' },
  ]

  // The same shape from a build that never heard of the counts: every concept
  // hit is bare, and no page on the screen may be described as anything.
  const silentResponse: readonly EvidenceBearingHit[] = [
    { tier: 'approved', kind: 'concept' },
    { tier: 'approved', kind: 'concept' },
    { tier: 'approved', kind: 'claim' },
  ]

  test('a reference target in a measuring response says what the PAGE is, not what the response failed to do', () => {
    // The defect, pinned. This is the hit that used to read "This list came back
    // without evidence counts" on a screen whose other cards were printing them.
    expect(searchMeasuresEvidence(measuringResponse)).toBe(true)

    const target = hitEvidence({ tier: 'approved', kind: 'concept' }, searchMeasuresEvidence(measuringResponse))
    expect(target?.level).toBe('reference')
    expect(rendersAsDash(target!.level)).toBe(true)
    expect(target?.reading).toMatch(/reference target/i)
    expect(target?.reading).toMatch(/not measured/i)
    // And never the other sentence, in any wording: "the counts did not arrive"
    // is a statement about a response, and this response answered fine.
    expect(target?.reading).not.toMatch(/came back without/i)
  })

  test('a response that measured nothing says so, and calls no page a reference target', () => {
    expect(searchMeasuresEvidence(silentResponse)).toBe(false)

    const unknown = hitEvidence({ tier: 'approved', kind: 'concept' }, searchMeasuresEvidence(silentResponse))
    expect(unknown?.level).toBe('unmeasured')
    expect(rendersAsDash(unknown!.level)).toBe(true)
    // The console may not invent a property of a page on the strength of a
    // response that never measured one.
    expect(unknown?.reading).not.toMatch(/reference target/i)
  })

  test('the two readings are two sentences and never collapse into one', () => {
    // Stated as an inequality as well as by content, so a future edit that
    // "unifies the wording" fails here rather than in production.
    const target = hitEvidence({ tier: 'approved', kind: 'concept' }, true)
    const unknown = hitEvidence({ tier: 'approved', kind: 'concept' }, false)
    expect(target?.reading).not.toBe(unknown?.reading)
    expect(target?.level).not.toBe(unknown?.level)
    // Both still print nothing — the distinction is in the words, not in a
    // number one of them sneaks in.
    expect(target?.count).toBeNull()
    expect(unknown?.count).toBeNull()
    expect(target?.flag).toBeNull()
    expect(unknown?.flag).toBeNull()
  })

  test('a page with real counts prints them whatever the response answer is', () => {
    // The response-level flag is only ever consulted for an ABSENT measurement.
    // A hit that carries numbers renders numbers, and would go on doing so if
    // the discriminator were wrong in either direction.
    for (const measured of [true, false]) {
      const backed = hitEvidence({ tier: 'approved', kind: 'concept', evidence: backedCounts }, measured)
      expect(backed?.level).toBe('partial')
      expect(backed?.count).toBe('12 claims')
      expect(backed?.detail).toBe('4 sources')
      expect(rendersAsDash(backed!.level)).toBe(false)
    }
  })

  test('a measured zero is a fact and prints as one — never the dash (CUI-SEV-2)', () => {
    // The page written by hand through the console: it makes no claims, and
    // saying so is the single most useful thing this line does. Drawing the dash
    // for it would put it back among the pages nobody measured.
    const zero = hitEvidence(
      { tier: 'approved', kind: 'concept', evidence: { claims: 0, uncited_claims: 0, sources: 0 } },
      searchMeasuresEvidence(measuringResponse),
    )
    expect(zero?.level).toBe('none')
    expect(rendersAsDash(zero!.level)).toBe(false)
    expect(zero?.flag).toBe('No claims')

    // And a measured zero inside a page that does make claims is printed as the
    // digit it is, in the same response.
    const nothingBehindIt = hitEvidence(
      { tier: 'approved', kind: 'concept', evidence: { claims: 4, uncited_claims: 4, sources: 0 } },
      true,
    )
    expect(rendersAsDash(nothingBehindIt!.level)).toBe(false)
    expect(nothingBehindIt?.detail).toBe('0 sources')
    expect(nothingBehindIt?.count).toBe('4 claims')
  })

  test('claim and source-chunk hits are untouched by the response answer', () => {
    // A third reason for silence, and it is neither of the two above: the three
    // numbers do not answer the question a claim hit raises, and a source chunk
    // is not approved knowledge at all. Both draw NOTHING — not a dash, not a
    // sentence — however the response is read.
    for (const measured of [true, false]) {
      expect(hitEvidence({ tier: 'approved', kind: 'claim' }, measured)).toBeNull()
      expect(hitEvidence({ tier: 'approved', kind: 'claim', evidence: backedCounts }, measured)).toBeNull()
      expect(hitEvidence({ tier: 'source_evidence', kind: 'source_chunk' }, measured)).toBeNull()
      expect(hitEvidence({ tier: 'source_evidence', kind: 'concept', evidence: backedCounts }, measured)).toBeNull()
    }
  })

  test('the default is the sentence that claims the least', () => {
    // A caller that has not established anything about the response gets (b),
    // which is true of every absence. Being vague is allowed; being wrong is not.
    expect(hitEvidence({ tier: 'approved', kind: 'concept' })?.level).toBe('unmeasured')
  })
})

// The discriminator itself: one boolean per response, and where it may look for
// its evidence.
describe('whether a search response measured evidence', () => {
  test('one measured page hit is enough — and no page hit at all is not', () => {
    expect(searchMeasuresEvidence([])).toBe(false)
    expect(searchMeasuresEvidence([{ tier: 'approved', kind: 'concept' }])).toBe(false)
    expect(
      searchMeasuresEvidence([
        { tier: 'approved', kind: 'concept' },
        { tier: 'approved', kind: 'concept', evidence: { claims: 0, uncited_claims: 0, sources: 0 } },
      ]),
    ).toBe(true)
  })

  test('only page hits may vouch for the build', () => {
    // A claim hit and a source chunk carry no evidence BY DESIGN, so they can
    // never prove a build measures. If a server ever attached counts to one,
    // letting it vouch would be this module trusting a number `hitEvidence`
    // refuses to render.
    expect(
      searchMeasuresEvidence([
        { tier: 'approved', kind: 'claim', evidence: { claims: 4, uncited_claims: 0, sources: 2 } },
        { tier: 'source_evidence', kind: 'concept', evidence: { claims: 4, uncited_claims: 0, sources: 2 } },
        { tier: 'approved', kind: 'concept' },
      ]),
    ).toBe(false)
  })

  test('a search filtered to claims is not mistaken for an old server', () => {
    // `?kind=claim` returns hits that legitimately carry nothing. There is no
    // page hit in it to be described either way, so the answer costs nothing —
    // but a version of this that counted every hit would read the whole response
    // as unmeasured and be wrong about a build that measures.
    expect(
      searchMeasuresEvidence([
        { tier: 'approved', kind: 'claim' },
        { tier: 'approved', kind: 'claim' },
      ]),
    ).toBe(false)
  })

  test('a hit the server contradicts itself about does not vouch for the response', () => {
    // `pageEvidence` reads a negative or half-filled count as unmeasured, so
    // such a hit draws a dash of its own. Letting it prove the build measures
    // would describe every bare hit beside it as a reference target.
    expect(
      searchMeasuresEvidence([{ tier: 'approved', kind: 'concept', evidence: { claims: -1, uncited_claims: 0 } }]),
    ).toBe(false)
    expect(searchMeasuresEvidence([{ tier: 'approved', kind: 'concept', evidence: { claims: 3 } }])).toBe(false)
  })

  test('is one answer for the whole response, not one per tier', () => {
    // The two sections on screen are one answer split for the reader. A page hit
    // must not say a different thing about itself because of the list it was
    // drawn in, so the discriminator is handed the response and never a section.
    const response: readonly EvidenceBearingHit[] = [
      { tier: 'approved', kind: 'concept', evidence: { claims: 2, uncited_claims: 0, sources: 1 } },
      { tier: 'approved', kind: 'concept' },
      { tier: 'source_evidence', kind: 'source_chunk' },
    ]
    expect(searchMeasuresEvidence(response)).toBe(true)
    expect(searchMeasuresEvidence(response.filter((hit) => hit.tier === 'approved'))).toBe(true)
  })
})

describe('the limit the console asks for', () => {
  test('is one the endpoint accepts', () => {
    // `limit` applies per tier, so this is 25 approved plus 25 source excerpts.
    expect(zSearchQuery.parse({ q: 'anything', limit: RESULT_LIMIT }).limit).toBe(RESULT_LIMIT)
  })

  test('is at or below the server’s maximum, which is where the note comes from', () => {
    // Deliberately not equal to it: 50 is allowed and 25 is asked for, because
    // a ranked list is refined with different words rather than more rows (see
    // search.logic.ts). What is NOT allowed is asking for more than the server
    // gives and then printing the count as though it were complete.
    expect(() => zSearchQuery.parse({ q: 'anything', limit: 51 })).toThrow()
    expect(RESULT_LIMIT).toBeLessThanOrEqual(50)
  })
})
