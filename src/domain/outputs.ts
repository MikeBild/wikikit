// wk_outputs — what the knowledge base produced, and the one door back in
// (CONTRACTS §1, §4).
//
// An answer, a scheduled briefing or a health report is a derived artifact: it
// is regenerable, it is not evidence, and it is NOT knowledge. This module owns
// its whole lifecycle — record it, list it, read it, promote it, expire it —
// and protects two invariants that nothing else can:
//
//   1. PROMOTION IS ORDINARY INGEST, NEVER A SHORTCUT. promoteOutput does not
//      write concepts or claims. It renders the output as markdown and hands it
//      to the same pipeline a human's document goes through, so the promoted
//      text inherits content-hash dedup, the verbatim-quote grounding guard,
//      contradiction detection and the one-proposal-per-run review gate. An
//      answer synthesized FROM the wiki must not become the source of the next
//      answer without a human in between; that is why there is no automatic
//      feedback path here and why the resulting source is marked
//      `derived_from_output_id` (lint can then flag knowledge whose only
//      evidence is itself).
//   2. THE RENDERING IS DETERMINISTIC. renderOutputSource never emits a
//      timestamp or an id, so promoting the same row twice produces
//      byte-identical markdown, the same sha256, and therefore
//      `already_ingested` instead of a second proposal. Same reasoning as
//      renderLearnings in src/agent/sessions.ts — the ingest pipeline's
//      idempotency is only usable by callers whose text is stable.
//
// The pipeline is NOT imported: promoteOutput takes the one method it calls as
// a structural dependency (see PromoteDeps), the same way src/agent/sessions.ts
// declares its deps. A domain module that imported the worker would drag the
// LLM provider, the acquirer and the config into every unit test that merely
// lists rows.
import { z } from 'zod'
import type { Db } from '../db/postgres.ts'
import { NotFoundError } from './errors.ts'
import { clampLimit, decodeCursor, encodeCursor, isoString, summarizeSource } from './sources.ts'

/**
 * How the output came to be — a closed set (DB CHECK):
 * `answer` (/query), `briefing` and `health` (the scheduler).
 */
export type OutputKind = 'answer' | 'briefing' | 'health'

/** A cited concept page, as the answer named it at the time (denormalized). */
export interface OutputCitation {
  slug: string
  title: string
}

export interface Output {
  id: string
  /**
   * Returned for the same reason IngestJobStatus returns it: getOutput is
   * global-by-id, so the TRANSPORT needs the space to enforce the key/space
   * match. Not a secret and cheap to carry, so it stays on the wire shape
   * rather than becoming a second out-of-band return value.
   */
  space_id: string
  kind: OutputKind
  title: string
  summary: string
  /** The question that was asked (kind='answer'); null for the other kinds. */
  question: string | null
  markdown: string
  citations: OutputCitation[]
  /** The honest "the base does not cover this" flag; null outside kind='answer'. */
  not_in_knowledge_base: boolean | null
  /** wk_agent_runs row of the call that produced this — the audit anchor. */
  agent_run_id: string | null
  /** The ingest job promotion created; null while unpromoted. */
  promoted_ingest_id: string | null
  promoted_at: string | null
  created_at: string
}

interface OutputRow {
  id: string
  space_id: string
  kind: OutputKind
  title: string
  question: string | null
  markdown: string
  citations: OutputCitation[] | string | null
  not_in_knowledge_base: boolean | null
  agent_run_id: string | null
  promoted_ingest_id: string | null
  promoted_at: Date | string | null
  created_at: Date | string
}

/**
 * The ONLY producer of the Output wire shape (the rule src/http/jobs.ts
 * states): list, read and promote all map through here, so a field can never
 * appear on one route and be missing on another.
 */
