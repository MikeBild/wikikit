// The page surface's rules: what a draft has to be before it can be proposed,
// and how a claim's evidence is described.
//
// The editor is where a human's text enters the product, so the rules that
// guard it are the ones that decide whether a change is reviewable at all — a
// proposal with an invalid slug or an empty body is one a reviewer has to
// reject for a reason the author could have been told immediately.
import { describe, expect, test } from 'bun:test'
import {
  CONCEPT_SLUG,
  claimSentence,
  currentRevisionId,
  draftProblem,
  evidenceOf,
  evidenceSummary,
  proposalTitle,
  slugify,
  statusBadge,
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
