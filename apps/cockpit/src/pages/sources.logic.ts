/**
 * The rules the sources surface runs on, with no DOM under them.
 *
 * The rule these modules are actually under is the runner's `lib`, not its
 * module resolution: `test/unit/` compiles with ES2023 and no DOM, so a logic
 * module that touches `window` or `localStorage` is a logic module no unit
 * test can load. (`@/*` resolves fine — the root tsconfig maps it onto
 * `apps/cockpit/src` precisely so the tests can hold these modules by the path
 * the console imports them with.)
 *
 * This file is nonetheless import-free — not even `@/lib/tokens` — and that is
 * worth keeping, because the no-DOM rule is TRANSITIVE: it is broken by what an
 * import drags in, one or two files down, not by anything visible here. A file
 * with nothing to import cannot break it by accident.
 *
 * The one thing this file pointedly does NOT own is which colour a status
 * wears. `STATUS_STATE` in `@/lib/tokens` already maps every ingest status to
 * one of the five domain states, and a second table here would be a second
 * opinion about what `quota_blocked` means. So `describeIngest` returns the
 * WORDS and the page reads the state from the shared table.
 */

/**
 * How the operator is handing a document over.
 *
 * These are the three keys `zIngestRequest` accepts, and its refine says
 * exactly one of them may be present — which is why this is a single choice
 * rather than three fields somebody could fill two of. It is the TRANSPORT of
 * the content, not what the content is; `sourceKind` below is the latter.
 */
export type IngestTransport = 'markdown' | 'text' | 'url'

export interface IngestDraft {
  transport: IngestTransport
  /** The pasted document, or the address of one. */
  content: string
  title: string
  /**
   * What the document IS. `''` is "not stated", which is a real answer: the
   * server persists absence as null on the source rather than guessing, and
   * only `meeting` changes anything downstream (its sources are mined for
   * explicit decision statements during synthesis).
   */
  sourceKind: '' | 'meeting' | 'article' | 'note'
  /**
   * The language this document's chunks are stemmed in. `''` defers to the
   * wiki's own setting, which is the right answer almost always — this exists
   * for the German memo dropped into an English wiki, where the default would
   * quietly index it with the wrong stemmer and the operator is the only one
   * who knows.
   */
  language: '' | 'en' | 'de' | 'simple'
}

export const EMPTY_INGEST_DRAFT: IngestDraft = {
  transport: 'markdown',
  content: '',
  title: '',
  sourceKind: '',
  language: '',
}

/** The longest title `zIngestRequest` will take. */
const TITLE_MAX = 500

/**
 * What stops this draft from being sent, in the operator's words, or `null`.
 *
 * Checked here rather than left to the server for one reason: the server's
 * refusal for an empty body is `exactly one of markdown|text|url is required`,
 * which is a sentence about the wire format and not about the thing the
 * operator did. Everything this cannot know — an unreachable URL, a duplicate
 * of a document already archived — is still the server's to answer, and the
 * dialog prints those verbatim.
 */
export function ingestProblem(draft: IngestDraft): string | null {
  const content = draft.content.trim()
  if (!content) {
    return draft.transport === 'url' ? 'Give the address of the document.' : 'Paste the document first.'
  }
  // http(s) only, and said here rather than after a round trip: the worker
  // refuses every other scheme outright (file: and data: would let an ingest
  // read the server's own disk), so a `ftp://` paste can only ever come back
  // as a failed job minutes later.
  if (draft.transport === 'url' && !/^https?:\/\//i.test(content)) {
    return 'A link has to start with http:// or https://.'
  }
  if (draft.title.trim().length > TITLE_MAX) {
    return `A title is at most ${TITLE_MAX} characters.`
  }
  return null
}

/**
 * The draft as `zIngestRequest` wants it.
 *
 * Absent rather than empty for every optional field: `title: ''` is not the
 * same fact as no title, and the server stores what it is given.
 *
 * The content is TRIMMED, which is the one place this console touches bytes it
 * has promised to archive verbatim, so it is worth saying why. WikiKit dedups
 * a source by the sha256 of exactly these bytes — so a paste with a trailing
 * newline and the same paste without one become two archived copies of one
 * document, each with its own hash, each cited separately. The alternative
 * (send the textarea's bytes untouched) preserves an invisible character at the
 * cost of forking the archive on it. Trimming the ends changes nothing a reader
 * of the document could point at; everything between the first and last
 * non-space character is untouched.
 *
 * `external_source_id`, `source_version`, `observed_at` and `effective_at` are
 * deliberately not offered. They are the connector sync contract: they turn a
 * one-shot ingest into a versioned stream, and a stream typed by hand once is a
 * stream nothing will ever push a second version to — it would sit in the
 * streams list below looking like a live connector that has gone quiet.
 */
export function ingestBody(draft: IngestDraft): Record<string, string> {
  const body: Record<string, string> = { [draft.transport]: draft.content.trim() }
  const title = draft.title.trim()
  if (title) body.title = title
  if (draft.sourceKind) body.source_kind = draft.sourceKind
  if (draft.language) body.language = draft.language
  return body
}

/** The fields of an ingest job this surface reads. */
export interface IngestJobView {
  status: string
  proposal_id: string | null
  error: { code: string; message: string } | null
}

