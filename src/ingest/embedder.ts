// Embedder — background backfill/maintenance for the OPTIONAL hybrid
// retrieval ranker (wk_embeddings, migration 0018).
//
// Scan-based like the chunk backfill: the presence of an embedding row for
// (object_kind, object_id, model) IS the done-marker — idempotent, resumable,
// no queue state. Runs only when BOTH pgvector is present (startup probe)
// and an embedding provider is configured; a deployment without either
// simply stays lexical.
//
// Batches are grouped per space because the audit ledger (wk_agent_runs) is
// space-scoped — one 'embed' row per provider call, exactly like every other
// LLM call in the system.
import type { Db } from '../db/postgres.ts'
import type { LlmProvider } from '../llm/provider.ts'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'

export interface Embedder {
  start(): void
  stop(): void
  /** One scan pass (tests call this directly). Returns candidates seen. */
  runOnce(): Promise<number>
}

/** Startup capability probe: is the pgvector extension installed? */
export async function probeVectorSupport(db: Db): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)
  return rows.length > 0
}

const BATCH_SIZE = 64

// Cap what one revision contributes to its embedding text — embeddings
// summarize, the lexical index remains the exhaustive arm.
const REVISION_TEXT_CHARS = 8000

interface Candidate {
  space_id: string
  kind: 'revision' | 'claim' | 'source_chunk'
  id: string
  text: string
}

export function createEmbedder(
  db: Db,
  llm: LlmProvider,
  config: Config,
  logger: Logger,
  options: { intervalMs?: number } = {},
): Embedder {
  const intervalMs = options.intervalMs ?? 30_000
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let stopped = true

  async function runOnce(): Promise<number> {
    const model = config.modelEmbedding ?? 'text-embedding-3-small'
    const { rows: candidates } = await db.query<Candidate>(
      `WITH candidates AS (
         SELECT r.space_id, 'revision' AS kind, r.id,
                (r.title || E'\n' || r.summary || E'\n' || left(r.markdown, ${REVISION_TEXT_CHARS})) AS text
           FROM wk_concepts c
           JOIN wk_concept_revisions r ON r.id = c.current_revision_id
          WHERE NOT EXISTS (
            SELECT 1 FROM wk_embeddings e
             WHERE e.object_kind = 'revision' AND e.object_id = r.id AND e.model = $1)
         UNION ALL
         SELECT cl.space_id, 'claim', cl.id,
                (cl.subject || ' ' || cl.predicate || ' ' || cl.object)
           FROM wk_claims cl
          WHERE cl.status IN ('verified', 'disputed', 'deprecated')
            AND NOT EXISTS (
              SELECT 1 FROM wk_embeddings e
               WHERE e.object_kind = 'claim' AND e.object_id = cl.id AND e.model = $1)
         UNION ALL
         SELECT ch.space_id, 'source_chunk', ch.id,
                (coalesce(ch.heading || E'\n', '') || ch.content)
           FROM wk_source_chunks ch
          WHERE NOT EXISTS (
            SELECT 1 FROM wk_embeddings e
             WHERE e.object_kind = 'source_chunk' AND e.object_id = ch.id AND e.model = $1)
       )
       SELECT * FROM candidates ORDER BY space_id LIMIT ${BATCH_SIZE}`,
      [model],
    )
    if (!candidates.length) return 0

    // One provider call + one audit row per space group.
    const bySpace = new Map<string, Candidate[]>()
    for (const candidate of candidates) {
      const group = bySpace.get(candidate.space_id) ?? []
      group.push(candidate)
      bySpace.set(candidate.space_id, group)
    }

    for (const [spaceId, group] of bySpace) {
      const result = await llm.embed({ texts: group.map((candidate) => candidate.text) })
      try {
        await db.insert(
          'wk_embeddings',
          group.map((candidate, index) => ({
            space_id: spaceId,
            object_kind: candidate.kind,
            object_id: candidate.id,
            // The CONFIGURED model string, not result.run.model: the scan's
            // NOT EXISTS uses this exact value as the done-marker key — any
            // divergence (provider-side alias resolution) would make the
            // scan re-embed the same rows forever.
            model,
            embedding: `[${result.output.embeddings[index]!.join(',')}]`,
          })),
          { returning: false },
        )
      } catch (error) {
        // Two embedder passes racing (restart overlap): the loser hits
        // unique(object_kind, object_id, model); the next scan re-picks only
        // what is still missing.
        if ((error as { code?: string }).code !== '23505') throw error
      }
      await db.insert(
        'wk_agent_runs',
        {
          space_id: spaceId,
          kind: 'embed',
          model: result.run.model,
          prompt_version: result.run.prompt_version,
          input_hash: result.run.input_hash,
          usage: JSON.stringify(result.run.usage),
          duration_ms: result.run.duration_ms,
        },
        { returning: false },
      )
      logger.info('embedded batch', { space_id: spaceId, objects: group.length, model: result.run.model })
    }
    return candidates.length
  }

  function schedule(delay: number): void {
    if (stopped) return
    timer = setTimeout(() => {
      if (running || stopped) return
      running = true
      runOnce()
        .then((seen) => {
          running = false
          schedule(seen >= BATCH_SIZE ? 0 : intervalMs)
        })
        .catch((error) => {
          running = false
          logger.warn('embedder pass failed', { error: (error as Error).message })
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
