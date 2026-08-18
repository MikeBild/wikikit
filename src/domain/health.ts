// The composed health surface — one answer to "how is this wiki doing?", served
// to GET /v1/spaces/{space}/health, the wikikit_health MCP tool and the
// scheduled health/briefing run. LLM-free, pure SQL, exactly like the two
// modules it composes.
//
// WHY a module and not three calls at the transport. The three questions an
// operator actually has — is the knowledge sound (lint), is it being read and
// kept fresh (coverage), and is anybody keeping up with the work it generates
// (the two queues) — are answered today by three surfaces that must be visited
// in sequence and mentally joined. An agent asked "check this space for
// contradictions and gaps" had to chain two tools; the cockpit's care page would
// have had to fan out three requests and invent its own opinion about what to do
// when one of them fails halfway. Composing here means one shape, one failure
// mode, and — the reason it is a DOMAIN module rather than a handler — one
// producer for the REST route, the MCP tool and the scheduler, which must all
// report the same numbers or the daily briefing becomes a second opinion about
// the same space.
//
// WHY it measures almost nothing itself. `lint` and `coverage` are re-used
// whole, never re-implemented: a second hand-written count of stale claims or
// disputed frames drifts over a visibility status or a forgotten DISTINCT, and
// then this endpoint tells an operator something the lint report contradicts.
// Two surfaces disagreeing about one space is worse than one surface missing.
//
// The two things this module DOES measure are the ones neither neighbour can:
//
//   * the REVIEW QUEUE as a number with an age. Lint already emits one info
//     finding per pending proposal, and that is not a measurement — a report
//     carrying hundreds of identical lines is a wall, not a queue depth, and no
//     line in it says how long the oldest one has waited. The age is the whole
//     point: a bare count reads as "some work waiting" no matter how large it
//     is, while `pending` beside "oldest 21 days" reads as what it is, an
//     abandoned queue. An installation whose ingest is automated can generate
//     more review work than a human ever clears, and until this pair existed
//     nothing anywhere said so.
//
//   * the INGEST QUEUE depth and the wait at its head. `GET /stats/ingests` is
//     a bucketed time series over jobs that HAPPENED; it cannot answer "how much
//     is waiting right now", which is the only ingest question a maintenance
//     report has.
//
// WHAT THIS MODULE REFUSES TO DO:
//   * No verdict. There is no top-level `status: 'ok' | 'degraded'`, because
//     every threshold that would produce one is policy (how many pending
//     changes is too many? for whose team?) and a domain module that invents
//     policy hides it from the operator who owns it. `lint.counts` is already a
//     severity census, and the caller decides what to do with it.
//   * No percentages, and no ratio whose denominator this module cannot vouch
//     for. `freshness` travels as the pair {concepts, stale_over_90d} exactly as
//     coverage produced it, because a wiki holding no pages has no stale SHARE —
//     not 0% — and the decision to print an em dash instead of a lie belongs to
//     the renderer that knows its reader (apps/cockpit/src/pages/home.logic.ts
//     staleShare).
//   * No zero standing in for an absent measurement. Every age below is null
//     when the thing it would age does not exist, never 0: "oldest pending
//     change: 0 days" about an empty queue is a fact about nothing.
import { z } from 'zod'
import type { Db } from '../db/postgres.ts'
import type { ScaffoldingOptions } from './concepts.ts'
import { type CoverageStats, getCoverageStats } from './coverage.ts'
import { ValidationError } from './errors.ts'
import { type LintReport, lintSpace } from './lint.ts'
import { isoString } from './sources.ts'

/**
 * Coverage, plus the one fact coverage itself cannot know: whether the
 * installation records gap lexemes at all.
 *
 * Derived from CoverageStats rather than restated, so a field added there
 * arrives here instead of being silently dropped. `gap_topics` is the one
 * member re-wrapped, and it is re-wrapped for the same reason
 * GET /v1/spaces/{space}/stats/coverage wraps it: an empty list means "no
 * unanswered question was recorded" when the feature is on and "nothing was ever
 * recorded" when it is off, and those are different facts about the same wiki.
 */
export interface SpaceHealthCoverage extends Omit<CoverageStats, 'gap_topics'> {
  gap_topics: { enabled: boolean; items: CoverageStats['gap_topics'] }
}

