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
import { pageEvidence } from '../../../apps/cockpit/src/pages/page.logic.ts'
import { RESULT_LIMIT, hitEvidence, resultCeilingNote } from '../../../apps/cockpit/src/pages/search.logic.ts'
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
