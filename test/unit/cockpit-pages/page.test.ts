// The page surface's rules: what a draft has to be before it can be proposed,
// and how a claim's evidence is described.
//
// The editor is where a human's text enters the product, so the rules that
// guard it are the ones that decide whether a change is reviewable at all — a
// proposal with an invalid slug or an empty body is one a reviewer has to
// reject for a reason the author could have been told immediately.
import { describe, expect, test } from 'bun:test'
import type { ConceptEvidence, ConceptSummary } from '../../../src/domain/concepts.ts'
import {
  CONCEPT_SLUG,
  claimSentence,
  conceptProposalBody,
  currentRevisionId,
  draftProblem,
  evidenceOf,
  evidenceRank,
  evidenceSummary,
  pageEvidence,
  proposalTitle,
  rendersAsDash,
  slugify,
  statusBadge,
  type EvidenceLevel,
} from '../../../apps/cockpit/src/pages/page.logic.ts'

describe('slugs', () => {
  test('the console mirrors the server pattern exactly', () => {
    // The server's zod schema is `^[a-z0-9][a-z0-9-]{0,126}$`. A console that
    // accepted more would let somebody type a whole page and lose it to a 400.
    expect(CONCEPT_SLUG.source).toBe('^[a-z0-9][a-z0-9-]{0,126}$')
  })

  test.each([
    ['Onboarding a new hire', 'onboarding-a-new-hire'],
    ['  Trimmed  ', 'trimmed'],
    ['Über Ähnliches', 'uber-ahnliches'],
    ['C++ and C#', 'c-and-c'],
    ['multiple---dashes', 'multiple-dashes'],
    ['-leading and trailing-', 'leading-and-trailing'],
  ])('%s → %s', (title, slug) => {
    expect(slugify(title)).toBe(slug)
  })

  test('every slug it produces is one the server would accept', () => {
    for (const title of ['A Title', 'ünïcödé', '2026 planning', '!!!', 'a'.repeat(300)]) {
      const slug = slugify(title)
      if (slug) expect(CONCEPT_SLUG.test(slug), `${title} → ${slug}`).toBe(true)
    }
  })
})

describe('what stops a draft from being submitted', () => {
  const draft = { slug: 'onboarding', title: 'Onboarding', summary: 'How', markdown: '# Onboarding\n\nText.' }

  test('a complete new draft has no problem', () => {
    expect(draftProblem(draft, true)).toBeNull()
  })

  test('an empty body is refused, and the reason names the body', () => {
    // Submitting empty markdown creates a change that deletes a page's whole
    // content, which is a thing somebody might mean and never by accident.
    const problem = draftProblem({ ...draft, markdown: '   ' }, false)
    expect(problem).toBeString()
    expect(problem?.toLowerCase()).toMatch(/empty|content|markdown|text/)
  })

  test('a new draft with no slug is refused', () => {
    expect(draftProblem({ ...draft, slug: '' }, true)).toBeString()
  })

  test('an invalid slug is refused before the request, not after it', () => {
    expect(draftProblem({ ...draft, slug: 'Not A Slug' }, true)).toBeString()
    expect(draftProblem({ ...draft, slug: '-leading' }, true)).toBeString()
  })

  test('an existing page does not need a slug typed in — it already has one', () => {
    expect(draftProblem({ ...draft, slug: '' }, false)).toBeNull()
  })
})

describe('the proposal title', () => {
  test('says whether this creates a page or changes one', () => {
    // The title is what a reviewer reads first in the queue, before opening
    // anything. "Create" and "Update" are the two facts they need there.
    expect(proposalTitle({ slug: 'a', title: 'Onboarding', summary: '', markdown: 'x' }, true)).toMatch(
      /create|add|new/i,
    )
    expect(proposalTitle({ slug: 'a', title: 'Onboarding', summary: '', markdown: 'x' }, false)).toMatch(
      /update|change|edit/i,
    )
  })

  test('names the page', () => {
    expect(proposalTitle({ slug: 'onboarding', title: 'Onboarding', summary: '', markdown: 'x' }, false)).toContain(
      'Onboarding',
    )
  })
})

