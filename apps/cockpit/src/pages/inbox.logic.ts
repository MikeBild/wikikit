/**
 * The Inbox's rules, with no DOM under them.
 *
 * The Inbox is the one page in this console that turns ONE gesture into MANY
 * requests — a folder dropped on it, a column of addresses pasted into it — and
 * every rule here exists to keep that honest. Two of them carry the page:
 *
 *  - **Bulk is N independent jobs, never one batch.** Each file and each address
 *    becomes its own ingest, so it keeps its own content hash, its own change
 *    proposal and its own review. The alternative — one job holding forty
 *    documents — produces one proposal nobody can decide, and a single bad
 *    extraction fails the other thirty-nine with it. `POST /import` already
 *    exists for the deliberate "one bundle, one change" case.
 *  - **A refusal is reported, not retried away.** The server answers `429
 *    ingest_queue_full` when a wiki already has more waiting than a human is
 *    going to get through; forty files dropped on a full queue cost forty
 *    classify calls and however many synthesis calls follow. So the outcome of
 *    every item is kept and rendered, including the ones that never started.
 *
 * Import-free, like `sources.logic.ts`, and for the same transitive reason: the
 * unit tier compiles with no DOM, and what breaks that rule is what an import
 * drags in two files down rather than anything visible here.
 */

/**
 * The extensions `src/ingest/extract.ts` can actually read, restated.
 *
 * Restated rather than imported: this module compiles for a browser and does
 * not reach into the server's. The server's `EXT_FORMAT` remains the real
 * gate — it answers 415 `unsupported_document` — and this is the courtesy copy
 * that stops a `.pages` file from costing a round trip to learn the same thing.
 * `markdown` is here as well as `md` because the extractor accepts both.
 */
export const DOCUMENT_EXTENSIONS: readonly string[] = ['pdf', 'docx', 'xlsx', 'md', 'markdown', 'txt', 'csv']

/** The `accept` attribute of the file input — the same list, in the browser's spelling. */
export const DOCUMENT_ACCEPT: string = DOCUMENT_EXTENSIONS.map((extension) => `.${extension}`).join(',')

/** The extension of a filename, lower-cased, or `''` where there is none. */
export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * What stops a dropped file from being sent, in the operator's words, or `null`.
 *
 * Said before the upload rather than after it because the cost is asymmetric: a
 * drop of thirty files where four are screenshots would otherwise spend four
 * uploads to be told four times that a `.png` has no text in it.
 */
export function fileProblem(file: { name: string; size: number }): string | null {
  const extension = extensionOf(file.name)
  if (!DOCUMENT_EXTENSIONS.includes(extension)) {
    return `This console cannot read .${extension || 'files with no extension'} — try pdf, docx, xlsx, md, txt or csv.`
  }
  if (file.size === 0) return 'This file is empty.'
  return null
}

/**
 * One line of the address box, read as an address — or as a reason it is not one.
 *
 * `http(s)` only, and refused here rather than after a round trip: the worker
 * rejects every other scheme outright (a `file:` ingest would read the server's
 * own disk), so a `ftp://` paste can only ever come back as a failed job
 * minutes later, in a list of forty other jobs.
 */
export interface UrlPlan {
  /** The addresses to submit, in the order they were pasted, without duplicates. */
  urls: readonly string[]
  /** The lines that are not addresses, verbatim, so the operator can see which. */
  rejected: readonly string[]
}

export function planUrls(text: string): UrlPlan {
  const urls: string[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (!/^https?:\/\/\S+$/i.test(line)) {
      rejected.push(line)
      continue
    }
    // Deduplicated here rather than left to the content hash. The server WOULD
    // dedup — the second ingest of one address answers `already_ingested` — but
    // it would fetch the page again to find that out, and a pasted list is
    // exactly where the same address appears twice.
    if (seen.has(line)) continue
    seen.add(line)
    urls.push(line)
  }
  return { urls, rejected }
}

/**
 * One item of a bulk drop, from queued to settled.
 *
 * `pending` is a real state and not a null: an operator who drops thirty files
 * must be able to see that the twenty-ninth has not been sent yet, which is a
 * different fact from a twenty-ninth that failed. The items are submitted one
 * at a time so a queue ceiling stops the run instead of racing thirty requests
 * past it.
 */
export type SubmissionState = 'pending' | 'sending' | 'queued' | 'refused'

export interface Submission {
  /** Stable within one drop, and NOT a database id — the row exists before the server answers. */
  key: string
  /** The filename or the address, which is what the operator recognises it by. */
  label: string
  state: SubmissionState
  /** The ingest job the server opened, once it has. */
  ingestId: string | null
  /** The server's own words, kept verbatim where it refused (CUI-LOAD-2). */
  refusal: string | null
  /** `ingest_queue_full` is the one refusal the page treats as a stop signal. */
  code: string | null
}

/** A submission as it starts: named, not yet sent, nothing decided. */
export function pendingSubmission(key: string, label: string): Submission {
  return { key, label, state: 'pending', ingestId: null, refusal: null, code: null }
}

/**
 * Whether a refusal should stop the rest of the drop.
 *
 * Exactly one code does: `ingest_queue_full` is a statement about the wiki, not
 * about the item, so pushing the remaining twenty-nine at it would collect
 * twenty-nine copies of the same sentence and, for the document route, pay for
 * twenty-nine extractions that are discarded. Everything else — an unreadable
 * pdf, a URL that 404s — is about one item, and the other items still deserve
 * their turn.
 */
export function haltsRun(code: string | null): boolean {
  return code === 'ingest_queue_full'
}

/** The tally under a finished run: what got in, what did not, what never went. */
export interface RunTally {
  queued: number
  refused: number
  pending: number
}

export function tally(items: readonly Submission[]): RunTally {
  return {
    queued: items.filter((item) => item.state === 'queued').length,
    refused: items.filter((item) => item.state === 'refused').length,
    pending: items.filter((item) => item.state === 'pending' || item.state === 'sending').length,
  }
}
