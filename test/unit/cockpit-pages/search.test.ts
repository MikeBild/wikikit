// What the search page may claim about how many hits there are.
//
// "25 hits on pages a human reviewed and published" is a count that reads as a
// total. At exactly the limit it is not one — it is the top of a ranking whose
// remainder the console never asked for — and a reader who takes it for a total
// concludes the wiki holds nothing else on the subject. That conclusion is the
// opposite of what a knowledge base is for.
import { describe, expect, test } from 'bun:test'
import { RESULT_LIMIT, resultCeilingNote } from '../../../apps/cockpit/src/pages/search.logic.ts'
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