function toOutput(row: OutputRow): Output {
  return {
    id: row.id,
    space_id: row.space_id,
    kind: row.kind,
    title: row.title,
    summary: summarizeSource(row.markdown),
    question: row.question ?? null,
    markdown: row.markdown,
    // pg parses jsonb into an array, but a stubbed pool (unit tests) hands back
    // the string that was inserted — normalize either way, same as jobs.ts does
    // for the error column.
    citations:
      typeof row.citations === 'string' ? (JSON.parse(row.citations) as OutputCitation[]) : (row.citations ?? []),
    not_in_knowledge_base: row.not_in_knowledge_base ?? null,
    agent_run_id: row.agent_run_id ?? null,
    promoted_ingest_id: row.promoted_ingest_id ?? null,
    promoted_at: row.promoted_at == null ? null : isoString(row.promoted_at),
    created_at: isoString(row.created_at),
  }
}

// zod at the boundary (house rule): REST /query, the MCP layer and the
// in-process scheduler all call these functions, so the shape is checked here
// instead of once per transport.
const zCitations = z.array(z.object({ slug: z.string().min(1).max(200), title: z.string().max(500) })).max(100)

const zRecordOutputArgs = z
  .object({
    kind: z.enum(['answer', 'briefing', 'health']),
    title: z.string().min(1).max(500),
    /** Absent → null. Never defaulted to the title: "no question" is a fact. */
    question: z.string().min(1).max(2000).optional(),
    markdown: z.string().min(1),
    citations: zCitations.optional(),
    not_in_knowledge_base: z.boolean().optional(),
    agent_run_id: z.uuid().optional(),
  })
  // The column's tri-state is only meaningful for answers (see the migration):
  // a briefing is not "in" or "out" of the knowledge base, so a caller passing
  // the flag on one has misunderstood the field. Refuse instead of storing a
  // value no reader can interpret.
  .refine((value) => value.not_in_knowledge_base === undefined || value.kind === 'answer', {
    message: 'not_in_knowledge_base applies only to kind=answer',
  })

export type RecordOutputArgs = z.input<typeof zRecordOutputArgs>

/**
 * Persist one produced artifact. No dedup and no uniqueness: asking the same
 * question twice is two events worth keeping (the answer may have changed as
 * the wiki grew), and collapsing them would hide exactly that. Dedup happens
 * one layer later, at promotion, where it belongs — see renderOutputSource.
 */
export async function recordOutput(db: Db, spaceId: string, args: RecordOutputArgs): Promise<Output> {
  const input = zRecordOutputArgs.parse(args)
  const [row] = await db.insert<OutputRow>('wk_outputs', {
    space_id: spaceId,
    kind: input.kind,
    title: input.title,
    question: input.question ?? null,
    markdown: input.markdown,
    citations: JSON.stringify(input.citations ?? []),
    not_in_knowledge_base: input.not_in_knowledge_base ?? null,
    agent_run_id: input.agent_run_id ?? null,
  })
  return toOutput(row!)
}

const zListOutputsArgs = z.object({
  kind: z.enum(['answer', 'briefing', 'health']).optional(),
  limit: z.number().int().optional(),
  before: z.string().min(1).optional(),
})

export type ListOutputsArgs = z.input<typeof zListOutputsArgs>

/**
 * List outputs newest-first with keyset pagination — same shape and same
 * reasoning as listSources: a `before` cursor walking backwards in time is the
 * natural direction for an archive, and the over-fetch of one row IS the
 * has-more signal (no COUNT ever runs).
 *
 * Unlike listSources this returns FULL rows including markdown, because an
 * output's markdown is an answer (kilobytes), not an ingested document
 * (megabytes) — a detail fetch per row would cost more than it saves. The page
 * size is smaller than the source list's for exactly that reason.
 */
