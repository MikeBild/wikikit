// The change review page's rules — chiefly the diff, held against the server's.
//
// The console's `lineDiff` is a PORT of the one in src/http/review-page.ts. That
// original is stringified verbatim into the public review page's inline script
// and its bytes are pinned by a test, so it cannot be imported into a browser
// bundle and cannot be changed. Two implementations is the cost of that; this
// file is what makes it survivable.
//
// The failure it prevents is specific and nasty: the reviewer who opens
// `/review/<id>` from an agent's hand-off and the reviewer who opens the
// console see the same proposal marked up differently, and neither has any way
// to tell which one is describing the change they are about to approve.
import { describe, expect, test } from 'bun:test'
import { lineDiff as serverDiff } from '../../../src/http/review-page.ts'
import {
  annotateClaims,
  approvalEffect,
  changeState,
  conceptDiff,
  groupFindings,
  findingsFor,
  isDeferable,
  isMarkdownUnchanged,
  lineDiff,
  proposedBy,
  severityState,
  staleSlugs,
} from '../../../apps/cockpit/src/pages/change.logic.ts'

describe('the diff agrees with the public review page, line for line', () => {
  const CASES: [string, string, string][] = [
    ['an unchanged document', 'alpha\nbeta\ngamma', 'alpha\nbeta\ngamma'],
    ['one line added', 'alpha\ngamma', 'alpha\nbeta\ngamma'],
    ['one line removed', 'alpha\nbeta\ngamma', 'alpha\ngamma'],
    ['a line replaced', 'alpha\nbeta\ngamma', 'alpha\ndelta\ngamma'],
    ['everything replaced', 'one\ntwo', 'three\nfour'],
    ['an empty original', '', 'alpha\nbeta'],
    ['an emptied document', 'alpha\nbeta', ''],
    ['both empty', '', ''],
    ['a moved block', 'a\nb\nc\nd', 'c\nd\na\nb'],
    ['repeated lines', 'x\nx\nx', 'x\nx'],
    ['leading whitespace only', '  a\n  b', '\ta\n\tb'],
    ['a trailing newline', 'alpha\n', 'alpha'],
  ]

  test.each(CASES)('%s', (_name, before, after) => {
    expect(lineDiff(before, after)).toEqual(serverDiff(before, after))
  })

  test('both refuse the same oversized input', () => {
    // Not a performance nicety: an LCS table is O(n·m) in time AND memory, so
    // a pathological pair does not render slowly — it freezes the tab. The two
    // surfaces must fall back at the same point, or one of them hangs.
    const huge = Array.from({ length: 3001 }, (_, index) => `line ${index}`).join('\n')
    expect(lineDiff(huge, huge)).toBeNull()
    expect(serverDiff(huge, huge)).toBeNull()

    const wide = Array.from({ length: 2100 }, (_, index) => `a${index}`).join('\n')
    const wider = Array.from({ length: 2100 }, (_, index) => `b${index}`).join('\n')
    expect(lineDiff(wide, wider)).toBeNull()
    expect(serverDiff(wide, wider)).toBeNull()
  })

  test('a diff of an unchanged document is all context, never empty', () => {
    // An empty array and "nothing changed" would render identically as a blank
    // panel, and a reviewer cannot tell a no-op change from a failed render.
    const diff = lineDiff('alpha\nbeta', 'alpha\nbeta')!
    expect(diff.every((line) => line.op === ' ')).toBe(true)
    expect(diff).toHaveLength(2)
  })
})