export interface IngestReport {
  headline: string
  detail: string
  /** True exactly when there is a change waiting for somebody to decide it. */
  reviewable: boolean
}

/**
 * What an ingest job is doing, said to the person who started it.
 *
 * Two of these sentences carry the whole product and are worth reading twice.
 *
 * `done` with a `proposal_id` is the loop WikiKit exists for: the document has
 * been archived verbatim, quoted claim by claim into pages, and NONE of it is
 * visible knowledge yet. The sentence has to say that, or an operator walks
 * away believing they published something.
 *
 * `done` WITHOUT a `proposal_id` is not a failure and must not read as one.
 * The pipeline archived the source and found nothing in it this wiki did not
 * already hold, so there is no change to review — a valid, common, and slightly
 * disappointing outcome that a surface showing only "done" leaves the operator
 * hunting through an empty review queue for.
 *
 * `quota_blocked` is the third: it sounds terminal, it is not. The worker parks
 * the job with a resume_at and requeues it when the provider window reopens, so
 * the only correct instruction is "nothing to do" — see `TERMINAL_STATUSES` in
 * `@/lib/live`, which leaves it out for the same reason.
 */
export function describeIngest(job: IngestJobView): IngestReport {
  switch (job.status) {
    case 'queued':
      return { headline: 'Queued', detail: 'Waiting for a worker to pick it up.', reviewable: false }
    case 'running':
      return {
        headline: 'Reading the document',
        detail: 'Archiving it verbatim, then quoting it into pages.',
        reviewable: false,
      }
    case 'quota_blocked':
      return {
        headline: 'Paused on a provider quota',
        detail:
          'Nothing failed and nothing was lost. The job goes back in the queue by itself once the provider window reopens.',
        reviewable: false,
      }
    case 'failed':
      return {
        headline: 'Could not be added',
        detail: job.error ? `${job.error.message} (${job.error.code})` : 'The worker did not say why.',
        reviewable: false,
      }
    case 'done':
      return job.proposal_id
        ? {
            headline: 'Pages drafted',
            detail:
              'The synthesised pages are waiting in Changes. Nothing here is visible knowledge until somebody approves it.',
            reviewable: true,
          }
        : {
            headline: 'Archived, with nothing to review',
            detail:
              'The document is archived and citable, and it said nothing this wiki did not already hold — so there is no change to approve.',
            reviewable: false,
          }
    default:
      // A status from a server newer than this bundle. Still being polled —
      // `isTerminalStatus` treats an unknown status as still moving — so the
      // sentence says what is true and names the word it cannot read.
      return {
        headline: 'Working',
        detail: `This console does not know the status “${job.status}”. It is still watching the job.`,
        reviewable: false,
      }
  }
}

/**
 * How many connector streams one read may hold — the endpoint's own maximum,
 * asked for out loud.
 *
 * `zSourceStreamListQuery` takes a `limit` of at most 200 and `listStreams`
 * clamps with `clampLimit(args.limit, 50, 200)`, so a request that names no
 * limit gets the 50 most recently updated streams and nothing says so. That is
 * worse here than in a read-only list: the Forget control lives in a stream's
 * row, so the streams past the ceiling had no control at all — a connector
 * pushing a document nobody wants tracked any more could not be stopped from
 * this page, and the page gave no hint that it existed.
 *
 * 200 is the ceiling and not a page: this read offers no cursor, so `cap` on
 * the table is what keeps a full answer from reading as a complete one.
 * `test/unit/cockpit-pages/sources.test.ts` holds this number against the
 * server's own schema, so it cannot drift below what the endpoint allows.
 */
export const STREAM_CEILING = 200

/** The caveat under a stream list that came back full. */
export const STREAM_CAP_NOTE = `only the ${STREAM_CEILING} most recently updated streams are loaded — a stream past that cannot be seen or forgotten here`

/** Which half of a source page opens first. */
export type SourceView = 'rendered' | 'verbatim'

/**
 * A source is archived verbatim, so `verbatim` is the honest default — except
 * where the bytes ARE markup a reader would rather read than parse.
 *
 * `markdown` and `url` sources have a real markdown projection (a URL ingest
 * runs the fetched HTML through rehype-remark), so rendering them is showing
 * the same document better. `text` and `import` do not: their projection is the
 * raw bytes, and a `<pre>` is then the truthful view — rendering plain text as
 * markdown would silently eat a line starting with `#` in a meeting note.
 */
export function defaultSourceView(kind: string): SourceView {
  return kind === 'markdown' || kind === 'url' ? 'rendered' : 'verbatim'
}

/**
 * What to call a source that may have no title.
 *
 * Both pages need the answer and they must agree: a row the operator clicked
 * under one name and a page that greets them with another is the console
 * losing track of the thing in one navigation. The URL is the next best name
 * because for a `url` source it IS the identity; the id prefix is the last
 * resort and is marked as one rather than pretending to be a title.
 */
export function sourceLabel(source: { title: string | null; url: string | null; id: string }): string {
  const title = source.title?.trim()
  if (title) return title
  const url = source.url?.trim()
  if (url) return url
  return `Untitled source ${source.id.slice(0, 8)}`
}
