// The Guidelines starter — six answerable questions in place of an empty
// textarea.
//
// The guidelines are the single most practical lever a new wiki has: every
// classification and synthesis job reads them, so they decide what gets written
// and how. "Write the rules that guide synthesis" is true and unanswerable,
// which is exactly what makes somebody skip them. The rules below are what keep
// a half-filled first draft from teaching the model something nobody said.
//
// (The console says Guidelines where the API says charter — a label, never a
// contract: the route, the facade call and every data-testid stay `charter`.)
import { describe, expect, test } from 'bun:test'
import {
  composeGuidelines,
  EMPTY_GUIDELINES,
  guidelinesStarted,
  GUIDELINES_FIELDS,
  type GuidelinesDraft,
  type GuidelinesField,
} from '../../../apps/cockpit/src/pages/charter.logic.ts'

const HEADINGS: Record<GuidelinesField, string> = {
  purpose: 'Purpose',
  belongs: 'What belongs here',
  excluded: 'What does not',
  pageTypes: 'Page types',
  emphasis: 'Emphasis',
  voice: 'Voice',
}

describe('the six questions', () => {
  test('the order they are asked in is the order they compose in', () => {
    expect([...GUIDELINES_FIELDS]).toEqual(['purpose', 'belongs', 'excluded', 'pageTypes', 'emphasis', 'voice'])
    expect(Object.keys(EMPTY_GUIDELINES).sort()).toEqual([...GUIDELINES_FIELDS].sort())
    expect(Object.values(EMPTY_GUIDELINES).every((value) => value === '')).toBe(true)
  })

  test('an untouched form has not been started, and one answer starts it', () => {
    expect(guidelinesStarted(EMPTY_GUIDELINES)).toBe(false)
    expect(guidelinesStarted({ ...EMPTY_GUIDELINES, voice: '   ' })).toBe(false)
    expect(guidelinesStarted({ ...EMPTY_GUIDELINES, voice: 'Plain sentences.' })).toBe(true)
  })
})

describe('composing the document', () => {
  const draft: GuidelinesDraft = {
    ...EMPTY_GUIDELINES,
    purpose: 'What this team knows about its product.',
    voice: '  Plain sentences, no marketing.  ',
  }

  test('a section with nothing in it is LEFT OUT, not emitted empty', () => {
    // Half-filled is the normal state of a first draft, and a document full of
    // headings followed by nothing teaches the model that this wiki has no
    // opinion about those things — a different claim from not having said yet.
    const markdown = composeGuidelines(draft, HEADINGS)
    expect(markdown).toContain('## Purpose')
    expect(markdown).toContain('## Voice')
    expect(markdown).not.toContain('## What belongs here')
    expect(markdown).not.toContain('## Emphasis')
  })

  test('the answers are trimmed and the sections keep the asked order', () => {
    const markdown = composeGuidelines(draft, HEADINGS)
    expect(markdown).toContain('Plain sentences, no marketing.\n')
    expect(markdown.indexOf('## Purpose')).toBeLessThan(markdown.indexOf('## Voice'))
  })

  test('an empty form composes to an empty document, not to a skeleton', () => {
    // The form seeds the ordinary editor rather than saving, so "nothing typed"
    // has to mean nothing written — a skeleton of headings would be saved by the
    // next click as though it were an opinion.
    expect(composeGuidelines(EMPTY_GUIDELINES, HEADINGS)).toBe('')
  })

  test('the headings are the CALLER’s, so a German wiki gets German headings', () => {
    // This console is localized, and guidelines carrying English headings in a
    // German wiki read as though they were written for somebody else.
    const german = composeGuidelines(draft, { ...HEADINGS, purpose: 'Zweck', voice: 'Stimme' })
    expect(german).toContain('## Zweck')
    expect(german).toContain('## Stimme')
    expect(german).not.toContain('## Purpose')
  })
})
