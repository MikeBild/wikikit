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
  captureBody,
  capturedDays,
  defaultSourceView,
  describeIngest,
  EMPTY_INGEST_DRAFT,
  ingestBody,
  ingestProblem,
  sourceLabel,
  STALE_CAPTURE_DAYS,
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
    // Settled as far as POLLING goes: only a human triage resolution moves
    // either, and that mutation invalidates the query itself — a poll would be
    // waiting for an event that can only arrive through this console's buttons.
    expect(isTerminalStatus('captured')).toBe(true)
    expect(isTerminalStatus('discarded')).toBe(true)
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
    expect(report.detail).toMatch(/Decisions/)
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

  test('a running job names the stage it is in, so a long wait is not a mystery', () => {
    // The whole point: "running" for twenty minutes looked identical to stuck.
    expect(job({ status: 'running', phase: 'synthesize' }).headline).toMatch(/writing the pages/i)
    expect(job({ status: 'running', phase: 'decisions' }).headline).toMatch(/decisions/i)
    expect(job({ status: 'running', phase: 'propose' }).headline).toMatch(/change/i)
  })

  test('a phase this bundle does not know falls back to the plain sentence', () => {
    // A server newer than the console must not leak a raw enum value at the
    // operator.
    const report = job({ status: 'running', phase: 'some-future-stage' })
    expect(report.headline).toBe('Reading the document')
    expect(report.headline).not.toContain('some-future-stage')
  })

  test('progress is carried only where the server counted it', () => {
    expect(job({ status: 'running', phase: 'synthesize', progress: { done: 3, total: 10 } }).progress).toEqual({
      done: 3,
      total: 10,
    })
    expect(job({ status: 'running', phase: 'classify' }).progress).toBeNull()
    // A terminal job is not "3 of 10" any more, whatever the row still holds.
    expect(job({ status: 'done', proposal_id: 'p-1', progress: { done: 3, total: 10 } }).progress).toBeUndefined()
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

  test('a parked note says it is waiting for a person, and a discarded one that it stays on record', () => {
    const parked = job({ status: 'captured' })
    expect(parked.headline).toBe('Parked')
    expect(parked.detail).toMatch(/sorts|triage|decides/i)
    expect(parked.reviewable).toBe(false)
    const dropped = job({ status: 'discarded' })
    expect(dropped.headline).toBe('Discarded')
    expect(dropped.detail).toMatch(/record/i)
    expect(dropped.reviewable).toBe(false)
  })
})

describe('the quick-capture card', () => {
  test('captureBody travels the same seam as every ingest, plus the one flag', () => {
    // Same trimming rule as ingestBody — the archive dedups on these bytes if
    // the note is ever promoted.
    expect(captureBody('  a raw thought\n')).toEqual({ text: 'a raw thought', capture: true })
  })

  test('capture ages are whole days, clock skew reads as zero, and the warning threshold is a month', () => {
    const now = Date.parse('2026-08-14T12:00:00Z')
    expect(capturedDays('2026-08-14T09:00:00Z', now)).toBe(0)
    expect(capturedDays('2026-07-10T12:00:00Z', now)).toBe(35)
    expect(capturedDays('2026-08-15T12:00:00Z', now)).toBe(0)
    expect(capturedDays('not-a-date', now)).toBe(0)
    expect(STALE_CAPTURE_DAYS).toBe(30)
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

  test('a source always carries its canonical human label', () => {
    expect(sourceLabel({ title: 'Handbook' })).toBe('Handbook')
    expect(sourceLabel({ title: 'Source 1db973788f24' })).toBe('Source 1db973788f24')
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
