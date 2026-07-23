// Coverage insights — the maintainer-report primitives behind
// GET /v1/spaces/{space}/stats/coverage.
//
// Two write paths feed it:
//   * recordConceptRead — per-day aggregate counters for EXPLICIT concept
//     reads (REST read_concept + MCP wikikit_read). Internal loads (answer
//     evidence, pipeline) never count; counters carry no actor data.
//   * recordCoverageGap — opt-in (WIKIKIT_COVERAGE_GAP_TOPICS_ENABLED):
//     when /query honestly answers "not covered", the question's STEMMED
//     LEXEMES (space search config: stopwords stripped, words stemmed) are
//     stored — never the question text itself. Lexemes share the usage
//     retention window via cleanupCoverageGaps.
import type { Db } from '../db/postgres.ts'

export interface CoverageStats {
  disputed: { open: number; oldest_days: number | null }
  review_latency: { decided: number; approved: number; rejected: number; median_hours: number | null }
  freshness: { concepts: number; stale_over_90d: number }
  top_read_concepts: { slug: string; title: string; reads: number }[]
  top_linked_concepts: { slug: string; title: string; inbound_relations: number }[]
  gap_topics: { lexeme: string; count: number }[]
}

/** Fire-and-forget from the read handlers — a failed counter never fails a read. */
export async function recordConceptRead(db: Db, spaceId: string, slug: string): Promise<void> {
  await db.query(
    `INSERT INTO wk_concept_reads (concept_id, space_id, day, reads)
     SELECT c.id, c.space_id, current_date, 1
       FROM wk_concepts c
      WHERE c.space_id = $1 AND c.slug = $2 AND c.current_revision_id IS NOT NULL
     ON CONFLICT (concept_id, day) DO UPDATE SET reads = wk_concept_reads.reads + 1`,
    [spaceId, slug],
  )
}

/** Store stemmed lexemes (max 8) of an unanswered question — never its text. */
export async function recordCoverageGap(db: Db, spaceId: string, question: string): Promise<void> {
  // Two steps by architecture: wk_space_search_config is a SQL function and
  // must go through the db.call whitelist — db.query's identifier guard
  // rejects any inlined wk_* function on purpose.
  const [row] = await db.call('wk_space_search_config', [spaceId])
  const config = String(row?.config ?? 'simple')
  await db.query(
    `INSERT INTO wk_coverage_gaps (space_id, lexeme)
     SELECT $1, lexeme
       FROM (SELECT DISTINCT unnest(tsvector_to_array(to_tsvector($2::regconfig, $3))) AS lexeme) t
      WHERE char_length(lexeme) <= 60
      LIMIT 8`,
    [spaceId, config, question],
  )
}

/** Retention twin of the usage-event cleanup (same day window). */
export async function cleanupCoverageGaps(db: Db, retentionDays: number): Promise<void> {
  await db.query(`DELETE FROM wk_coverage_gaps WHERE created_at < now() - ($1::int * interval '1 day')`, [
    retentionDays,
  ])
}

export async function getCoverageStats(
  db: Db,
  spaceId: string,
  window: { from: string; to: string; top: number },
): Promise<CoverageStats> {
  const [disputed] = (
    await db.query<{ open: number; oldest_days: number | null }>(
      `SELECT count(*)::int AS open,
              floor(extract(epoch FROM now() - min(created_at)) / 86400)::int AS oldest_days
         FROM wk_claims
        WHERE space_id = $1 AND status = 'disputed'`,
      [spaceId],
    )
  ).rows
  const [latency] = (
    await db.query<{ decided: number; approved: number; rejected: number; median_hours: number | null }>(
      `SELECT count(*)::int AS decided,
              count(*) FILTER (WHERE status = 'approved')::int AS approved,
              count(*) FILTER (WHERE status IN ('rejected', 'failed'))::int AS rejected,
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM reviewed_at - created_at)) / 3600)::numeric, 1)::float AS median_hours
         FROM wk_change_proposals
        WHERE space_id = $1 AND reviewed_at >= $2 AND reviewed_at < $3 AND status IN ('approved', 'rejected', 'failed')`,
      [spaceId, window.from, window.to],
    )
  ).rows
  const [freshness] = (
    await db.query<{ concepts: number; stale_over_90d: number }>(
      `SELECT count(*)::int AS concepts,
              count(*) FILTER (WHERE updated_at < now() - interval '90 days')::int AS stale_over_90d
         FROM wk_concepts
        WHERE space_id = $1 AND current_revision_id IS NOT NULL`,
      [spaceId],
    )
  ).rows
  const reads = (
    await db.query<{ slug: string; title: string; reads: number }>(
      `SELECT c.slug, c.title, sum(r.reads)::int AS reads
         FROM wk_concept_reads r JOIN wk_concepts c ON c.id = r.concept_id
        WHERE r.space_id = $1 AND r.day >= $2::date AND r.day < $3::date
        GROUP BY c.slug, c.title ORDER BY reads DESC, c.slug LIMIT $4`,
      [spaceId, window.from, window.to, window.top],
    )
  ).rows
  const hubs = (
    await db.query<{ slug: string; title: string; inbound_relations: number }>(
      // Hubs describe the CURRENT graph, not the window.
      `SELECT c.slug, c.title, count(*)::int AS inbound_relations
         FROM wk_relations rel JOIN wk_concepts c ON c.id = rel.to_concept_id
        WHERE rel.space_id = $1 AND rel.status = 'active'
        GROUP BY c.slug, c.title ORDER BY inbound_relations DESC, c.slug LIMIT $2`,
      [spaceId, window.top],
    )
  ).rows
  const gaps = (
    await db.query<{ lexeme: string; count: number }>(
      `SELECT lexeme, count(*)::int AS count
         FROM wk_coverage_gaps
        WHERE space_id = $1 AND created_at >= $2 AND created_at < $3
        GROUP BY lexeme ORDER BY count DESC, lexeme LIMIT $4`,
      [spaceId, window.from, window.to, window.top],
    )
  ).rows
  return {
    disputed: { open: disputed?.open ?? 0, oldest_days: disputed?.open ? disputed.oldest_days : null },
    review_latency: {
      decided: latency?.decided ?? 0,
      approved: latency?.approved ?? 0,
      rejected: latency?.rejected ?? 0,
      median_hours: latency?.decided ? latency.median_hours : null,
    },
    freshness: { concepts: freshness?.concepts ?? 0, stale_over_90d: freshness?.stale_over_90d ?? 0 },
    top_read_concepts: reads,
    top_linked_concepts: hubs,
    gap_topics: gaps,
  }
}
