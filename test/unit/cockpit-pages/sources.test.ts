// The sources page's rules — chiefly what an ingest job is told to have done.
//
// Adding documents is how a wiki grows, and the sentence at the end of a job is
// where an operator forms their belief about what just happened. Two of those
// sentences are the whole product: "done, and nothing is visible yet" and
// "paused, and nothing is wrong". Getting either backwards sends somebody away
// believing they published knowledge they did not, or chasing a failure that
// did not occur.
import { describe, expect, test } from 'bun:test'
import { isTerminalStatus, TERMINAL_STATUSES } from '../../../apps/cockpit/src/lib/live.ts'
import {
  defaultSourceView,
  describeIngest,
  EMPTY_INGEST_DRAFT,
  ingestBody,
  ingestProblem,
  sourceLabel,
  STREAM_CAP_NOTE,
  STREAM_CEILING,
} from '../../../apps/cockpit/src/pages/sources.logic.ts'
import { zSourceStreamListQuery } from '../../../src/http/schemas.ts'

describe('when to stop polling', () => {
  test('the terminal set is the database’s vocabulary, not an invented one', () => {
    // wk_ingest_jobs.status ∈ queued | running | done | failed | quota_blocked
    // (migration 0008). A status this console polls forever is a spinner that
    // never stops; one it stops on too early is a job whose result never
    // appears.
    expect(isTerminalStatus('done')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(true)
    expect(isTerminalStatus('queued')).toBe(false)
    expect(isTerminalStatus('running')).toBe(false)
  })

  test('quota_blocked is NOT terminal — the worker requeues it by itself', () => {
    // It reads terminal and is not: the job is parked with a resume_at and the
    // pipeline flips it back to queued. Treating it as terminal strands an
    // operator on "blocked" for a job that finished overnight.
    expect(isTerminalStatus('quota_blocked')).toBe(false)
    expect(TERMINAL_STATUSES).not.toContain('quota_blocked')
  })

  test('an unknown status keeps the job moving rather than declaring it finished', () => {
    // A server newer than this bundle. Guessing "finished" would hide a job
    // that is still running; guessing "running" costs one poll.
    expect(isTerminalStatus('something_new')).toBe(false)
    expect(isTerminalStatus(null)).toBe(false)
    expect(isTerminalStatus(undefined)).toBe(false)
  })
})

describe('what an ingest job is reported to have done', () => {
  const job = (over: Partial<Parameters<typeof describeIngest>[0]>) =>
    describeIngest({ status: 'queued', proposal_id: null, error: null, ...over })

  test('a finished job says the pages are NOT knowledge yet, and where they are', () => {
    // The sentence that carries the product. Without it an operator walks away
    // believing they published something.
    const report = job({ status: 'done', proposal_id: 'p-1' })
    expect(report.reviewable).toBe(true)
    expect(report.detail).toMatch(/Changes/)
    expect(report.detail).toMatch(/not visible knowledge|until somebody approves/i)
  })

  test('a finished job with nothing new does not read as a failure', () => {
    // A valid, common outcome: the document was archived and said nothing the
    // wiki did not already hold. Shown as bare "done" it sends somebody
    // hunting through an empty review queue.
    const report = job({ status: 'done', proposal_id: null })
    expect(report.reviewable).toBe(false)
    expect(report.headline).not.toMatch(/fail/i)
    expect(report.detail).toMatch(/archived/i)
  })

  test('a quota pause says nothing failed and nothing is required', () => {
    const report = job({ status: 'quota_blocked' })
    expect(report.reviewable).toBe(false)
    expect(report.detail).toMatch(/Nothing failed/i)
    expect(report.detail).toMatch(/by itself|reopens/i)
  })

  test('a failure carries the worker’s own words, not a rewrite of them', () => {
    const report = job({ status: 'failed', error: { code: 'extract_failed', message: 'unsupported PDF' } })
    expect(report.detail).toContain('unsupported PDF')
    expect(report.detail).toContain('extract_failed')
  })

  test('a failure with no reason says so instead of inventing one', () => {
    expect(job({ status: 'failed' }).detail).toMatch(/did not say/i)
  })

  test('a status this console cannot read names it rather than guessing', () => {
    const report = job({ status: 'teleporting' })
    expect(report.detail).toContain('teleporting')
    expect(report.reviewable).toBe(false)
  })

  test('only a job with a change to review is reviewable', () => {
    for (const status of ['queued', 'running', 'quota_blocked', 'failed']) {
      expect(job({ status, proposal_id: 'p-1' }).reviewable, status).toBe(false)
    }
  })
})

describe('what stops a document from being submitted', () => {
  test('the empty draft cannot be submitted', () => {
    expect(ingestProblem(EMPTY_INGEST_DRAFT)).toBeString()
  })

  test('a link is refused here when its scheme could never work', () => {
    // The worker refuses every scheme but http(s) outright — file: and data:
    // would let an ingest read the server's own disk — so an `ftp://` paste
    // can only ever come back as a failed job minutes later.
    expect(ingestProblem({ ...EMPTY_INGEST_DRAFT, transport: 'url', content: 'ftp://example.test/doc' })).toBeString()
    expect(ingestProblem({ ...EMPTY_INGEST_DRAFT, transport: 'url', content: 'https://example.test/doc' })).toBeNull()
  })

  test('the refusal for a missing link asks for a link, not for a document', () => {
    // The server's own words here are "exactly one of markdown|text|url is
    // required", which is a sentence about the wire format and not about the
    // thing the operator did.
    expect(ingestProblem({ ...EMPTY_INGEST_DRAFT, transport: 'url' })).toMatch(/address/i)
    expect(ingestProblem({ ...EMPTY_INGEST_DRAFT, transport: 'markdown' })).toMatch(/paste/i)
  })

  test('a markdown draft needs content', () => {
    expect(ingestProblem({ ...EMPTY_INGEST_DRAFT, transport: 'markdown', content: '   ' })).toBeString()
    expect(ingestProblem({ ...EMPTY_INGEST_DRAFT, transport: 'markdown', content: '# Doc' })).toBeNull()
  })

  test('the body carries exactly one transport key', () => {
    // A body carrying two is one the server has to guess about, and a guess in
    // an ingest is a source archived from the wrong place.
    const url = ingestBody({ ...EMPTY_INGEST_DRAFT, transport: 'url', content: 'https://example.test/doc' })
    expect(url).toEqual({ url: 'https://example.test/doc' })

    const markdown = ingestBody({ ...EMPTY_INGEST_DRAFT, transport: 'markdown', content: '# Doc' })
    expect(markdown).toEqual({ markdown: '# Doc' })
  })

  test('an optional field left blank is absent, not empty', () => {
    // `title: ''` is not the same fact as no title, and the server stores what
    // it is given.
    const body = ingestBody({ ...EMPTY_INGEST_DRAFT, content: '# Doc', title: '  ' })
    expect('title' in body).toBe(false)
    expect('source_kind' in body).toBe(false)
    expect('language' in body).toBe(false)
  })

  test('the content is trimmed, so one document does not fork the archive', () => {
    // WikiKit dedups a source by the sha256 of exactly these bytes: the same
    // paste with and without a trailing newline would otherwise become two
    // archived copies of one document, each cited separately.
    expect(ingestBody({ ...EMPTY_INGEST_DRAFT, content: '\n# Doc\n\n' })).toEqual(
      ingestBody({ ...EMPTY_INGEST_DRAFT, content: '# Doc' }),
    )
  })
})

describe('reading a source', () => {
  test('a markdown source opens rendered; anything else opens verbatim', () => {
    // A source is evidence. For text that is not markdown, rendering it would
    // be the console deciding what it means — and the verbatim bytes are the
    // thing every citation points at.
    expect(defaultSourceView('markdown')).toBe('rendered')
    expect(defaultSourceView('text')).toBe('verbatim')
    expect(defaultSourceView('import')).toBe('verbatim')
  })

  test('a source with no title is named by something a human can act on', () => {
    // Never a bare uuid where a url exists: the url is what somebody
    // recognises and can open.
    expect(sourceLabel({ title: 'Handbook', url: 'https://example.test/h', id: 'abc' })).toBe('Handbook')
    expect(sourceLabel({ title: null, url: 'https://example.test/h', id: 'abc' })).toContain('example.test')
    expect(sourceLabel({ title: null, url: null, id: 'abc' })).toContain('abc')
  })
})

// The connector streams list is the only table in this console whose ceiling
// hides a CONTROL. Forget lives in a stream's row, so a stream the read never
// returned cannot be stopped from here — and until this fix, nothing on the
// page said the read had a ceiling at all: the request named no limit, which
// `listStreams` reads as fifty.
describe('how many connector streams the page asks for', () => {
  test('it asks for the endpoint’s own maximum, not the default it would get for free', () => {
    // The schema is the contract. If the endpoint's maximum ever rises, this
    // fails and the console is told to come and take the rest.
    expect(zSourceStreamListQuery.parse({ limit: STREAM_CEILING }).limit).toBe(STREAM_CEILING)
    expect(() => zSourceStreamListQuery.parse({ limit: STREAM_CEILING + 1 })).toThrow()
  })

  test('it asks for more than the fifty a limit-less request would return', () => {
    // `listStreams` calls clampLimit(args.limit, 50, 200): naming no limit is
    // not "everything", it is fifty, silently.
    expect(STREAM_CEILING).toBeGreaterThan(50)
  })

  test('the caveat names the ceiling and the control that goes missing past it', () => {
    expect(STREAM_CAP_NOTE).toContain(String(STREAM_CEILING))
    expect(STREAM_CAP_NOTE).toContain('forgotten')
  })
})
