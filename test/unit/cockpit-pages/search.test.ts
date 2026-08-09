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

// Why a search hit draws the em dash — and why the two reasons may never become
// one sentence.
//
// A concept hit arrives without counts for two unrelated reasons:
//
//   (a) the page is a REFERENCE TARGET — a row an import created so reviewed
//       relations had somewhere to land, whose own body says the knowledge lives
//       on the pages it points at. The server declines to measure it. Nothing is
//       pending, nothing is broken, there is no ingest to run.
//   (b) the RESPONSE measured nothing — a tab that outlived a rolling upgrade,
//       answered by a build that predates the counts. Nothing here is known
//       about any page, and the next reload fixes it.
//
// The two used to be told apart by INFERENCE: the console read the whole
// response, decided whether it looked like a measuring build, and described
// every bare hit accordingly. That worked and was still the wrong shape — the
// server knows why it is not measuring, and a client reconstructing a reason
// from an absence will eventually reconstruct the wrong one. It already did: a
// half-answered row in a measuring response was confidently called a reference
// target.
//
// So the hit now SAYS it. `not_measured.reason` is the answer, read from the row
// rather than deduced from its neighbours, and these tests are what keeps the
// two readings apart.
describe('the dash on a search hit', () => {
  const backedCounts = { claims: 12, uncited_claims: 2, sources: 4 }
  const REFERENCE = { reason: 'reference_target' } as const

  test('a reference target says what the PAGE is, not what the response failed to do', () => {
    // The defect this replaced: a hit that read "This list came back without
    // evidence counts" on a screen whose other cards were printing them.
    const target = hitEvidence({ tier: 'approved', kind: 'concept', not_measured: REFERENCE })
    expect(target?.level).toBe('reference')
    expect(rendersAsDash(target!.level)).toBe(true)
    expect(target?.reading).toMatch(/reference target/i)
    expect(target?.reading).toMatch(/not measured/i)
    // And never the other sentence, in any wording: "the counts did not arrive"
    // is a statement about a response, and this one answered fine.
    expect(target?.reading).not.toMatch(/did not arrive/i)
  })

  test('a hit carrying neither field says only what is certain', () => {
    // The old build's shape: no counts, no reason. The console may not invent a
    // property of a page out of an absence, so it describes the absence.
    const unknown = hitEvidence({ tier: 'approved', kind: 'concept' })
    expect(unknown?.level).toBe('unmeasured')
    expect(rendersAsDash(unknown!.level)).toBe(true)
    expect(unknown?.reading).not.toMatch(/reference target/i)
  })

  test('a reference target holding claims says how much is being kept out', () => {
    // The gap this release closes. The marker keeps a real count out of the
    // index; the index used to be silent about that, so a reader had to open the
    // lint report to learn a number existed at all.
    const withheld = hitEvidence({
      tier: 'approved',
      kind: 'concept',
      not_measured: { reason: 'reference_target', withheld_claims: 7 },
    })
    expect(withheld?.level).toBe('reference_withheld')
    expect(withheld?.detail).toBe('7 claims not counted')
    expect(rendersAsDash(withheld!.level)).toBe(true)
    // Information, not a verdict: no badge and no tone. `scaffolded-claims` owns
    // the judgement that this is a contradiction somebody should resolve.
    expect(withheld?.count).toBeNull()
    expect(withheld?.flag).toBeNull()
    expect(withheld?.tone).toBe('unknown')
  })

  test('the readings are distinct sentences and never collapse into one', () => {
    // Stated as an inequality as well as by content, so a future edit that
    // "unifies the wording" fails here rather than in production.
    const target = hitEvidence({ tier: 'approved', kind: 'concept', not_measured: REFERENCE })
    const unknown = hitEvidence({ tier: 'approved', kind: 'concept' })
    expect(target?.reading).not.toBe(unknown?.reading)
    expect(target?.level).not.toBe(unknown?.level)
    // Both still print nothing — the distinction is in the words, not in a
    // number one of them sneaks in.
    expect(target?.count).toBeNull()
    expect(unknown?.count).toBeNull()
    expect(target?.flag).toBeNull()
    expect(unknown?.flag).toBeNull()
  })

  test('a reason this console has never heard of is still a refusal', () => {
    // A newer server naming a reason this build predates. Saying "reference
    // target" about it would be the old inference wearing the new field's
    // clothes; the console says what is certain and stops.
    const future = hitEvidence({ tier: 'approved', kind: 'concept', not_measured: { reason: 'some-future-reason' } })
    expect(future?.level).toBe('unmeasured')
    expect(future?.reading).not.toMatch(/reference target/i)
  })

  test('a page with real counts prints them, reason field or not', () => {
    const backed = hitEvidence({ tier: 'approved', kind: 'concept', evidence: backedCounts })
    expect(backed?.level).toBe('partial')
    expect(backed?.count).toBe('12 claims')
    expect(backed?.detail).toBe('4 sources')
    expect(rendersAsDash(backed!.level)).toBe(false)
  })

  test('a measured zero is a fact and prints as one — never the dash (CUI-SEV-2)', () => {
    // The page written by hand through the console: it makes no claims, and
    // saying so is the single most useful thing this line does. Drawing the dash
    // for it would put it back among the pages nobody measured.
    const zero = hitEvidence({
      tier: 'approved',
      kind: 'concept',
      evidence: { claims: 0, uncited_claims: 0, sources: 0 },
    })
    expect(zero?.level).toBe('none')
    expect(rendersAsDash(zero!.level)).toBe(false)
    expect(zero?.flag).toBe('No claims')

    // And a measured zero inside a page that does make claims is printed as the
    // digit it is.
    const nothingBehindIt = hitEvidence({
      tier: 'approved',
      kind: 'concept',
      evidence: { claims: 4, uncited_claims: 4, sources: 0 },
    })
    expect(rendersAsDash(nothingBehindIt!.level)).toBe(false)
    expect(nothingBehindIt?.detail).toBe('0 sources')
    expect(nothingBehindIt?.count).toBe('4 claims')
  })

  test('a server contradicting itself is refused rather than obeyed', () => {
    // Both fields on one hit is a server saying two things. Honouring the
    // refusal is the conservative resolution: the marker is the deployment's
    // statement that the row is not a knowledge page, and printing the
    // measurement anyway would override it on the strength of numbers the
    // deployment asked not to show.
    const both = hitEvidence({ tier: 'approved', kind: 'concept', evidence: backedCounts, not_measured: REFERENCE })
    expect(both?.level).toBe('reference')
    expect(both?.count).toBeNull()
  })

  test('claim and source-chunk hits draw nothing at all', () => {
    // A third reason for silence, and it is neither of the two above: the three
    // numbers do not answer the question a claim hit raises, and a source chunk
    // is not approved knowledge at all. Both draw NOTHING — not a dash, not a
    // sentence — whatever they carry.
    expect(hitEvidence({ tier: 'approved', kind: 'claim' })).toBeNull()
    expect(hitEvidence({ tier: 'approved', kind: 'claim', evidence: backedCounts })).toBeNull()
    expect(hitEvidence({ tier: 'approved', kind: 'claim', not_measured: REFERENCE })).toBeNull()
    expect(hitEvidence({ tier: 'source_evidence', kind: 'source_chunk' })).toBeNull()
    expect(hitEvidence({ tier: 'source_evidence', kind: 'concept', evidence: backedCounts })).toBeNull()
  })

  test('a hit says the same thing whatever section it was drawn in', () => {
    // The two sections on screen are one answer split for the reader. A page hit
    // must not describe itself differently because of the list it landed in —
    // which is now structural rather than a rule, since nothing outside the hit
    // is consulted at all.
    const hit = { tier: 'approved', kind: 'concept', not_measured: REFERENCE } as const
    const alone = hitEvidence(hit)
    const amongOthers = hitEvidence(hit)
    expect(alone?.level).toBe(amongOthers?.level)
    expect(alone?.reading).toBe(amongOthers?.reading)
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
