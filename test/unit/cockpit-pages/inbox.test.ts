// The Inbox's rules — the one page in this console that turns ONE gesture into
// MANY requests.
//
// Everything here guards the same asymmetry: a folder dropped on this page is
// cheap to drop and expensive to process. Every file becomes its own ingest,
// which is one classify call plus a synthesis call per page it touches, plus a
// change proposal a human has to decide. So the page refuses what it can refuse
// for free, stops when the server says the wiki has had enough, and reports what
// happened to every single item — including the ones that never went.
import { describe, expect, test } from 'bun:test'
import {
  DOCUMENT_ACCEPT,
  DOCUMENT_EXTENSIONS,
  extensionOf,
  fileProblem,
  haltsRun,
  pendingSubmission,
  planUrls,
  tally,
  type Submission,
} from '../../../apps/cockpit/src/pages/inbox.logic.ts'

describe('what this console will accept as a document', () => {
  test('the list is the extractor’s, and the accept attribute is the same list', () => {
    // The server's EXT_FORMAT stays the real gate (it answers 415
    // unsupported_document); this is the courtesy copy that saves a round trip.
    expect([...DOCUMENT_EXTENSIONS].sort()).toEqual(['csv', 'docx', 'markdown', 'md', 'pdf', 'txt', 'xlsx'])
    for (const extension of DOCUMENT_EXTENSIONS) expect(DOCUMENT_ACCEPT).toContain(`.${extension}`)
  })

  test('an extension is read off the name, case-folded, and a dotfile has none', () => {
    expect(extensionOf('notes.PDF')).toBe('pdf')
    expect(extensionOf('/tmp/reports/q3.final.docx')).toBe('docx')
    expect(extensionOf('C:\\docs\\q3.xlsx')).toBe('xlsx')
    expect(extensionOf('README')).toBe('')
    expect(extensionOf('.gitignore')).toBe('') // a leading dot is not an extension
  })

  test('a screenshot is refused before it is uploaded, and the refusal names the way out', () => {
    // Said before the upload because the cost is asymmetric: a drop of thirty
    // files where four are screenshots would otherwise spend four uploads to be
    // told four times that a .png has no text in it.
    const problem = fileProblem({ name: 'screenshot.png', size: 4096 })
    expect(problem).toContain('.png')
    expect(problem).toContain('pdf')
  })

  test('an empty file is refused as empty rather than as the wrong type', () => {
    expect(fileProblem({ name: 'empty.md', size: 0 })).toBe('This file is empty.')
  })

  test('a readable file has no problem at all — null, not an empty string', () => {
    expect(fileProblem({ name: 'q3.pdf', size: 1024 })).toBeNull()
  })
})

describe('a column of addresses pasted into the box', () => {
  test('addresses keep their pasted order and lose their duplicates', () => {
    // Deduplicated here rather than left to the content hash. The server WOULD
    // dedup — the second ingest answers already_ingested — but it would fetch
    // the page again to find that out, and a pasted list is exactly where the
    // same address appears twice.
    const plan = planUrls(
      ['https://example.test/b', '', '  https://example.test/a  ', 'https://example.test/b'].join('\n'),
    )
    expect(plan.urls).toEqual(['https://example.test/b', 'https://example.test/a'])
    expect(plan.rejected).toEqual([])
  })

  test('anything that is not http(s) is kept back VERBATIM so the operator sees which line', () => {
    // The worker rejects every other scheme outright — a file: ingest would read
    // the server's own disk — so a ftp:// paste can only come back as a failed
    // job minutes later, in a list of forty others.
    const plan = planUrls(
      ['ftp://example.test/x', 'file:///etc/passwd', 'just some words', 'https://example.test/ok'].join('\n'),
    )
    expect(plan.urls).toEqual(['https://example.test/ok'])
    expect(plan.rejected).toEqual(['ftp://example.test/x', 'file:///etc/passwd', 'just some words'])
  })

  test('blank lines are neither submitted nor complained about', () => {
    expect(planUrls('\n\n   \n')).toEqual({ urls: [], rejected: [] })
  })
})

describe('a bulk run reports every item, including the ones that never went', () => {
  test('an item starts named, unsent and undecided — pending is a state, not a null', () => {
    // An operator who drops thirty files must be able to see that the
    // twenty-ninth has not been sent YET, which is a different fact from a
    // twenty-ninth that failed.
    expect(pendingSubmission('k1', 'q3.pdf')).toEqual({
      key: 'k1',
      label: 'q3.pdf',
      state: 'pending',
      ingestId: null,
      refusal: null,
      code: null,
    })
  })

  test('exactly one refusal stops the run: the one that is about the WIKI', () => {
    // ingest_queue_full is a statement about the wiki, not about the item, so
    // pushing the remaining twenty-nine at it would collect twenty-nine copies
    // of one sentence and pay for twenty-nine discarded extractions. An
    // unreadable pdf or a URL that 404s is about one item, and the rest still
    // deserve their turn.
    expect(haltsRun('ingest_queue_full')).toBe(true)
    expect(haltsRun('unsupported_document')).toBe(false)
    expect(haltsRun('already_ingested')).toBe(false)
    expect(haltsRun('rate_limited')).toBe(false) // a neighbouring 429, and NOT this one
    expect(haltsRun(null)).toBe(false)
  })

  test('the tally counts what got in, what did not, and what never went', () => {
    const items: Submission[] = [
      { key: '1', label: 'a.pdf', state: 'queued', ingestId: 'job-1', refusal: null, code: null },
      { key: '2', label: 'b.pdf', state: 'queued', ingestId: 'job-2', refusal: null, code: null },
      { key: '3', label: 'c.png', state: 'refused', ingestId: null, refusal: 'no text in it', code: 'unsupported' },
      { key: '4', label: 'd.pdf', state: 'sending', ingestId: null, refusal: null, code: null },
      { key: '5', label: 'e.pdf', state: 'pending', ingestId: null, refusal: null, code: null },
    ]
    // In flight and not yet started are one number to the reader — both mean
    // "no outcome for this item" — while queued and refused are outcomes.
    expect(tally(items)).toEqual({ queued: 2, refused: 1, pending: 2 })
  })

  test('an empty run tallies zeroes rather than nothing', () => {
    expect(tally([])).toEqual({ queued: 0, refused: 0, pending: 0 })
  })
})