export async function listOutputs(
  db: Db,
  spaceId: string,
  args: ListOutputsArgs = {},
): Promise<{ items: Output[]; next_before: string | null }> {
  const input = zListOutputsArgs.parse(args)
  const limit = clampLimit(input.limit, 25, 100)
  const values: unknown[] = [spaceId]
  let filter = ''
  if (input.kind) {
    values.push(input.kind)
    filter = ` AND kind = $${values.length}`
  }
  let keyset = ''
  if (input.before) {
    const [id] = decodeCursor(input.before, 1)
    values.push(id)
    // The cursor carries ONLY the boundary row's id; its created_at is re-read
    // in SQL. WHY: serializing the timestamp through JS would truncate
    // Postgres's microsecond timestamptz to Date's milliseconds, so every row
    // sharing the boundary's millisecond — a scheduler run that writes a
    // briefing and a health report back to back — would become unreachable.
    // Row-value comparison keeps id DESC as the tiebreak, mirroring ORDER BY.
    keyset = ` AND (created_at, id) < (SELECT created_at, id FROM wk_outputs WHERE id = $${values.length}::uuid)`
  }
  values.push(limit + 1)
  const { rows } = await db.query<OutputRow>(
    `SELECT id, space_id, kind, title, question, markdown, citations, not_in_knowledge_base,
            agent_run_id, promoted_ingest_id, promoted_at, created_at
       FROM wk_outputs
      WHERE space_id = $1${filter}${keyset}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}`,
    values,
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(toOutput),
    next_before: rows.length > limit && last ? encodeCursor(last.id) : null,
  }
}

const zOutputId = z.uuid('output id must be a uuid')

/**
 * One output by id. ⚠ Global-by-id per the §4 convention, for the same reason
 * as getIngestJob: the id is what a client got back from /query or from the
 * list, and it does not carry the space slug. The row's space_id rides on the
 * returned shape so the transport enforces the key/space match — this module
 * never sees a principal.
 */
export async function getOutput(db: Db, id: string): Promise<Output> {
  // Parsed, not passed through: an id like 'latest' would reach Postgres as an
  // invalid uuid literal and surface as a 500 instead of a 400.
  const outputId = zOutputId.parse(id)
  const [row] = await db.select<OutputRow>('wk_outputs', { id: `eq.${outputId}`, limit: 1 })
  if (!row) throw new NotFoundError(`output ${outputId} not found`)
  return toOutput(row)
}

/**
 * Render an output as the markdown source the ingest pipeline archives.
 *
 * DETERMINISTIC BY CONTRACT — no timestamps, no ids, no "generated at". The
 * whole promote path leans on it: identical bytes → identical sha256 →
 * `already_ingested`, which is how re-promoting stays free instead of piling up
 * duplicate proposals for a human to reject. Anything derived from wall-clock
 * time or a row id in here silently breaks that (renderLearnings in
 * src/agent/sessions.ts carries the same warning).
 *
 * The question and the cited page slugs are rendered as PROSE so the archived
 * source is self-describing: read on its own, months later, it says what was
 * asked and which pages the answer leaned on. The answer text itself rides
 * along verbatim because the grounding guard checks every synthesized claim's
 * quote against this exact string.
 */
export function renderOutputSource(output: Output): string {
  const sections: string[] = [`# ${output.title}`]
  if (output.question) {
    sections.push(`This page records the answer WikiKit gave to the question: ${output.question}`)
  }
  sections.push(output.markdown.trim())
  if (output.citations.length > 0) {
    // Citation ORDER is left as the answer produced it, not sorted: the order
    // is part of what the answer said, and determinism only requires stability
    // for the same row — which insertion order already gives.
    const cited = output.citations.map((citation) => `- ${citation.title} (${citation.slug})`).join('\n')
    sections.push(`The answer cited these knowledge pages:\n\n${cited}`)
  }
  return `${sections.join('\n\n')}\n`
}

/**
 * The single pipeline method promotion needs. Structural, not `IngestPipeline`:
 * see the module header for why the domain layer does not import the worker.
 * Written as a method (not a property) so the real pipeline — whose parameter
 * type is the wider IngestRequest — stays assignable.
 */
