// The Answers page's rules — one list holding three things the database calls
// one thing.
//
// An answer somebody asked for, a briefing the scheduler wrote overnight and a
// care report from the same worker all live in wk_outputs. Keeping them in one
// list is the point: "what did this system tell me" is one question, and
// splitting it across three pages is how the two nobody asked for become
// invisible. The cost is that one row has to carry three shapes, and the two
// rules below are what stop that from turning into a lie about a briefing.
import { describe, expect, test } from 'bun:test'
import {
  coverageOf,
  filingStanding,
  kindWord,
  outputLabel,
  OUTPUT_KINDS,
  promotable,
  type OutputRow,
} from '../../../apps/cockpit/src/pages/answers.logic.ts'

const answer = (over: Partial<OutputRow> = {}): OutputRow => ({
  kind: 'answer',
  title: 'What is WikiKit?',
  question: 'What is WikiKit?',
  citations: [{ slug: 'wikikit', title: 'WikiKit' }],
  not_in_knowledge_base: false,
  promoted_ingest_id: null,
  ...over,
})

describe('the three kinds, in the reader’s words', () => {
  test('the kind alphabet matches the column’s CHECK', () => {
    expect([...OUTPUT_KINDS]).toEqual(['answer', 'briefing', 'health'])
  })

  test('health is called a care report, because the page it belongs to is called Care', () => {
    // A console that names one thing twice makes the reader work out that they
    // are the same thing.
    expect(kindWord('answer')).toBe('Answer')
    expect(kindWord('briefing')).toBe('Briefing')
    expect(kindWord('health')).toBe('Care report')
  })

  test('a kind from a newer server prints ITSELF rather than being folded in', () => {
    // A word this bundle does not know is still a word the server means, and
    // inventing a nicer one for it hides a vocabulary drift.
    expect(kindWord('digest')).toBe('digest')
  })
})

describe('null is not false — the rule that keeps a briefing honest', () => {
  test('an answer the wiki covered, and one it did not, are both measurements', () => {
    expect(coverageOf(answer({ not_in_knowledge_base: false }))).toBe('covered')
    expect(coverageOf(answer({ not_in_knowledge_base: true }))).toBe('not-covered')
  })

  test('a briefing is neither: nobody asked it anything', () => {
    // not_in_knowledge_base is null on a briefing because the question was never
    // asked, NOT because the wiki knew the answer. Rendering that as "covered"
    // would be the console inventing a measurement (CUI-SEV-2).
    expect(coverageOf(answer({ kind: 'briefing', question: null, not_in_knowledge_base: null }))).toBe('unknown')
    expect(coverageOf(answer({ kind: 'health', question: null, not_in_knowledge_base: null }))).toBe('unknown')
  })

  test('a null on an ANSWER is still unknown, not covered', () => {
    // An older row written before the flag existed. Guessing "covered" would
    // claim a measurement nobody made.
    expect(coverageOf(answer({ not_in_knowledge_base: null }))).toBe('unknown')
  })

  test('the three readings are three distinct values', () => {
    const readings = new Set([
      coverageOf(answer({ not_in_knowledge_base: false })),
      coverageOf(answer({ not_in_knowledge_base: true })),
      coverageOf(answer({ not_in_knowledge_base: null })),
    ])
    expect(readings.size).toBe(3)
  })
})

describe('what a row is recognised by', () => {
  test('an answer is its question; a briefing is its title', () => {
    // The person who asked will scan for the question they asked.
    expect(outputLabel(answer(), 'untitled')).toBe('What is WikiKit?')
    expect(outputLabel(answer({ kind: 'briefing', title: 'Briefing 2026-07-15', question: null }), 'untitled')).toBe(
      'Briefing 2026-07-15',
    )
  })

  test('a blank field falls through to the other one before the fallback', () => {
    expect(outputLabel(answer({ question: '   ' }), 'untitled')).toBe('What is WikiKit?')
    expect(outputLabel(answer({ question: null, title: '' }), 'untitled')).toBe('untitled')
  })

  test('the fallback is the caller’s word, so this module never names what it cannot', () => {
    expect(outputLabel(answer({ question: '', title: '' }), 'Ohne Titel')).toBe('Ohne Titel')
  })
})

describe('whether a row has been filed back into the wiki', () => {
  test('promoted_ingest_id is the whole answer — the state is derived, not stored', () => {
    // Promotion opens an ingest job and writes its id here; re-promoting returns
    // the FIRST job, so the field is set exactly once and never cleared.
    expect(filingStanding(answer({ promoted_ingest_id: 'job-1' }))).toEqual({ label: 'In the wiki', tone: 'success' })
  })

  test('an answer nobody filed is not a FAILURE — it is an answer nobody filed', () => {
    // Deliberately the unknown tone rather than danger: visibly present,
    // visibly not a verdict.
    expect(filingStanding(answer())).toEqual({ label: 'Not filed', tone: 'unknown' })
  })

  test('the promote action is offered exactly while there is something to do', () => {
    expect(promotable(answer())).toBe(true)
    expect(promotable(answer({ promoted_ingest_id: 'job-1' }))).toBe(false)
  })
})
