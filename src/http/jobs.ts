// Async ingest jobs — the HTTP read model over wk_ingest_jobs (POST returns
// 202 + Location, GET polls the job).
//
// The WRITE side lives in src/ingest/pipeline.ts (enqueue + in-process
// worker); this module owns the row → wire mapping for GET /v1/ingests/{id}
// so the status shape (zIngestStatusResponse) has exactly one producer.
//
// WHY the lookup is global-by-id (⚠ per the §4 convention): the job id is the
// Location URL the client got back — it does not carry the space slug. The
// row's space_id is returned so the TRANSPORT can enforce the key/space match
// (routes.ts calls auth.requireScope with it); this module never sees a
// principal.
import type { Db } from '../db/postgres.ts'
import { NotFoundError } from '../domain/errors.ts'

export interface IngestJobStatus {
  ingest_id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'quota_blocked'
  proposal_id: string | null
  source_id: string | null
  error: { code: string; message: string } | null
  /** NOT part of the wire shape — the transport's space-scoping handle. */
  space_id: string
}

interface JobRow {
  id: string
  space_id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'quota_blocked'
  proposal_id: string | null
  source_id: string | null
  error: { code: string; message: string } | string | null
}

export async function getIngestJob(db: Db, args: { id: string }): Promise<IngestJobStatus> {
  const [row] = await db.select<JobRow>('wk_ingest_jobs', { id: `eq.${args.id}`, limit: 1 })
  if (!row) throw new NotFoundError(`ingest job ${args.id} not found`)
  // pg parses jsonb to an object, but a stubbed pool (unit tests) may hand
  // back the string the worker inserted — normalize either way.
  const error = typeof row.error === 'string' ? (JSON.parse(row.error) as { code: string; message: string }) : row.error
  return {
    ingest_id: row.id,
    status: row.status,
    proposal_id: row.proposal_id,
    source_id: row.source_id,
    error,
    space_id: row.space_id,
  }
}