export interface PromoteDeps {
  ingest: {
    enqueue(
      db: Db,
      spaceId: string,
      args: {
        markdown: string
        title: string
        source_kind: 'note'
        derived_from_output_id: string
      },
    ): Promise<{ ingest_id: string } | { status: 'unchanged' }>
  }
}

/**
 * Promote an output back into the wiki: archive its markdown as a source and
 * let the ordinary pipeline stage a proposal a human reviews. Deliberately an
 * explicit human act — nothing calls this on a schedule.
 *
 * RE-PROMOTION IS IDEMPOTENT AND CHEAP: an already-promoted row returns its
 * stored ingest_id without touching the pipeline. Re-enqueueing would also be
 * *correct* (the deterministic rendering converges on the same content hash, so
 * the pipeline answers already_ingested), but it would cost a round trip and
 * turn a duplicate click into a 409 the caller has to interpret. Returning the
 * first job is the same answer with a better shape: the caller lands on the
 * change that already exists.
 *
 * A first promotion whose markdown is ALREADY archived (a different output said
 * the same thing, or the source was ingested by hand) surfaces the pipeline's
 * ConflictError('already_ingested') unchanged — there is no job to point at, and
 * the honest answer is "this evidence is already in the base". Such a row stays
 * unpromoted and therefore collectable, which loses nothing: its text lives on
 * as the source that caused the conflict.
 */
export async function promoteOutput(db: Db, deps: PromoteDeps, id: string): Promise<{ ingest_id: string }> {
  const output = await getOutput(db, id)
  if (output.promoted_ingest_id) return { ingest_id: output.promoted_ingest_id }

  const enqueued = await deps.ingest.enqueue(db, output.space_id, {
    markdown: renderOutputSource(output),
    title: output.title,
    // Not a meeting: decision mining would read an answer's prose as decisions
    // that were never taken. Not an article either — this is house-produced.
    source_kind: 'note',
    // A real input field, not loose metadata: the worker re-parses the stored
    // job input with the same schema, and an unknown key would be dropped there
    // — the derivation marker has to survive into wk_sources.metadata for the
    // self-derived lint rule to see it.
    derived_from_output_id: output.id,
  })
  // The sync fast-path only fires for external_source_id inputs, which this
  // call never sets — the narrowing is a type-level formality (same situation
  // as captureSession).
  if (!('ingest_id' in enqueued)) throw new Error('promote enqueue returned a sync result for a non-sync input')

  await db.update(
    'wk_outputs',
    { id: `eq.${output.id}` },
    { promoted_ingest_id: enqueued.ingest_id, promoted_at: new Date().toISOString() },
    { returning: false },
  )
  return { ingest_id: enqueued.ingest_id }
}

/**
 * Retention sweep (WIKIKIT_OUTPUT_RETENTION_DAYS), called from the hourly
 * cleanup timer. Returns how many rows were deleted.
 *
 * Only UNPROMOTED rows are collectable: a promoted output's markdown already
 * lives on as an archived source (verbatim, forever), so deleting the row would
 * cut the provenance link from that source back to the answer it came from
 * while freeing nothing. Unpromoted outputs are regenerable by re-asking.
 *
 * retentionDays <= 0 means keep forever — the operator's opt-out, and the
 * reason this returns early instead of computing a window of zero days, which
 * would delete everything.
 */
export async function cleanupOutputs(db: Db, retentionDays: number): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0
  const { rows } = await db.query<{ deleted: number }>(
    `WITH deleted AS (
       DELETE FROM wk_outputs
        WHERE promoted_at IS NULL
          AND created_at < now() - ($1::int * interval '1 day')
        RETURNING 1
     ) SELECT count(*)::int AS deleted FROM deleted`,
    [Math.floor(retentionDays)],
  )
  return Number(rows[0]?.deleted ?? 0)
}