describe('the dedup anchor a change is staged under', () => {
  // `input_hash` is what the server's pending dedup compares (createProposal,
  // src/domain/proposals.ts): a body whose hash matches a pending proposal is
  // NOT staged — the existing proposal comes back instead. So this hash decides
  // when two submissions are the same act, and the base revision is part of
  // that act, not just the text.
  const draft = { slug: 'onboarding', title: 'Onboarding', summary: 'How', markdown: 'Text.' }
  const hashOf = (base: string | null | undefined, over = draft) =>
    conceptProposalBody({ space: 'ops', draft: over, isNew: false, baseRevisionId: base }).input_hash

  test('the same text against a MOVED base is a different change', () => {
    // Somebody edits a page, a reviewer approves a different change to it in
    // the meantime, the author reloads and re-submits their identical text. If
    // the hash ignored the base, the server would hand back the proposal
    // anchored to the revision that is now stale, and no amount of pressing
    // Submit could stage a fresh one — only editing a byte of prose could.
    expect(hashOf('11111111-1111-4111-8111-111111111111')).not.toBe(hashOf('22222222-2222-4222-8222-222222222222'))
  })

  test('pressing submit twice on the same text and the same base still converges', () => {
    // The other half of the promise: idempotent retries must not put two
    // identical items in a reviewer's queue.
    expect(hashOf('11111111-1111-4111-8111-111111111111')).toBe(hashOf('11111111-1111-4111-8111-111111111111'))
  })

  test('an unresolvable base is not the same as no base', () => {
    // `undefined` (the history read failed — the server falls back to its own
    // pointer) and `null` ("written against no revision") are different
    // instructions on the wire, so they must not hash alike.
    expect(hashOf(undefined)).not.toBe(hashOf(null))
  })

  test('changing a single character still stages a new change', () => {
    const base = '11111111-1111-4111-8111-111111111111'
    expect(hashOf(base)).not.toBe(hashOf(base, { ...draft, markdown: 'Text!' }))
  })

  test('the hash follows the base the BODY carries, not the argument', () => {
    // A new page forces the base to null whatever the caller passed, and the
    // anchor has to describe what was sent.
    const asNew = (base: string | null | undefined) =>
      conceptProposalBody({ space: 'ops', draft, isNew: true, baseRevisionId: base })
    expect(asNew('11111111-1111-4111-8111-111111111111').input_hash).toBe(asNew(null).input_hash)
    expect(asNew('11111111-1111-4111-8111-111111111111').concepts).toEqual([
      expect.objectContaining({ base_revision_id: null }),
    ])
  })

  test('the digest is a sha-256 hex digest, which is all the schema accepts', () => {
    expect(hashOf(null)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('evidence', () => {
  test('a claim with no quote is not the same as one with three', () => {
    // The entire product rests on this distinction. If both render alike, a
    // reader cannot tell asserted text from cited knowledge.
    const none = evidenceOf(0)
    const some = evidenceOf(3)
    expect(none.label).not.toBe(some.label)
    expect(none.tone).not.toBe(some.tone)
  })

  test('an uncited claim never wears a token that means verified', () => {
    expect(evidenceOf(0).tone).not.toBe('success')
  })

  test('the summary counts what is cited, not what exists', () => {
    const summary = evidenceSummary([
      { subject: 'a', predicate: 'is', object: 'b', citations: 2 },
      { subject: 'c', predicate: 'is', object: 'd', citations: 0 },
    ] as never)
    expect(summary).toBeString()
    expect(summary.length).toBeGreaterThan(0)
  })
})

describe('the evidence on a row of the pages index', () => {
  // The index now says how the wiki knows what a page claims. `pageEvidence`
  // is the whole rule: three numbers in, one reading out. What is protected
  // here is that the four states stay four — a rule that collapses any two of
  // them turns the column into decoration.
  const backed = pageEvidence({ claims: 4, uncited_claims: 0, sources: 2 })
  const partly = pageEvidence({ claims: 4, uncited_claims: 1, sources: 2 })
  const nothingCited = pageEvidence({ claims: 4, uncited_claims: 4, sources: 0 })
  const noClaims = pageEvidence({ claims: 0, uncited_claims: 0, sources: 0 })
  const unmeasured = pageEvidence({})

  test('the console reads the counts the SERVER actually sends', () => {
    // The one test that spans both halves of this change, and the only place
    // the two field lists ever meet. `listConcepts` builds `ConceptEvidence`;
    // this console parses it. Typing the fixture as the server's own interface
    // means a name that exists on only one side cannot pass: the console falls
    // through to `unmeasured` on every row, the index quietly renders an em
    // dash for a wiki full of cited pages, and nothing else in either suite
    // notices — the server tests pass, the console tests pass, and the feature
    // is invisible in production.
    const fromServer: ConceptEvidence = { claims: 4, uncited_claims: 1, sources: 2 }
    const evidence = pageEvidence(fromServer)
    expect(evidence.level).not.toBe('unmeasured')
    expect(evidence.level).toBe('partial')
    expect(evidence.count).toBe('4 claims')
    expect(evidence.flag).toBe('1 uncited')
  })

  test('fully cited, partly cited and nothing cited are three different readings', () => {
    // Not three tones — their design gives `partial` and all-uncited the same
    // amber on purpose, because the NUMBERS beside it are more precise than
    // any third colour would be. So what has to differ is what a reader
    // actually reads, and it has to differ in every rendered field the cell
    // uses, not just in one that happens to be shown.
    const readings = [backed, partly, nothingCited].map((evidence) => evidence.reading)
    expect(new Set(readings).size).toBe(3)
    expect(new Set([backed.flag, partly.flag, nothingCited.flag]).size).toBe(3)
    expect(backed.flag).toBeNull() // the baseline promise is not an achievement
    expect(partly.flag).toBeString()
    expect(nothingCited.flag).toBeString()
  })

  test('the rank orders them least-backed first, and separates all three', () => {
    // The header sorts on this, so "show me the pages nothing backs" is one
    // click. A rank that tied two of these states would make the sort silently
    // useless exactly where it matters.
    expect(evidenceRank({ claims: 4, uncited_claims: 4, sources: 0 })).toBeLessThan(
      evidenceRank({ claims: 4, uncited_claims: 1, sources: 2 })!,
    )
    expect(evidenceRank({ claims: 4, uncited_claims: 1, sources: 2 })).toBeLessThan(
      evidenceRank({ claims: 4, uncited_claims: 0, sources: 2 })!,
    )
  })

  test('nothing cited never wears a token that means healthy or verified', () => {
    // The product's entire promise is that a claim carries a quote. A page
    // whose claims carry none, and a page that claims nothing at all, must
    // never render in the token a reader has learned to read as "checked" —
    // that would be the interface asserting the opposite of the data.
    for (const evidence of [nothingCited, noClaims, partly]) {
      expect(evidence.tone).not.toBe('success')
      expect(evidence.level).not.toBe('backed')
      expect(evidence.reading.toLowerCase()).not.toContain('every one quoting')
    }
  })

  test('a page with no claims says so, and is not mistaken for a well-backed one', () => {
    // The hand-written page — typed into this console, zero claims by
    // construction — and the state this whole change exists to make visible.
    // It is its own reading, not a quiet `0` that looks like every other row.
    expect(noClaims.level).toBe('none')
    expect(noClaims.count).toBeNull()
    expect(noClaims.flag).toBeString()
    expect(noClaims.reading).not.toBe(backed.reading)
    expect(noClaims.reading).not.toBe(unmeasured.reading)
  })

  test('absent counts read as unknown, and unknown is not zero', () => {
    // CUI-SEV-2. A console talking to a binary that predates these counts gets
    // rows without them, and printing `0 claims` there would invent a
    // measurement — it would accuse a fully cited wiki of citing nothing.
    expect(unmeasured.level).toBe('unmeasured')
    expect(unmeasured.tone).toBe('unknown')
    expect(unmeasured.count).toBeNull()
    // The two must not be interchangeable in ANY field the row uses: the text
    // a reader sees, and the key the sort orders on.
    expect(unmeasured.reading).not.toBe(noClaims.reading)
    expect(unmeasured.rank).toBeNull()
    expect(noClaims.rank).toBe(0)
  })

  test('a HALF-answered row is unknown, not half-measured', () => {
    // The subtle version, and the one a naive `?? 0` gets wrong: `claims`
    // arrived, `uncited_claims` did not. Defaulting the missing one to zero
    // reports "3 claims, every one quoting a source" — a fabricated clean bill
    // of health, which is worse than admitting the column knows nothing.
    expect(pageEvidence({ claims: 3 }).level).toBe('unmeasured')
    expect(pageEvidence({ uncited_claims: 1 }).level).toBe('unmeasured')
    expect(pageEvidence({ claims: 3, uncited_claims: null }).level).toBe('unmeasured')
  })

  test('every state carries a word, never colour alone', () => {
    // CUI-A11Y-5. `reading` is the cell's title and the unmeasured row's only
    // text, so an empty one is a row that says nothing to a screen reader.
    for (const evidence of [backed, partly, nothingCited, noClaims, unmeasured]) {
      expect(evidence.reading.length, evidence.level).toBeGreaterThan(0)
    }
  })

  test('a page nothing backs is not an error either', () => {
    // The other half of "never healthy". Writing a page by hand and leaving it
    // for the ingest to evidence is a thing this console invites an operator to
    // do — nobody failed, nothing broke — so the row must not wear the token
    // that means a request was refused or a claim was disputed. Amber, because
    // the state resolves when a human acts; red would be the console calling a
    // legitimate act a fault, and a list that cries wolf gets scrolled past.
    for (const evidence of [noClaims, nothingCited, partly]) {
      expect(evidence.tone, evidence.level).not.toBe('danger')
    }
  })

  test('the order asks whether the evidence is complete, not how much there is', () => {
    // A wiki is not better because a page asserts more. Three claims with three
    // quotes is a page a reader can check end to end; two hundred claims with
    // one gap is not, and it sorts below — which is also what stops a busy page
    // from burying the small unbacked one at the top of the list.
    const whole = evidenceRank({ claims: 3, uncited_claims: 0, sources: 1 })
    const nearly = evidenceRank({ claims: 200, uncited_claims: 1, sources: 40 })
    expect(whole).toBeGreaterThan(nearly!)
  })

  test('breadth is reported by the server, never derived from the claim counts', () => {
    // Five claims quoting one document and five quoting five are the same
    // number of cited claims and NOT the same knowledge — the second is
    // corroborated, the first rests on one archive entry. That is why the row
    // carries `sources` at all, so the cell prints it rather than computing
    // `claims - uncited_claims` and calling the answer breadth.
    expect(pageEvidence({ claims: 5, uncited_claims: 0, sources: 1 }).detail).toBe('1 source')
    expect(pageEvidence({ claims: 5, uncited_claims: 0, sources: 5 }).detail).toBe('5 sources')
  })

  test('a count the server contradicts itself about is never rendered as fact', () => {
    // More uncited claims than claims, and a negative count, are a server that
    // is wrong about itself. The console prints neither: "13 of 12" is a row an
    // operator would rightly stop believing, and it would sort between the
    // pages nothing backs and the pages something does.
    expect(pageEvidence({ claims: 12, uncited_claims: 13, sources: 0 }).flag).toBe('12 uncited')
    expect(pageEvidence({ claims: -1, uncited_claims: 0, sources: 0 }).level).toBe('unmeasured')
    expect(pageEvidence({ claims: 2.5, uncited_claims: 0, sources: 0 }).level).toBe('unmeasured')
  })
})

describe('a page the wiki does not measure', () => {
  // The server withholds `evidence` for a REFERENCE TARGET — a row an import
  // created so that reviewed relations had somewhere to land, whose own body
  // says the knowledge lives on the pages it points at. It used to report three
  // zeros there, which is the same row a knowledge page that genuinely rests on
  // nothing gets: an operator seeing 11 of 20 pages carrying a stark zero goes
  // to the linter to find out what to do and is told, correctly, that nothing is
  // wrong. The index was measuring a page the measurement does not apply to.
  //
  // What is protected here is the one thing the whole change is for: the
  // withheld measurement and the measured zero must never produce the same
  // output. If they ever collapse, the console is back to the row that sent that
  // operator to the linter — and this time with the linter's agreement.
  // One response, three rows. The reference target is no longer the row with a
  // hole in it — it carries `not_measured`, so the reason travels with the row
  // instead of being reconstructed from its neighbours.
  const referenceTarget = pageEvidence(undefined, { reason: 'reference_target' })
  const handWritten = pageEvidence({ claims: 0, uncited_claims: 0, sources: 0 })

  test('a withheld measurement is a dash and a measured zero is not — the two never collapse', () => {
    // The entire point, in one read. Same response, same absent-looking cell to
    // a careless renderer, two different facts about two different pages.
    expect(rendersAsDash(referenceTarget.level)).toBe(true)
    expect(referenceTarget.level).toBe('reference')
    expect(referenceTarget.count).toBeNull()
    expect(referenceTarget.flag).toBeNull()

    expect(rendersAsDash(handWritten.level)).toBe(false)
    expect(handWritten.level).toBe('none')
    expect(handWritten.flag).toBe('No claims')

    // Not one field they share: the level, the words and the sort key all
    // separate them, because a renderer only has to read one of the three.
    expect(referenceTarget.level).not.toBe(handWritten.level)
    expect(referenceTarget.reading).not.toBe(handWritten.reading)
    expect(referenceTarget.rank).toBeNull()
    expect(handWritten.rank).toBe(0)
  })

  test('a measured zero still prints the digit; a withheld one prints no number at all', () => {
    // The other half of "0 is a fact". `sources: 0` beside four claims is the
    // console saying the archive holds nothing behind them — it is printed, and
    // printed as a digit. The reference target prints neither a digit nor a
    // badge, because there is nothing about it to print.
    const nothingBehindIt = pageEvidence({ claims: 4, uncited_claims: 4, sources: 0 })
    expect(nothingBehindIt.detail).toBe('0 sources')
    expect(nothingBehindIt.count).toBe('4 claims')

    expect(referenceTarget.detail).toBeNull()
    expect(referenceTarget.count).toBeNull()
  })

  test('the dash says WHY, and it says the thing that is actually true of the page', () => {
    // A bare em dash is only marginally better than a wrong zero: the reader
    // still has to leave the list to find out what it means. The sentence names
    // what the page IS — furniture holding a reviewed relation — so that nobody
    // goes looking for an ingest to run or a release to wait for.
    expect(referenceTarget.reading).toMatch(/reference target/i)
    expect(referenceTarget.reading).toMatch(/relations/i)
    expect(referenceTarget.reading).toMatch(/not measured/i)
    // And it must not be readable as a defect: this page is not missing its
    // evidence, it has none to miss.
    expect(referenceTarget.tone).not.toBe('danger')
    expect(referenceTarget.tone).not.toBe('success')
  })

  test('the two absences are two sentences, never one', () => {
    // Both draw the dash, and a reader who is shown a dash is owed the reason
    // for it. "The counts did not arrive" tells an operator to wait; "this page
    // is a reference target" tells them there is nothing to wait for.
    const noCountsAtAll = pageEvidence(undefined)
    expect(noCountsAtAll.level).toBe('unmeasured')
    expect(rendersAsDash(noCountsAtAll.level)).toBe(true)
    expect(noCountsAtAll.reading).not.toBe(referenceTarget.reading)
    expect(noCountsAtAll.reading.length).toBeGreaterThan(0)
    // The vaguer one must never claim the page is a reference target — it is
    // said about a response, not about a page.
    expect(noCountsAtAll.reading).not.toMatch(/reference target/i)
  })

  test('a row carrying no reason at all says only what is certain', () => {
    // A tab loaded from the replaced instance, its next request answered by a
    // build that predates both fields: the row comes back bare. Describing it as
    // a reference target would be the console inventing a property of a page out
    // of an absence — which is exactly what it used to do, by reading the rest of
    // the response and deducing. The reason now travels with the row or not at
    // all.
    expect(pageEvidence(undefined).level).toBe('unmeasured')
    expect(pageEvidence(undefined, null).level).toBe('unmeasured')
  })

  test('one row says the same thing whatever its neighbours did', () => {
    // What replaced the list-level discriminator, and the reason it is gone: a
    // row's reading is a function of the row. No response, no section and no
    // sibling can change it, so the two surfaces cannot drift and a filtered
    // list cannot re-describe a page.
    const row = { reason: 'reference_target' } as const
    expect(pageEvidence(undefined, row).level).toBe(pageEvidence(undefined, row).level)
    expect(pageEvidence(undefined, row).reading).toBe(pageEvidence(undefined, row).reading)
  })

  test('a reason this console has never heard of is still a refusal', () => {
    // A newer server naming a reason this build predates. Calling it a reference
    // target would be the old inference wearing the new field's clothes.
    const future = pageEvidence(undefined, { reason: 'some-future-reason' })
    expect(future.level).toBe('unmeasured')
    expect(future.reading).not.toMatch(/reference target/i)
  })

  test('a half-answered row is unknown, and no longer guessed to be a reference target', () => {
    // The subtle one: `claims` arrived, `uncited_claims` did not. That is not a
    // reference target and it is not a clean bill of health — it is a row nobody
    // can read, and the console says so rather than defaulting the missing half
    // to zero.
    //
    // This assertion INVERTED with the field that made it possible. While the
    // console had to infer the reason for a missing measurement, a half-answered
    // row in a measuring response looked exactly like furniture and was read as
    // `reference` — the inference reaching a confident, wrong conclusion from an
    // absence. Now only `not_measured` produces `reference`, so a row that
    // merely arrived incomplete says the one thing that is certain.
    expect(pageEvidence({ claims: 3 }).level).toBe('unmeasured')
    expect(rendersAsDash(pageEvidence({ claims: 3 }).level)).toBe(true)
  })

  test('exactly the wordless levels draw the dash', () => {
    // The predicate is what every surface asks instead of `=== 'unmeasured'`,
    // and a level that acquired a number while still answering true here would
    // print an empty cell for a page that has something to say.
    //
    // `reference_withheld` is wordless too: its number is the size of what the
    // marker keeps out, never a measurement of the page, so the evidence cell
    // stays a dash and the count rides in the detail line beside it.
    const levels: readonly EvidenceLevel[] = [
      'unmeasured',
      'reference',
      'reference_withheld',
      'none',
      'partial',
      'backed',
    ]
    expect(levels.filter(rendersAsDash)).toEqual(['unmeasured', 'reference', 'reference_withheld'])
  })

  test('the row the SERVER sends is the row the console reads', () => {
    // Typed as the server's own summary, so the two halves of this change cannot
    // drift apart: `listConcepts` builds `ConceptSummary`, leaves `evidence` off
    // a reference target and puts `not_measured` there instead. If either field
    // stopped being optional there, this fixture would not compile.
    //
    // The reason is READ from the row, never inferred from the hole where
    // `evidence` would have been. That is the whole change: the server knows why
    // it is not measuring, so it says it.
    const fromServer: ConceptSummary = {
      slug: 'cadences',
      title: 'Cadences',
      summary: 'This reference page preserves the target of reviewed relations.',
      rev: 1,
      updated_at: '2026-01-01T00:00:00.000Z',
      not_measured: { reason: 'reference_target' },
    }
    expect('evidence' in fromServer).toBe(false)
    expect(pageEvidence(fromServer.evidence, fromServer.not_measured).level).toBe('reference')
  })

  test('a reference target holding claims says so, and still does not measure the page', () => {
    // The gap this release closes. The marker keeps a real count out of the
    // index; until now the index was silent about that, and a reader had to be
    // looking at the lint report to learn a number existed at all.
    const withheld = pageEvidence(undefined, { reason: 'reference_target', withheld_claims: 7 })
    expect(withheld.level).toBe('reference_withheld')
    expect(withheld.detail).toBe('7 claims not counted')
    // Still no measurement and still no verdict: no count in the evidence cell,
    // no badge, no tone. `scaffolded-claims` owns the judgement.
    expect(withheld.count).toBeNull()
    expect(withheld.flag).toBeNull()
    expect(withheld.tone).toBe('unknown')
  })

  test('nothing withheld reads as an ordinary reference target, zero included', () => {
    // A `0` here is nothing being kept out, and printing "0 claims not counted"
    // would re-create precisely the meaningless zero this line of work removed.
    expect(pageEvidence(undefined, { reason: 'reference_target' }).level).toBe('reference')
    expect(pageEvidence(undefined, { reason: 'reference_target', withheld_claims: 0 }).level).toBe('reference')
  })
})

describe('reading a claim', () => {
  test('a triple reads as a sentence', () => {
    expect(claimSentence({ subject: 'WikiKit', predicate: 'stores', object: 'sources verbatim' })).toBe(
      'WikiKit stores sources verbatim',
    )
  })
})

describe('history', () => {
  test('the current revision is the one marked current, not the newest', () => {
    // A page's newest revision may be a proposed one that nobody approved.
    // Naming it "current" would show a reader text that is not visible
    // knowledge.
    expect(
      currentRevisionId([
        { id: 'r3', status: 'proposed', revision: 3 },
        { id: 'r2', status: 'current', revision: 2 },
        { id: 'r1', status: 'superseded', revision: 1 },
      ] as never),
    ).toBe('r2')
  })

  test('a page with no approved revision has no current one', () => {
    expect(currentRevisionId([{ id: 'r1', status: 'proposed', revision: 1 }] as never)).toBeNull()
  })
})

describe('claim status badges', () => {
  test.each([
    ['verified', 'success'],
    ['disputed', 'danger'],
    ['proposed', 'warning'],
    ['deprecated', 'unknown'],
  ] as const)('%s wears %s', (status, tone) => {
    expect(statusBadge(status).tone).toBe(tone)
  })

  test('every badge carries a word, never colour alone', () => {
    for (const status of ['verified', 'disputed', 'proposed', 'deprecated', 'draft']) {
      expect(statusBadge(status).label.length).toBeGreaterThan(0)
    }
  })
})