export interface SpaceHealth {
  checked_at: string
  guidelines: { revision: number | null; updated_at: string | null }
  /**
   * The window the `coverage` block describes, echoed as the ISO instants that
   * were actually used. A reader must never have to assume it: the same shape
   * is served to a route that accepts a range and to a scheduler that accepts
   * none, and a caption ("in the last 30 days") that a caller derives from its
   * own defaults is a caption that eventually contradicts the numbers under it.
   */
  window: { from: string; to: string }
  /** The requested lint tier, whole, with the severity census — see src/domain/lint.ts. */
  lint: LintReport
  coverage: SpaceHealthCoverage
  /**
   * Changes staged and waiting for a human. `oldest_days` is null exactly when
   * `pending` is 0 — no queue, no age.
   */
  review_queue: { pending: number; oldest_days: number | null }
  /**
   * Ingest work not yet finished, right now.
   *
   * `depth` is `queued + running` — the number the plan asks for and the one an
   * operator reads first — and both halves travel with it, because work waiting
   * and work in flight call for different reactions (add capacity vs. wait).
   * `quota_blocked` is counted beside them rather than folded in: a parked job
   * is neither, it is work the provider's quota window is holding, and a depth
   * that silently omitted it would report an idle queue to an operator whose
   * ingest has stopped moving. `oldest_queued_hours` is null when nothing is
   * queued.
   *
   * `captured` counts the parked thoughts — also beside `depth`, never inside
   * it: a captured row is not work in flight, it is a note waiting for a human
   * to decide whether it becomes work at all. `oldest_captured_days` is null
   * when nothing is parked, and in DAYS rather than hours because a parked
   * thought waiting since this morning is fine and one waiting a month is the
   * stale-captures signal.
   */
  ingest_queue: {
    depth: number
    queued: number
    running: number
    quota_blocked: number
    oldest_queued_hours: number | null
    captured: number
    oldest_captured_days: number | null
  }
  /**
   * The archive against the retrieval index: how many sources this wiki keeps,
   * how many of them search can still reach, and the window the index sweep
   * runs under (`index_days`, null when sources are indexed forever — the
   * default, WIKIKIT_SOURCE_INDEX_DAYS).
   *
   * Announced in advance, not after the fact. The block is reported whether or
   * not a window is set and whether or not a sweep has ever run, so an operator
   * sizes the decision — this much evidence, this much of it findable — before
   * making it, instead of learning what a window does from an archive that has
   * already left the index. `index_days` travels with the numbers for the same
   * reason `window` travels with `coverage`: a reader must never have to assume
   * which window the counts belong to.
   *
   * `sources` = `indexed` + `unindexed` by construction. The bytes are never at
   * stake: an unindexed source is still archived verbatim and can be re-indexed.
   */
  archive: { sources: number; indexed: number; unindexed: number; index_days: number | null }
}

// zod at the boundary (house rule): REST query strings, an MCP tool's arguments
// and the scheduler all reach this function, so the window is validated once
// here rather than three times outside.
//
// `top` defaults to 5, not to the coverage route's 10: the lists are context
// beside the queue numbers on a maintenance page, not the subject of it, and a
// briefing that names ten hub pages every morning trains its reader to skip the
// section.
const zSpaceHealthArgs = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  top: z.coerce.number().int().min(1).max(25).default(5),
  // Threaded to lintSpace, whose default is already deep — restated here so the
  // three transports validate the same vocabulary once.
  tier: z.enum(['quick', 'deep']).optional(),
})

export type SpaceHealthArgs = z.input<typeof zSpaceHealthArgs>

/**
 * Installation-level inputs, in a second bag after the caller's args — the
 * `search(db, spaceId, args, deps)` shape, for the same reason: one is a request,
 * the other is configuration, and mixing them invites a transport to accept a
 * request that sets configuration.
 *
 * `scaffoldingKinds` is required by the type (see ScaffoldingOptions in
 * concepts.ts for why the field, not the bag, carries the requirement) and is
 * threaded straight to lintSpace. `gapTopicsEnabled` mirrors the coverage
 * route's read of `config.coverageGapTopicsEnabled`.
 */
export interface SpaceHealthDeps extends ScaffoldingOptions {
  readonly gapTopicsEnabled: boolean
  /**
   * The installation's source index window in days, 0 meaning "indexed forever"
   * — reported as `archive.index_days`, and the caller's read of
   * `config.sourceIndexDays` for the same reason `gapTopicsEnabled` is: the
   * domain measures, the composition root knows what was configured.
   */
  readonly sourceIndexDays: number
}