describe('what a change is, in a reviewer’s words', () => {
  test('a change somebody sent back reads differently from an untouched one', () => {
    // `changes_requested` is a BOOLEAN, not a sixth status. Rendered as plain
    // "pending" or plain "rejected", a change a reviewer already read and
    // bounced looks exactly like one nobody opened, and the queue stops telling
    // anybody where their attention is still needed.
    expect(changeState('pending', false).flag).toBeNull()
    expect(changeState('pending', true).flag).not.toBeNull()
    expect(changeState('rejected', true).flag?.label).toBeString()
  })

  test('the flag is carried by a WORD, never by colour alone', () => {
    // CUI-A11Y-5. The flag wears the same `blocked` state as `pending`, on
    // purpose — it is not a severity — so a tint could not distinguish it and
    // does not have to.
    const bounced = changeState('pending', true)
    expect(bounced.flag?.state).toBe('blocked')
    expect(bounced.flag?.label.length).toBeGreaterThan(0)
  })

  test('a sent-back change says that acting on it means a fresh change', () => {
    // There is no rebase in WikiKit: request-changes is terminal. A reviewer
    // who expects to edit and re-submit this one will wait forever.
    expect(changeState('pending', true).note).toMatch(/fresh change/)
  })

  test.each([
    ['approved', 'succeeded'],
    ['rejected', 'failed'],
    ['failed', 'failed'],
    ['split', 'unknown'],
  ] as const)('%s reads as %s', (status, state) => {
    expect(changeState(status, false).state).toBe(state)
  })

  test('split is not a failure — the parent’s concepts were dealt out to children', () => {
    expect(changeState('split', false).state).not.toBe('failed')
  })
})

function concept(overrides: Partial<{ slug: string; is_new: boolean; stale: boolean; collides: number }> = {}) {
  const { slug = 'alpha', is_new = false, stale = false, collides = 0 } = overrides
  return {
    slug,
    is_new,
    stale,
    claims: Array.from({ length: collides }, () => ({ collides: true })),
  }
}

describe('the approval confirmation states the exact effect', () => {
  test('it names how many pages, of which kind, into which wiki', () => {
    const effect = approvalEffect(
      { concepts: [concept({ is_new: true }), concept({ slug: 'beta' })], decisions: [], relations_removed: [] },
      'handbook',
    )
    const text = effect.join(' ')
    expect(text).toContain('2 pages')
    expect(text).toContain('handbook')
    expect(text).toContain('1 new, 1 updated')
  })

  test('it warns that approving a collision disputes BOTH sides', () => {
    // The consequence a reviewer cannot see from the diff: their own approval
    // marks an existing, visible claim disputed. If the confirmation does not
    // say it, nothing does.
    const effect = approvalEffect(
      { concepts: [concept({ collides: 2 })], decisions: [], relations_removed: [] },
      'handbook',
    )
    expect(effect.join(' ')).toMatch(/BOTH sides/)
  })

  test('it names a stale base as a likely failure rather than letting the reviewer discover it', () => {
    const effect = approvalEffect(
      { concepts: [concept({ slug: 'alpha', stale: true })], decisions: [], relations_removed: [] },
      'handbook',
    )
    expect(effect.join(' ')).toContain('alpha')
    expect(effect.join(' ')).toMatch(/stale base|FAIL/)
  })

  test('a change that stages nothing still says what approving does', () => {
    // A confirmation that says nothing is a confirmation nobody reads — and
    // this case is real: a removal-only change stages no pages at all.
    const effect = approvalEffect({ concepts: [], decisions: [], relations_removed: [] }, 'handbook')
    expect(effect.length).toBeGreaterThan(0)
    expect(effect.join(' ')).toContain('handbook')
  })

  test('it never prints a count nobody sent', () => {
    const effect = approvalEffect({ concepts: [concept()], decisions: [], relations_removed: [] }, 'handbook').join(' ')
    expect(effect).not.toMatch(/\b0 (claims?|relations?|decisions?)\b/)
  })
})

describe('deferring', () => {
  test('a single-concept change cannot be split', () => {
    // Splitting one concept out of a change containing one concept produces
    // the same change under a new id, which is a button that does nothing and
    // looks like it did something.
    expect(isDeferable('pending', 1)).toBe(false)
    expect(isDeferable('pending', 2)).toBe(true)
  })

  test('a settled change cannot be split', () => {
    expect(isDeferable('approved', 5)).toBe(false)
    expect(isDeferable('rejected', 5)).toBe(false)
    expect(isDeferable('split', 5)).toBe(false)
  })
})

describe('stale bases', () => {
  test('names every concept whose base moved, and nothing else', () => {
    expect(
      staleSlugs([
        { slug: 'alpha', stale: true },
        { slug: 'beta', stale: false },
        { slug: 'gamma', stale: true },
      ]),
    ).toEqual(['alpha', 'gamma'])
  })

  test('an empty list is not a warning', () => {
    expect(staleSlugs([{ slug: 'alpha', stale: false }])).toEqual([])
  })
})

