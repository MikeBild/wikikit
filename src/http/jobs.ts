// Async ingest jobs — the HTTP read model over wk_ingest_jobs (POST returns
// 202 + Location, GET polls the job, and the space-scoped list is the inbox).
//
// The WRITE side lives in src/ingest/pipeline.ts (enqueue + in-process
// worker); this module owns the row → wire mapping for GET /v1/ingests/{id}
// AND for GET /v1/spaces/{space}/ingests so the status shape
// (zIngestStatusResponse) has exactly one producer — toJobStatus below. The
// list was added after the single read, and adding it as a second query with
// its own object literal is how the two surfaces would start disagreeing about
// what `progress` means on a job that has none.
//
// WHY the by-id lookup is global-by-id (⚠ per the §4 convention): the job id is
// the Location URL the client got back — it does not carry the space slug. The
// row's space_id is returned so the TRANSPORT can enforce the key/space match
// (routes.ts calls auth.requireScope with it); this module never sees a
// principal. The LIST is the opposite case and takes an explicit spaceId: the
// space came from the path and was already resolved, so its rows carry no
// space_id at all (see IngestJobWire).
import type { Db } from '../db/postgres.ts'
import { NotFoundError } from '../domain/errors.ts'
import { clampLimit, decodeCursor, encodeCursor, isoString } from '../domain/sources.ts'
import type { IngestPhase } from '../ingest/pipeline.ts'

/** The five terminal-or-not states of §9.1, spelled once for both queries. */
export type IngestJobState = 'queued' | 'running' | 'done' | 'failed' | 'quota_blocked'

export interface IngestJobStatus {
  ingest_id: string
  status: IngestJobState
  proposal_id: string | null
  source_id: string | null
  error: { code: string; message: string } | null
  /**
   * Which stage a running job is in. Null before the worker claims it, and on
   * rows written by a binary that predates progress reporting.
   */
  phase: IngestPhase | null
  /** Position inside a countable stage (synthesis: concepts done of total). */
  progress: { done: number; total: number } | null
  /**
   * When the job was ACCEPTED. Additive, and the list is why: an inbox row whose
   * only timestamps are started_at/finished_at has nothing to show for the state
   * it spends the most time in — a queued job has neither, so "waiting since
   * when" was unanswerable. It rides on the single read too, where it turns
   * `status: queued` into a fact with an age.
   */
  created_at: string
  started_at: string | null
  heartbeat_at: string | null
  finished_at: string | null
  /** NOT part of the wire shape — the transport's space-scoping handle. */
  space_id: string
}

/**
 * What a space-scoped list row carries: the same shape minus the scoping handle.
 * The space is the path parameter the caller just supplied, so echoing its id on
 * every row would be noise — and getIngestHandler strips exactly this field for
 * the same reason.
 */
export type IngestJobWire = Omit<IngestJobStatus, 'space_id'>

interface JobRow {
  id: string
  space_id: string
  status: IngestJobState
  proposal_id: string | null
  source_id: string | null
  error: { code: string; message: string } | string | null
  phase: IngestPhase | null
  progress_done: number | null
  progress_total: number | null
  created_at: Date | string
  started_at: Date | string | null
  heartbeat_at: Date | string | null
  finished_at: Date | string | null
}

/** The ONE producer of the job status shape — see the module header. */
function toJobStatus(row: JobRow): IngestJobStatus {
  // pg parses jsonb to an object, but a stubbed pool (unit tests) may hand
  // back the string the worker inserted — normalize either way.
  const error = typeof row.error === 'string' ? (JSON.parse(row.error) as { code: string; message: string }) : row.error
  return {
    ingest_id: row.id,
    status: row.status,
    proposal_id: row.proposal_id,
    source_id: row.source_id,
    error,
    phase: row.phase ?? null,
    // Both halves or nothing: "3 of null" is not a fraction, and a client that
    // has to guess the denominator will guess wrong.
    progress:
      typeof row.progress_done === 'number' && typeof row.progress_total === 'number'
        ? { done: row.progress_done, total: row.progress_total }
        : null,
    // Raw timestamps, not a derived "running for 12 minutes": the client knows
    // when it is asking, and a duration computed here is stale on arrival.
    created_at: isoString(row.created_at),
    started_at: row.started_at ? isoString(row.started_at) : null,
    heartbeat_at: row.heartbeat_at ? isoString(row.heartbeat_at) : null,
    finished_at: row.finished_at ? isoString(row.finished_at) : null,
    space_id: row.space_id,
  }
}

export async function getIngestJob(db: Db, args: { id: string }): Promise<IngestJobStatus> {
  const [row] = await db.select<JobRow>('wk_ingest_jobs', { id: `eq.${args.id}`, limit: 1 })
  if (!row) throw new NotFoundError(`ingest job ${args.id} not found`)
  return toJobStatus(row)
}

/**
 * The inbox: this space's ingest jobs, newest first, with an optional status
 * filter and the same `before` keyset cursor the source and output archives use
 * (see listSources for why the cursor carries only the id).
 *
 * WHY newest-first when the WORKER is oldest-first: these are two different
 * questions. The worker asks "what is next", a person asks "what did I just drop
 * in, and did it land" — and the answer to the second is at the top of the page
 * or it is not on it. The queue order remains readable from created_at.
 */
export async function listIngestJobs(
  db: Db,
  spaceId: string,
  args: { status?: IngestJobState; limit?: number; before?: string } = {},
): Promise<{ items: IngestJobWire[]; next_before: string | null }> {
  const limit = clampLimit(args.limit, 50, 200)
  const values: unknown[] = [spaceId]
  let filter = ''
  if (args.status) {
    values.push(args.status)
    filter = ` AND status = $${values.length}`
  }
  let keyset = ''
  if (args.before) {
    const [id] = decodeCursor(args.before, 1)
    values.push(id)
    keyset = ` AND (created_at, id) < (SELECT created_at, id FROM wk_ingest_jobs WHERE id = $${values.length}::uuid)`
  }
  values.push(limit + 1)
  const { rows } = await db.query<JobRow>(
    // `input` is deliberately not selected: it holds the whole submitted
    // markdown, so a page of fifty jobs would be megabytes of content the
    // archive already serves at /sources.
    `SELECT id, space_id, status, proposal_id, source_id, error, phase,
            progress_done, progress_total, created_at, started_at, heartbeat_at, finished_at
       FROM wk_ingest_jobs
      WHERE space_id = $1${filter}${keyset}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}`,
    values,
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map((row) => {
      const { space_id: _spaceId, ...wire } = toJobStatus(row)
      return wire
    }),
    next_before: rows.length > limit && last ? encodeCursor(last.id) : null,
  }
}
