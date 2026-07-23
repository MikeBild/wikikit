// Chunk backfill — heals the source-evidence retrieval index
// (wk_source_chunks) for sources that predate migration 0017 or arrived
// through paths that do not chunk inline (bundle import).
//
// WHY a scan worker instead of wk_ingest_jobs rows: the presence of the
// derived chunk rows IS the done-marker, so the scan is idempotent and
// resumable with no queue state at all — exactly right for derived-data
// maintenance. The job queue's semantics (409-blocking, proposal linkage,
// quota backoff) have nothing to say about derived rows.
//
// WHY app-level and not in-migration SQL: chunkForRetrieval is the single
// chunking implementation; re-implementing heading/fence alignment in SQL
// would guarantee drift between backfilled and fresh chunks.
import type { Db } from '../db/postgres.ts'
import { persistSourceChunks } from '../domain/sources.ts'
import type { Logger } from '../logger.ts'

export interface ChunkBackfill {
  start(): void
  stop(): void
  /** One scan pass (tests call this directly). Returns sources chunked. */
  runOnce(): Promise<number>
}

const BATCH_SIZE = 16

export function createChunkBackfill(db: Db, logger: Logger, options: { intervalMs?: number } = {}): ChunkBackfill {
  const intervalMs = options.intervalMs ?? 30_000
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let stopped = true

  async function runOnce(): Promise<number> {
    // btrim guard: a whitespace-only markdown yields zero chunks and would
    // otherwise be re-selected on every pass forever.
    const { rows } = await db.query<{ id: string; space_id: string; markdown: string }>(
      `SELECT s.id, s.space_id, s.markdown
         FROM wk_sources s
        WHERE NOT EXISTS (SELECT 1 FROM wk_source_chunks ch WHERE ch.source_id = s.id)
          AND btrim(s.markdown) <> ''
        ORDER BY s.created_at ASC
        LIMIT ${BATCH_SIZE}`,
    )
    let chunked = 0
    for (const row of rows) {
      const written = await persistSourceChunks(db, row.space_id, { id: row.id, markdown: row.markdown })
      if (written > 0) chunked += 1
    }
    if (chunked > 0) logger.info('chunk backfill pass', { sources: chunked })
    return rows.length
  }

  function schedule(delay: number): void {
    if (stopped) return
    timer = setTimeout(() => {
      if (running || stopped) return
      running = true
      runOnce()
        .then((scanned) => {
          running = false
          // A full batch means there is more waiting — continue immediately;
          // an idle pass backs off to the interval.
          schedule(scanned >= BATCH_SIZE ? 0 : intervalMs)
        })
        .catch((error) => {
          running = false
          logger.warn('chunk backfill pass failed', { error: (error as Error).message })
          schedule(intervalMs)
        })
    }, delay)
    timer.unref?.()
  }

  return {
    runOnce,
    start() {
      if (!stopped) return
      stopped = false
      schedule(0)
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