describe('lint findings', () => {
  test('group by concept, and a concept with none gets none', () => {
    const groups = groupFindings([{ concept_slug: 'alpha' }, { concept_slug: 'alpha' }, { concept_slug: 'beta' }])
    expect(findingsFor(groups, 'alpha')).toHaveLength(2)
    expect(findingsFor(groups, 'gamma')).toHaveLength(0)
  })

  test.each([
    ['error', 'failed'],
    ['warning', 'blocked'],
    ['info', 'running'],
  ] as const)('%s reads as %s', (severity, state) => {
    expect(severityState(severity)).toBe(state)
  })

  test('an unknown severity is unmeasured, not fine', () => {
    // Anything else would render a severity nobody recognises in the token
    // that means "healthy".
    expect(severityState('whatever')).toBe('unknown')
  })
})

describe('claims and their evidence', () => {
  const triple = { subject: 'a', predicate: 'is', object: 'b' }

  test('a staged claim the change adds is labelled as added', () => {
    const reviewed = annotateClaims({
      claims: [triple],
      claims_added: [triple],
      claims_disputed: [],
      claims_deprecated: [],
    })
    expect(reviewed.staged[0]?.change).toBe('added')
    expect(reviewed.retired).toEqual([])
  })

  test('a disputed triple with no staged counterpart is surfaced as retired, not dropped', () => {
    // The case a naive render loses entirely: an existing visible claim this
    // change knocks down without ever quoting it. A reviewer must not have to
    // infer that from the diff, because it is not in the diff.
    const reviewed = annotateClaims({
      claims: [],
      claims_added: [],
      claims_disputed: [triple],
      claims_deprecated: [],
    })
    expect(reviewed.staged).toEqual([])
    expect(reviewed.retired).toEqual([{ triple, change: 'disputed' }])
  })

  test('the strongest consequence wins when a triple is in more than one list', () => {
    // Being retired outranks being disputed, which outranks being new — a
    // claim shown as merely "added" while it is also being deprecated would
    // understate exactly the thing a reviewer is deciding on.
    const reviewed = annotateClaims({
      claims: [triple],
      claims_added: [triple],
      claims_deprecated: [triple],
      claims_disputed: [],
    })
    expect(reviewed.staged[0]?.change).toBe('deprecated')
  })
})

describe('who proposed it', () => {
  test('names the model when the metadata carries one', () => {
    expect(proposedBy({ model: 'claude-sonnet-5' })).toContain('claude-sonnet-5')
  })

  test('says so plainly when nothing recorded it', () => {
    // A blank byline reads as "a person did this", which is the one reading
    // that must never be given by default in a product where most changes are
    // synthesised.
    expect(proposedBy(null)).toBeString()
    expect(proposedBy(null).length).toBeGreaterThan(0)
  })
})

describe('one page inside a change', () => {
  test('an unchanged document is reported as unchanged, not as an empty diff', () => {
    const diff = conceptDiff({ is_new: false, old_markdown: 'same\ntext', new_markdown: 'same\ntext' })
    expect(isMarkdownUnchanged(diff)).toBe(true)
  })

  test('a brand-new page is all additions and says it was created', () => {
    const diff = conceptDiff({ is_new: true, old_markdown: null, new_markdown: 'alpha\nbeta' })
    expect(diff.kind).toBe('lines')
    if (diff.kind !== 'lines') throw new Error('expected a line diff')
    expect(diff.created).toBe(true)
    expect(diff.lines.every((line) => line.op === '+')).toBe(true)
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(0)
  })

  test('a page whose base could not be resolved is treated like a new one', () => {
    // Same fact from two directions. Either way there is nothing to subtract
    // from, and rendering an empty diff would tell the reviewer nothing changed.
    const diff = conceptDiff({ is_new: false, old_markdown: null, new_markdown: 'alpha' })
    expect(diff.kind).toBe('lines')
    if (diff.kind !== 'lines') throw new Error('expected a line diff')
    expect(diff.lines).toEqual([{ op: '+', text: 'alpha' }])
  })

  test('an oversized pair falls back to the raw documents instead of freezing the tab', () => {
    const huge = Array.from({ length: 3001 }, (_, index) => `line ${index}`).join('\n')
    const diff = conceptDiff({ is_new: false, old_markdown: huge, new_markdown: `${huge}\nmore` })
    expect(diff.kind).toBe('too-large')
  })
})