/** Thirty days — the window a maintenance report describes when nobody says. */
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Compose the space's health. No LLM call, and no write — this is a read even
 * when the scheduler is the caller.
 *
 * Sequential on purpose, exactly as lintSpace argues internally: this issues
 * lint's queries plus coverage's plus two of its own over ONE pool, and firing
 * them in parallel would hold a fistful of connections for a diagnostics
 * request. The scheduler runs it once a day; the cockpit runs it when somebody
 * opens the page.
 */
export async function spaceHealth(
  db: Db,
  spaceId: string,
  args: SpaceHealthArgs,
  deps: SpaceHealthDeps,
): Promise<SpaceHealth> {
  const input = zSpaceHealthArgs.parse(args)
  // Rejected: resolveStatsWindow from src/stats.ts. It answers a different
  // question — a BUCKETED series, so it carries a `bucket` this shape has no
  // use for — and its default window is the last 24 hours, which measures
  // nothing on a review queue whose head is weeks old.
  const to = input.to ? new Date(input.to) : new Date()
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - DEFAULT_WINDOW_MS)
  if (to <= from) throw new ValidationError("'to' must be after 'from'")
  const window = { from: from.toISOString(), to: to.toISOString() }
  const checkedAt = new Date().toISOString()

  const lint = await lintSpace(db, spaceId, {
    scaffoldingKinds: deps.scaffoldingKinds,
    tier: input.tier ?? 'deep',
  })
  const coverage = await getCoverageStats(db, spaceId, { ...window, top: input.top })

  // Deliberately the same query shape coverage.ts uses for open disputes:
  // count + age of the oldest, one statement, the age read off min(created_at).
  // The queue an operator has to clear and the disputes they have to adjudicate
  // are the same kind of backlog, and reading alike is worth more here than a
  // cleverer statement.
  const [review] = (
    await db.query<{ pending: number; oldest_days: number | null }>(
      `SELECT count(*)::int AS pending,
              floor(extract(epoch FROM now() - min(created_at)) / 86400)::int AS oldest_days
         FROM wk_change_proposals
        WHERE space_id = $1 AND status = 'pending'`,
      [spaceId],
    )
  ).rows
  // `changes_requested` pending rows are counted in: they are still waiting on
  // a human, just on the other side of the exchange, and a queue depth that
  // excluded them would under-report the work a space has generated.

  // Live queue state, not history. `min(created_at) FILTER (WHERE …)` gives the
  // head of the QUEUED backlog specifically — a running job's age is the
  // heartbeat's business (src/http/jobs.ts), while the wait at the head of the
  // queue is what says whether the worker is keeping up.
  //
  // In HOURS, not days, unlike the review queue: ingest drains in minutes when
  // it is healthy, so a queue stuck since this morning would print "0 days" —
  // a number that reads like reassurance. One decimal, matching
  // coverage.review_latency.median_hours.
  // Captured rows are counted in the same statement but never in `depth`: a
  // parked thought is not in flight, and its age is read in DAYS off the same
  // min() FILTER shape — the review queue's unit, because the wait that matters
  // is the one stale-captures warns about at thirty days.
  const [ingest] = (
    await db.query<{
      queued: number
      running: number
      quota_blocked: number
      oldest_queued_hours: number | null
      captured: number
      oldest_captured_days: number | null
    }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'running')::int AS running,
              count(*) FILTER (WHERE status = 'quota_blocked')::int AS quota_blocked,
              round((extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'queued')) / 3600)::numeric, 1)::float
                AS oldest_queued_hours,
              count(*) FILTER (WHERE status = 'captured')::int AS captured,
              floor(extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'captured')) / 86400)::int
                AS oldest_captured_days
         FROM wk_ingest_jobs
        WHERE space_id = $1 AND status IN ('queued', 'running', 'quota_blocked', 'captured')`,
      [spaceId],
    )
  ).rows

  // The archive census, one statement: every source, and the ones a chunk row
  // still points at. EXISTS rather than a join on wk_source_chunks — a source
  // has many chunks and this counts sources, not rows.
  const [archive] = (
    await db.query<{ sources: number; indexed: number }>(
      `SELECT count(*)::int AS sources,
              count(*) FILTER (
                WHERE EXISTS (SELECT 1 FROM wk_source_chunks c WHERE c.source_id = s.id))::int AS indexed
         FROM wk_sources s
        WHERE s.space_id = $1`,
      [spaceId],
    )
  ).rows
  const [guidelines] = await db.select<{ rev: number; created_at: Date | string }>('wk_charter_revisions', {
    space_id: `eq.${spaceId}`,
    status: 'eq.current',
    limit: 1,
  })

  const pending = review?.pending ?? 0
  const queued = ingest?.queued ?? 0
  const running = ingest?.running ?? 0
  const captured = ingest?.captured ?? 0
  const sources = archive?.sources ?? 0
  const indexed = archive?.indexed ?? 0
  return {
    checked_at: checkedAt,
    guidelines: {
      revision: guidelines?.rev ?? null,
      updated_at: guidelines ? isoString(guidelines.created_at) : null,
    },
    window,
    lint,
    coverage: {
      disputed: coverage.disputed,
      review_latency: coverage.review_latency,
      freshness: coverage.freshness,
      top_read_concepts: coverage.top_read_concepts,
      top_linked_concepts: coverage.top_linked_concepts,
      gap_topics: { enabled: deps.gapTopicsEnabled, items: coverage.gap_topics },
    },
    // The count gates the age in TS as well as in SQL. min() over no rows is
    // already null, so this guards the other producer: a stubbed pool (unit
    // tests) hands back whatever it was told to, and coverage.ts gates its own
    // ages the same way for the same reason.
    review_queue: { pending, oldest_days: pending ? (review?.oldest_days ?? null) : null },
    ingest_queue: {
      depth: queued + running,
      queued,
      running,
      quota_blocked: ingest?.quota_blocked ?? 0,
      oldest_queued_hours: queued ? (ingest?.oldest_queued_hours ?? null) : null,
      captured,
      oldest_captured_days: captured ? (ingest?.oldest_captured_days ?? null) : null,
    },
    archive: {
      sources,
      indexed,
      // Subtracted, never counted a second time: two FILTERs over the same
      // table could disagree under a concurrent write, and a census whose parts
      // do not add up to its total is worse than a slightly stale one.
      unindexed: sources - indexed,
      // 0 is a window nobody set, and the block refuses to print it as one —
      // the same rule the ages above follow.
      index_days: deps.sourceIndexDays > 0 ? deps.sourceIndexDays : null,
    },
  }
}

/** Proposal review numbers used by the agent briefing. */
export interface OverviewRow {
  pending: number
  oldest_days: number | null
}

/**
 * The per-space proposal review numbers for MANY spaces at once. This powers
 * the agent briefing's explicitly proposal-only `pending_changes` block.
 *
 * A space with no proposal rows is still an answer: `{pending: 0, oldest_days:
 * null, …}` — a measured zero, with no age because there is no queue. The Map
 * carries every requested id, and an empty request is an empty Map with no
 * query issued.
 */
export async function reviewOverview(db: Db, spaceIds: readonly string[]): Promise<Map<string, OverviewRow>> {
  const overview = new Map<string, OverviewRow>()
  if (spaceIds.length === 0) return overview
  for (const id of spaceIds) {
    overview.set(id, { pending: 0, oldest_days: null })
  }

  // One statement over wk_change_proposals, aggregated per space.
  const proposals = await db.query<{
    space_id: string
    pending: number
    oldest_days: number | null
  }>(
    `SELECT p.space_id,
            count(*) FILTER (WHERE p.status = 'pending')::int AS pending,
            floor(extract(epoch FROM now() - min(p.created_at) FILTER (WHERE p.status = 'pending')) / 86400)::int
              AS oldest_days
       FROM wk_change_proposals p
      WHERE p.space_id = ANY($1::uuid[])
      GROUP BY p.space_id`,
    [spaceIds],
  )
  for (const row of proposals.rows) {
    const entry = overview.get(row.space_id)
    if (!entry) continue
    entry.pending = row.pending
    entry.oldest_days = row.pending ? row.oldest_days : null
  }

  return overview
}

/** What the overview needs to know about a wiki — the slug/name/settings slice of a space row. */
export interface OverviewSpace {
  id: string
  slug: string
  name: string
  settings: Record<string, unknown>
}

export interface SpacesOverview {
  generated_at: string
  totals: { open: number; oldest_days: number | null; wikis_with_open: number }
  items: {
    space: string
    name: string
    purpose: string | null
    environment: 'production' | 'test'
    attention: {
      open: number
      oldest_days: number | null
      by_kind: { proposal: number; triage: number }
    }
    concepts: number
  }[]
}

interface AttentionOverviewRow {
  open: number
  oldest_days: number | null
  by_kind: { proposal: number; triage: number }
  concepts: number
}

/** Human gates across spaces — findings are observations and never enter this count. */
export async function attentionOverview(
  db: Db,
  spaceIds: readonly string[],
): Promise<Map<string, AttentionOverviewRow>> {
  const overview = new Map<string, AttentionOverviewRow>()
  if (!spaceIds.length) return overview
  for (const id of spaceIds) {
    overview.set(id, {
      open: 0,
      oldest_days: null,
      by_kind: { proposal: 0, triage: 0 },
      concepts: 0,
    })
  }

  const attention = await db.query<{
    space_id: string
    kind: 'proposal' | 'triage'
    open: number
    oldest_days: number
  }>(
    `SELECT item.space_id, item.kind, count(*)::int AS open,
            floor(extract(epoch FROM now() - min(item.created_at)) / 86400)::int AS oldest_days
       FROM (
         SELECT space_id, 'proposal'::text AS kind, created_at
           FROM wk_change_proposals p
          WHERE p.space_id = ANY($1::uuid[]) AND p.status = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM wk_attention_states a
               WHERE a.space_id = p.space_id AND a.item_key = 'proposal:' || p.id::text
            )
         UNION ALL
         SELECT space_id, 'triage'::text AS kind, created_at
           FROM wk_ingest_jobs j
          WHERE j.space_id = ANY($1::uuid[]) AND j.status = 'captured'
            AND NOT EXISTS (
              SELECT 1 FROM wk_attention_states a
               WHERE a.space_id = j.space_id AND a.item_key = 'triage:' || j.id::text
            )
       ) item
      GROUP BY item.space_id, item.kind`,
    [spaceIds],
  )
  for (const row of attention.rows) {
    const entry = overview.get(row.space_id)
    if (!entry) continue
    if (!(row.kind in entry.by_kind)) continue
    const open = Number(row.open)
    const oldest = Number(row.oldest_days)
    if (!Number.isFinite(open) || !Number.isFinite(oldest)) continue
    entry.by_kind[row.kind] = open
    entry.open += open
    entry.oldest_days = Math.max(entry.oldest_days ?? 0, oldest)
  }

  const concepts = await db.query<{ space_id: string; concepts: number }>(
    `SELECT space_id, count(*)::int AS concepts
       FROM wk_concepts
      WHERE space_id = ANY($1::uuid[]) AND current_revision_id IS NOT NULL
      GROUP BY space_id`,
    [spaceIds],
  )
  for (const row of concepts.rows) {
    const entry = overview.get(row.space_id)
    if (entry) entry.concepts = Number(row.concepts)
  }
  return overview
}

/**
 * The whole cross-wiki overview, composed once for GET /v1/stats/overview and
 * the wikikit_overview MCP tool — one producer, one set of numbers, exactly
 * like spaceHealth above. The caller passes the spaces the KEY may see; this
 * function invents no visibility of its own.
 *
 * Totals are computed here rather than by each client, because eight rows
 * summed in three renderers is three chances to disagree. `totals.oldest_days`
 * is the max over the rows — the wait a human should clear first — and null
 * exactly when nothing anywhere is pending. No verdict, no percentages, for
 * the reasons the module header argues.
 */
export async function spacesOverview(db: Db, spaces: readonly OverviewSpace[]): Promise<SpacesOverview> {
  const rows = await attentionOverview(
    db,
    spaces.map((space) => space.id),
  )
  const items = spaces.map((space) => {
    const row = rows.get(space.id) ?? {
      open: 0,
      oldest_days: null,
      by_kind: { proposal: 0, triage: 0 },
      concepts: 0,
    }
    // The same fallback the cockpit's wiki list renders: both keys feed context
    // selection, and a wiki configured with only `description` should not read
    // as purposeless here while the server happily ranks on it.
    const settings = space.settings ?? {}
    const purpose = settings.purpose ?? settings.description
    return {
      space: space.slug,
      name: space.name,
      purpose: typeof purpose === 'string' && purpose.length > 0 ? purpose : null,
      environment: settings.environment === 'test' ? ('test' as const) : ('production' as const),
      attention: {
        open: row.open,
        oldest_days: row.oldest_days,
        by_kind: row.by_kind,
      },
      concepts: row.concepts,
    }
  })
  const totals = items.reduce(
    (sum, item) => ({
      open: sum.open + item.attention.open,
      wikis_with_open: sum.wikis_with_open + (item.attention.open > 0 ? 1 : 0),
      oldest_days:
        item.attention.oldest_days === null
          ? sum.oldest_days
          : Math.max(sum.oldest_days ?? 0, item.attention.oldest_days),
    }),
    { open: 0, wikis_with_open: 0, oldest_days: null as number | null },
  )
  return { generated_at: new Date().toISOString(), totals, items }
}
