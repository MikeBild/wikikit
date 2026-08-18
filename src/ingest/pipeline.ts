// Ingest pipeline — the product heart (plan §4, CONTRACTS §4.1):
//
//   acquire → archive+dedup → classify → synthesize (per concept)
//           → contradiction-detect → propose (one staging tx) → job done
//
// Split into a fast synchronous enqueue (insert a queued wk_ingest_jobs row,
// no LLM, so HTTP can answer 202 immediately) and a background worker that
// claims jobs with FOR UPDATE SKIP LOCKED — multiple pipeline instances (or
// multiple loops in one process) never double-process a job.
//
// Atomicity boundaries, deliberately TWO transactions per successful job:
//   1. createProposal — proposal row + proposed revisions/claims/citations/
//      relations + the proposal.created outbox event, one tx (the §4
//      CreateProposalArgs contract; the review gate's consistency lives there).
//   2. wk_agent_runs rows + the wk_ingest_jobs status flip, one tx.
//   WHY not one big tx: createProposal owns its transaction (and db.tx
//   refuses nesting by design). If the process dies between the two, the
//   proposal exists but the job stays 'running' — the reaper flips it to
//   failed, and a client re-submit converges on the SAME pending proposal via
//   the input_hash dedup index, so no duplicate review work can result. The
//   only loss in that crash window is audit telemetry, never knowledge state.
//
// Re-submit semantics on a content-hash hit: 409 already_ingested ONLY when
// the archived source is still doing work — a pending/approved proposal
// references it, or a queued/running/done job produced it. A source whose job
// FAILED after the archive step (LLM 5xx, worker crash → worker_lost) blocks
// nothing: re-submitting the identical content is the documented recovery
// path (§9.1), so enqueue proceeds and the worker reuses the archived row
// instead of dead-ending on the hash.
//
// Provider quota exhaustion is NON-terminal: the claimed job parks as
// quota_blocked (resume_at parsed from the provider message, +6h fallback),
// this process stops claiming until resume_at, and requeueQuotaBlocked flips
// parked jobs back to queued once the window reopens — no work is lost and
// nothing needs a re-submit.
//
// Every LLM call is recorded (classify + one synthesize per concept) and the
// rows are persisted even when the job FAILS afterwards — cost telemetry from
// day one (plan §15.4) must include the money burned on failed jobs.
import { randomUUID } from 'node:crypto'
import { DEFAULT_INGEST_MAX_QUEUED_PER_SPACE, type Config } from '../config.ts'
import type { Db } from '../db/postgres.ts'
import { getConcept, getConceptIndex } from '../domain/concepts.ts'
import { latestCharterMarkdown } from '../domain/charter.ts'
import { findContradictions, getPredicateRegistry, type IncomingClaim } from '../domain/claims.ts'
import { listActiveDecisionsForDedupe } from '../domain/decisions.ts'
import {
  ConflictError,
  IngestQueueFullError,
  LlmNotConfiguredError,
  NotFoundError,
  UnprocessableError,
} from '../domain/errors.ts'
import { computeInputHash, createProposal, type CreateProposalArgs } from '../domain/proposals.ts'
import { createSource, persistSourceChunks, sha256Hex } from '../domain/sources.ts'
import { recordStreamVersion } from '../domain/source-streams.ts'
import { generateWithLanguageRepair, type GeneratedLanguage } from '../llm/language.ts'
import type { LlmProvider, LlmRunMeta } from '../llm/provider.ts'
import { hasWikiKitProvenance } from '../markdown.ts'
import { PROMPT_VERSIONS } from '../llm/prompts/index.ts'
import type { Logger } from '../logger.ts'
import type { Metrics } from '../metrics.ts'
import { createAcquirer, zIngestInput, type Acquirer, type IngestInput } from './acquire.ts'
import { fitTokenBudget } from './chunk.ts'

export type IngestRequest = IngestInput
export { zIngestInput }

interface SpaceRuntime {
  slug: string
  predicates: string[]
  charter: string
  language?: GeneratedLanguage
}

/** Sync fast-path result: nothing new for the LLM — the stream head advanced (or already pointed here). */
export interface IngestUnchanged {
  status: 'unchanged'
  source_id: string
  stream_id: string
}

/** Capture result: the row is parked, nothing runs until a human promotes it. */
export interface IngestCaptured {
  status: 'captured'
  ingest_id: string
}

export type CaptureResolution =
  | { action: 'process'; targetSpaceId: string; title: string; summary: string }
  | { action: 'use_existing'; targetSpaceId: string; sourceId: string; title: string; summary: string }
  | { action: 'leave'; title: string; summary: string; question: string | null }
  | { action: 'discard'; title: string; summary: string }

export interface IngestPipeline {
  /**
   * Insert a queued wk_ingest_jobs row and return its id (fast, no LLM).
   * Sync inputs (external_source_id) may short-circuit to
   * {status:'unchanged'} when the content is already archived — connectors
   * retry blindly, so known content is a head-pointer advance, never a 409.
   */
  enqueue(
    db: Db,
    spaceId: string,
    args: IngestRequest,
  ): Promise<{ ingest_id: string } | IngestUnchanged | IngestCaptured>
  /** Resolve one captured row through the single human-owned triage action. */
  resolveCapture(db: Db, id: string, resolution: CaptureResolution): Promise<void>
  /** Start the background worker loops (config.ingestConcurrency of them). */
  start(): void
  /** Stop claiming new jobs and wait for in-flight ones to finish. */
  stop(): Promise<void>
  /**
   * Claim and process at most one queued job; returns whether one was
   * processed. Exposed beyond the §4.1 interface so tests (and future ops
   * tooling) can drive the worker deterministically without timer loops —
   * start() is nothing but this in a loop.
   */
  runOnce(): Promise<boolean>
}

// Fallback predicate vocabulary when a space has not configured
// wk_spaces.settings.predicates. Small and generic on purpose: the controlled
// vocabulary is the v0.1 mitigation for frame-collision quality (plan §15.2) —
// a broad default would dilute exact-frame contradiction detection.
const DEFAULT_PREDICATES = [
  'is',
  'has',
  'has_status',
  'uses',
  'depends_on',
  'part_of',
  'located_in',
  'created_by',
  'supersedes',
  'released_on',
] as const

const DEFAULT_LEASE_MS = 15 * 60 * 1000
const DEFAULT_HEARTBEAT_MS = 30 * 1000
const DEFAULT_MAX_RUNTIME_MS = 90 * 60 * 1000

const DEFAULT_POLL_MS = 1000

// Provider quota exhaustion is a PAUSE, never a failure: the work is intact
// and the provider names (or implies) when it becomes possible again. A
// quota-hit job parks as status='quota_blocked' with resume_at; the worker
// requeues it once resume_at passes and stops claiming until then, so a
// 20-job backlog costs ONE error line instead of 20 dead jobs.
const QUOTA_FALLBACK_RESUME_MS = 6 * 60 * 60 * 1000

// Upper bound on adjudication calls per job: adjudication refines the
// reviewer summary, it must never turn one ingest into an unbounded fan-out.
const ADJUDICATION_CAP = 10

// Upper bound on decisions staged per ingest. A source that genuinely settles
// more than ten choices exists, but a list this long is far more often a model
// splitting one decision into variants — and a proposal a human cannot review
// in one sitting is a proposal that does not get reviewed.
const DECISIONS_CAP = 10

/** Anthropic's usage-limit message (and generic quota phrasing) — never model refusals or 5xx. */
function isQuotaExhausted(message: string): boolean {
  return /reached your specified API usage limits|quota exceeded|exceeded your.*quota/i.test(message)
}

/**
 * resume_at from the provider message ("You will regain access on 2026-08-01
 * at 00:00 UTC"); null when the message names no parseable reset time.
 */
export function parseQuotaResumeAt(message: string): string | null {
  const match = message.match(/regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}) UTC/)
  if (!match) return null
  const parsed = Date.parse(`${match[1]}T${match[2]}:00Z`)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

// Verbatim-quote fidelity: a claim's quote must occur in the source the model
// actually read. Normalization (collapse whitespace, case-insensitive) matches
// the benchmarked check that had 0 false positives on real synthesis while
// still catching a quote the model invented or paraphrased.
function quoteGroundedIn(quote: string, sourceMarkdown: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  return norm(sourceMarkdown).includes(norm(quote))
}

interface JobRow {
  id: string
  space_id: string
  input: IngestInput
  lease_owner: string
}

/**
 * The stages a running job walks through, in order. Advisory diagnostics: a
 * reader that does not know a value treats the job as simply 'running', so
 * adding a stage needs no migration and no client release.
 */
export type IngestPhase = 'acquire' | 'classify' | 'synthesize' | 'decisions' | 'adjudicate' | 'propose'

interface AgentRunDraft {
  kind: 'classify' | 'synthesize' | 'extract_decisions' | 'answer' | 'adjudicate'
  run: LlmRunMeta
}

export interface CreateIngestPipelineOptions {
  /** Worker poll interval; tests shrink it (not an env var — ops never tunes it). */
  pollMs?: number
  /** Injected fetch for URL acquisition (offline tests). */
  fetchImpl?: typeof fetch
  /** Injected acquirer (overrides fetchImpl when given). */
  acquirer?: Acquirer
  /** Test/embedding override; production uses WIKIKIT_INGEST_LEASE_MS. */
  leaseMs?: number
  /** Test/embedding override; production uses WIKIKIT_INGEST_HEARTBEAT_MS. */
  heartbeatMs?: number
  /** Test/embedding override; production uses WIKIKIT_INGEST_MAX_RUNTIME_MS. */
  maxRuntimeMs?: number
  /** Aggregate telemetry sink; never receives source/job/space identifiers. */
  metrics?: Pick<Metrics, 'ingestJob'>
}

export function createIngestPipeline(
  config: Config,
  db: Db,
  llm: LlmProvider,
  logger: Logger,
  options: CreateIngestPipelineOptions = {},
): IngestPipeline {
  const acquirer = options.acquirer ?? createAcquirer(config, { fetchImpl: options.fetchImpl })
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const leaseMs = options.leaseMs ?? config.ingestLeaseMs ?? DEFAULT_LEASE_MS
  const heartbeatMs = options.heartbeatMs ?? config.ingestHeartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const maxRuntimeMs = options.maxRuntimeMs ?? config.ingestMaxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS

  let running = false
  // Set when a claim hits provider quota exhaustion: no claims until it
  // passes. Process-local on purpose — the durable truth is the parked
  // quota_blocked rows; a restarted worker re-learns the pause from its
  // first claim at the cost of one extra LLM call.
  let quotaPausedUntil = 0
  const loops: Promise<void>[] = []
  // Early-wake sleep: stop() resolves every pending sleep so shutdown never
  // waits out a full poll interval.
  const wakers = new Set<() => void>()
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakers.delete(wake)
        resolve()
      }, ms)
      const wake = () => {
        clearTimeout(timer)
        resolve()
      }
      wakers.add(wake)
    })

  async function loadSpace(spaceId: string): Promise<SpaceRuntime> {
    const [space] = await db.select<{ slug: string; settings: Record<string, unknown> }>('wk_spaces', {
      id: `eq.${spaceId}`,
      limit: 1,
    })
    if (!space) throw new Error(`space ${spaceId} not found`)
    const configured = (space.settings ?? {})['predicates']
    const predicates =
      Array.isArray(configured) && configured.every((entry) => typeof entry === 'string') && configured.length > 0
        ? (configured as string[])
        : [...DEFAULT_PREDICATES]
    // The human-owned charter (latest revision) steers classify + synthesize.
    const charter = await latestCharterMarkdown(db, spaceId)
    const configuredLanguage = space.settings?.['language']
    const language = configuredLanguage === 'de' || configuredLanguage === 'en' ? configuredLanguage : undefined
    return { slug: space.slug, predicates, charter, ...(language ? { language } : {}) }
  }

  function agentRunRows(spaceId: string, jobId: string, proposalId: string | null, runs: AgentRunDraft[]) {
    return runs.map((draft) => ({
      space_id: spaceId,
      kind: draft.kind,
      model: draft.run.model,
      prompt_version: draft.run.prompt_version,
      input_hash: draft.run.input_hash,
      usage: JSON.stringify(draft.run.usage),
      duration_ms: draft.run.duration_ms,
      ingest_job_id: jobId,
      proposal_id: proposalId,
    }))
  }

  /** Terminal flip to done + audit rows, atomically (tx 2 of the design note above). */
  async function finishJob(
    job: JobRow,
    result: { sourceId: string | null; proposalId: string | null },
    runs: AgentRunDraft[],
  ): Promise<void> {
    await db.tx(async (tx) => {
      if (runs.length) await tx.insert('wk_agent_runs', agentRunRows(job.space_id, job.id, result.proposalId, runs))
      // Guarded on status='running': if the reaper (or anything else) already
      // moved the job to a terminal state, a terminal state must never
      // regress — a poller observing failed→done would violate §9.1.
      const flipped = await tx.update(
        'wk_ingest_jobs',
        { id: `eq.${job.id}`, status: 'eq.running', lease_owner: `eq.${job.lease_owner}` },
        {
          status: 'done',
          source_id: result.sourceId,
          proposal_id: result.proposalId,
          finished_at: new Date().toISOString(),
          lease_owner: null,
          lease_expires_at: null,
        },
      )
      if (!flipped.length) {
        logger.warn('ingest job finished after it was already terminal (reaped?) — keeping the terminal state', {
          ingest_id: job.id,
        })
      }
    })
  }

  /** Terminal flip to failed + audit rows + the ingest.failed event, atomically. */
  async function failJob(
    job: JobRow,
    spaceSlug: string,
    error: { code: string; message: string },
    sourceId: string | null,
    runs: AgentRunDraft[],
  ): Promise<void> {
    await db.tx(async (tx) => {
      if (runs.length) await tx.insert('wk_agent_runs', agentRunRows(job.space_id, job.id, null, runs))
      // Same terminal-state guard as finishJob; the event is only emitted for
      // the flip that actually happened (the reaper emits its own).
      const flipped = await tx.update(
        'wk_ingest_jobs',
        { id: `eq.${job.id}`, status: 'eq.running', lease_owner: `eq.${job.lease_owner}` },
        {
          status: 'failed',
          source_id: sourceId,
          error: JSON.stringify(error),
          finished_at: new Date().toISOString(),
          lease_owner: null,
          lease_expires_at: null,
        },
      )
      if (!flipped.length) {
        logger.warn('ingest job failed after it was already terminal (reaped?) — keeping the terminal state', {
          ingest_id: job.id,
        })
        return
      }
      await tx.emitEvent(job.space_id, 'wikikit.ingest.failed', { ingest_id: job.id, space: spaceSlug, error })
    })
  }

  /**
   * Non-terminal park to quota_blocked + audit rows, atomically. Deliberately
   * NO outbox event and no finished_at: the job is not failed — it requeues
   * on its own once resume_at passes (requeueQuotaBlocked), and webhook
   * consumers only ever learn about real terminal states.
   */
  async function quotaBlockJob(
    job: JobRow,
    resumeAt: string,
    error: { code: string; message: string },
    runs: AgentRunDraft[],
  ): Promise<void> {
    await db.tx(async (tx) => {
      if (runs.length) await tx.insert('wk_agent_runs', agentRunRows(job.space_id, job.id, null, runs))
      // Same terminal-state guard as finishJob/failJob.
      const flipped = await tx.update(
        'wk_ingest_jobs',
        { id: `eq.${job.id}`, status: 'eq.running', lease_owner: `eq.${job.lease_owner}` },
        {
          status: 'quota_blocked',
          resume_at: resumeAt,
          error: JSON.stringify(error),
          lease_owner: null,
          lease_expires_at: null,
        },
      )
      if (!flipped.length) {
        logger.warn('ingest job hit the quota after it was already terminal (reaped?) — keeping the terminal state', {
          ingest_id: job.id,
        })
      }
    })
  }

  /**
   * True when an archived source must still 409 a re-ingest: a pending or
   * approved proposal references it, or a non-failed job produced it. Failed
   * jobs (and rejected/failed proposals) block nothing — see the module
   * header's re-submit semantics. quota_blocked jobs DO block: they resume
   * on their own, so a re-submit would only stack duplicate work.
   */
  async function reingestBlocked(checkDb: Db, spaceId: string, sourceId: string): Promise<boolean> {
    const { rows } = await checkDb.query(
      `SELECT 1 AS blocked
         FROM wk_change_proposals
        WHERE space_id = $1 AND status IN ('pending', 'approved') AND $2::uuid = ANY(source_ids)
        UNION ALL
       SELECT 1
         FROM wk_ingest_jobs
        WHERE space_id = $1 AND source_id = $2 AND status IN ('queued', 'running', 'done', 'quota_blocked')
        LIMIT 1`,
      [spaceId, sourceId],
    )
    return rows.length > 0
  }

  /**
   * Record which stage a running job is in, and where it stands inside it.
   *
   * Advisory by construction: guarded on the same (status, lease_owner) pair
   * as the heartbeat so a job the reaper already took cannot be written back
   * to, and a failed write is logged and swallowed — losing a progress update
   * must never cost the ingest it was describing.
   */
  async function setPhase(job: JobRow, phase: IngestPhase, done?: number, total?: number): Promise<void> {
    try {
      await db.query(
        `UPDATE wk_ingest_jobs
            SET phase = $3, progress_done = $4, progress_total = $5
          WHERE id = $1 AND status = 'running' AND lease_owner = $2`,
        [job.id, job.lease_owner, phase, done ?? null, total ?? null],
      )
    } catch (error) {
      logger.warn('ingest phase update failed (progress only, job unaffected)', {
        ingest_id: job.id,
        phase,
        error: String(error),
      })
    }
  }

  /**
   * Mine the source for settled choices, once, and reconcile them with the
   * decisions the space already holds.
   *
   * The model marks its finds (duplicate_of / updates); this function decides.
   * Every marker is validated against the list we actually sent — an unknown
   * slug is a hallucination, and the safe reading of one is "a new decision a
   * human will review", never a silent merge into an unrelated record.
   */
  async function extractDecisionsFor(
    job: JobRow,
    source: { title: string | null; markdown: string },
    sourceKind: IngestInput['source_kind'],
    charter: string,
    language: GeneratedLanguage | undefined,
    runs: AgentRunDraft[],
    usage: { input_tokens: number; output_tokens: number },
    signal: AbortSignal,
  ): Promise<{
    decisions: NonNullable<CreateProposalArgs['decisions']>
    duplicatesSuppressed: number
    supersedeCount: number
  }> {
    const active = await listActiveDecisionsForDedupe(db, job.space_id)
    const byslug = new Map(active.map((row) => [row.slug, row]))

    const input = {
      source,
      ...(sourceKind ? { sourceKind } : {}),
      ...(charter ? { charter } : {}),
      ...(language ? { language } : {}),
      existingDecisions: active.map(({ slug, title, decision }) => ({ slug, title, decision })),
    }
    const { result: extracted } = await generateWithLanguageRepair({
      language,
      generate: (repair) => llm.extractDecisions({ ...input, ...(repair ? { languageRepair: true } : {}) }, { signal }),
      text: (output) =>
        output.decisions
          .flatMap((decision) => [
            decision.title,
            decision.context,
            decision.decision,
            decision.rationale,
            ...decision.alternatives,
          ])
          .join('\n'),
      onAttempt: (attempt) => {
        runs.push({ kind: 'extract_decisions', run: attempt.run })
        usage.input_tokens += attempt.run.usage.input_tokens
        usage.output_tokens += attempt.run.usage.output_tokens
      },
    })

    const decisions: NonNullable<CreateProposalArgs['decisions']> = []
    const staged = new Set<string>()
    const seen = new Set<string>()
    let duplicatesSuppressed = 0
    let supersedeCount = 0
    let capped = 0

    for (const found of extracted.output.decisions) {
      // One model, one list: an exact slug repeat is the model contradicting
      // itself, and the first statement of it is the one we keep.
      if (seen.has(found.slug)) continue
      seen.add(found.slug)

      const duplicateOf = found.duplicate_of ? byslug.get(found.duplicate_of) : undefined
      const updates = found.updates ? byslug.get(found.updates) : undefined
      if (found.duplicate_of && !duplicateOf) {
        logger.info('decision marked as duplicate of an unknown slug — staging it as new', {
          ingest_id: job.id,
          slug: found.slug,
          duplicate_of: found.duplicate_of,
        })
      }
      if (found.updates && !updates) {
        logger.info('decision marked as updating an unknown slug — staging it as new', {
          ingest_id: job.id,
          slug: found.slug,
          updates: found.updates,
        })
      }

      // Already recorded: nothing to stage. Counted, not dropped in silence —
      // "we found this and it is already known" is a reviewer-relevant fact,
      // and it is exactly what the staging upsert used to swallow.
      if (duplicateOf && !updates) {
        duplicatesSuppressed += 1
        continue
      }
      // Same reading, without the marker: a slug that already names an active
      // decision IS that decision.
      if (!updates && byslug.has(found.slug)) {
        duplicatesSuppressed += 1
        continue
      }

      if (decisions.length >= DECISIONS_CAP) {
        capped += 1
        continue
      }

      // A supersede stages a NEW row beside the one it replaces, so it needs a
      // slug of its own (both rows live under unique (space_id, slug)).
      let slug = found.slug
      if (updates) {
        let suffix = 2
        while (byslug.has(slug) || staged.has(slug)) slug = `${found.slug}-${suffix++}`
      }
      if (staged.has(slug)) continue
      staged.add(slug)

      decisions.push({
        slug,
        title: found.title,
        context: found.context,
        decision: found.decision,
        rationale: found.rationale,
        alternatives: found.alternatives,
        ...(updates ? { supersedes_decision_id: updates.id } : {}),
      })
      if (updates) supersedeCount += 1
    }

    if (capped > 0) {
      logger.info('decision cap reached — extra decisions dropped', {
        ingest_id: job.id,
        cap: DECISIONS_CAP,
        dropped: capped,
      })
    }
    return { decisions, duplicatesSuppressed, supersedeCount }
  }

  /**
   * The pipeline body for one claimed job. Returns the terminal write's
   * inputs instead of writing itself so claim/terminal handling stays in one
   * place (processClaimed) and every exit path persists the runs it recorded.
   */
  async function processJob(
    job: JobRow,
    space: SpaceRuntime,
    runs: AgentRunDraft[],
    signal: AbortSignal,
  ): Promise<{ sourceId: string | null; proposalId: string | null }> {
    // The worker re-validates the stored input — the row may predate this
    // binary's schema (see zIngestInput doc).
    const input = zIngestInput.parse(job.input)
    const generatedLanguage = input.language === 'de' || input.language === 'en' ? input.language : space.language

    // 1. Acquire (the only stage that may touch the network besides the LLM).
    await setPhase(job, 'acquire')
    const acquired = await acquirer.acquire(input)

    // 2. Archive + dedup gate. `created:false` means this exact content was
    // archived before — for URL ingests this is the deferred twin of
    // enqueue's synchronous 409 (the body is only known post-fetch). A hit
    // only conflicts while the earlier source is still doing work; otherwise
    // the archived row is REUSED so a transiently failed job can be recovered
    // by re-submitting the same content (§9.1).
    const sourceArgs = {
      kind: acquired.kind,
      url: acquired.url ?? undefined,
      title: acquired.title ?? undefined,
      rawTitle: acquired.rawTitle ?? undefined,
      summary: acquired.summary ?? undefined,
      raw: acquired.raw,
      markdown: acquired.markdown,
      // Optional hint (meeting/article/note); persisted on the source metadata
      // and passed to synthesis, where 'meeting' turns on decision mining.
      sourceKind: input.source_kind,
      // Promotion provenance (§Phase 1): the marker rides on the archived
      // source's metadata so `self-derived-only` can tell knowledge that quotes
      // the wiki's own answers from knowledge that quotes the world. Read off
      // the re-parsed input, which is why it had to become part of zIngestInput.
      derivedFromOutputId: input.derived_from_output_id,
      language: input.language,
    }
    let source
    let created
    if (input.external_source_id) {
      // Sync inputs archive through the stream (head advance + write-once
      // version columns); mostly reached for kind='url', where the body is
      // only known after the fetch (direct bodies short-circuit in enqueue).
      const recorded = await recordStreamVersion(db, job.space_id, {
        externalSourceId: input.external_source_id,
        sourceVersion: input.source_version ?? null,
        observedAt: input.observed_at,
        effectiveAt: input.effective_at,
        source: sourceArgs,
      })
      source = recorded.source
      created = recorded.created
      if (!created && !input.resynthesize && (await reingestBlocked(db, job.space_id, source.id))) {
        // Converge instead of 409: connectors retry blindly. The head already
        // advanced above; hand back whatever proposal the earlier work
        // produced (null when it was rejected/archived-only).
        const { rows } = await db.query<{ id: string }>(
          `SELECT id FROM wk_change_proposals
            WHERE space_id = $1 AND status IN ('pending', 'approved') AND $2::uuid = ANY(source_ids)
            ORDER BY created_at DESC LIMIT 1`,
          [job.space_id, source.id],
        )
        return { sourceId: source.id, proposalId: rows[0]?.id ?? null }
      }
    } else {
      const result = await createSource(db, job.space_id, sourceArgs)
      source = result.source
      created = result.created
      if (!created && !input.resynthesize && (await reingestBlocked(db, job.space_id, source.id))) {
        throw new ConflictError('already_ingested', `content already ingested as source ${source.id}`, {
          details: { source_id: source.id },
        })
      }
    }

    // Retrieval index (wk_source_chunks): derived rows for the
    // source-evidence tier, written right where the source is archived so a
    // fresh source is searchable in approved_then_sources mode immediately.
    // Idempotent (no-op on the created:false reuse path when chunks exist);
    // legacy/import sources are healed by the backfill scan worker.
    await persistSourceChunks(db, job.space_id, source)

    // Evidence mode stops HERE, before any model work: the caller asked for
    // archive-and-index only, so the job completes through the same
    // archived-no-proposal shape the classify-decided branch below uses —
    // that branch stays as the LLM's own version of this outcome, this one
    // is the caller's. No setPhase('classify'): phase stays honest.
    if (input.evidence) {
      logger.info('ingest archived as evidence, no proposal by request', { ingest_id: job.id, source_id: source.id })
      return { sourceId: source.id, proposalId: null }
    }

    // 3. Budget: the ARCHIVE keeps the full document; only what the models
    // read is capped (WIKIKIT_MAX_INGEST_TOKENS, plan §15.4).
    const budget = fitTokenBudget(source.markdown, config.maxIngestTokens)
    if (budget.truncated) {
      logger.warn('ingest source truncated to token budget', {
        ingest_id: job.id,
        source_id: source.id,
        tokens: budget.tokens,
      })
    }

    // 4. Classify: one cheap call over source + compact concept index.
    await setPhase(job, 'classify')
    const index = await getConceptIndex(db, job.space_id)
    const classified = await llm.classify(
      {
        source: { title: source.title, markdown: budget.markdown },
        conceptIndex: index,
        ...(generatedLanguage ? { language: generatedLanguage } : {}),
        ...(space.charter ? { charter: space.charter } : {}),
      },
      { signal },
    )
    runs.push({ kind: 'classify', run: classified.run })

    // The model's slugs are untrusted: 'affected' must actually exist in the
    // index (a hallucinated slug is NOT a new concept — the model was asked to
    // list those separately), and 'new' must not collide with either.
    const indexBySlug = new Map(index.map((entry) => [entry.slug, entry]))
    const affected = [...new Set(classified.output.affected)].filter((slug) => indexBySlug.has(slug))
    const fresh = classified.output.new.filter(
      (entry, position) =>
        !indexBySlug.has(entry.slug) &&
        !affected.includes(entry.slug) &&
        classified.output.new.findIndex((other) => other.slug === entry.slug) === position,
    )

    // A source that touches nothing still gets archived (that is valuable —
    // it is citable evidence), but produces no proposal and no review work.
    if (affected.length === 0 && fresh.length === 0) {
      logger.info('ingest classified as affecting no concepts', { ingest_id: job.id, source_id: source.id })
      return { sourceId: source.id, proposalId: null }
    }

    // 5. Synthesize — one call per concept, merge-not-replace: affected
    // concepts get their CURRENT page so the model integrates rather than
    // overwrites (the prompt enforces the merge; we supply the material).
    // baseRevisionId records the revision the synthesis ACTUALLY reads (null
    // for new concepts) and is passed through to the staged revision: the
    // LLM calls below take seconds-to-minutes, and anchoring stale-base to
    // the staging-time pointer instead would let a concurrent approval slip
    // inside that window and be silently overwritten on approve.
    const conceptInputs: {
      slug: string
      title: string
      currentMarkdown: string | null
      baseRevisionId: string | null
    }[] = [
      ...affected.map((slug) => {
        const entry = indexBySlug.get(slug)!
        return { slug, title: entry.title, currentMarkdown: null as string | null, baseRevisionId: null }
      }),
      ...fresh.map((entry) => ({
        slug: entry.slug,
        title: entry.title,
        currentMarkdown: null as string | null,
        baseRevisionId: null,
      })),
    ]
    for (const target of conceptInputs) {
      if (!indexBySlug.has(target.slug)) continue
      const current = await getConcept(db, job.space_id, { slug: target.slug })
      target.currentMarkdown = current.markdown
      target.baseRevisionId = current.revision_id
    }

    const proposalConcepts: CreateProposalArgs['concepts'] = []
    const allTriples: IncomingClaim[] = []
    const usage = { input_tokens: 0, output_tokens: 0 }

    // Typed registry (0021): rendered into the synthesize vocabulary when the
    // space declares one; quantity predicates then ask for number + unit.
    const registry = await getPredicateRegistry(db, job.space_id)
    const predicateDefs = [...registry.values()]

    // The long pole: one call per concept, minutes each. Publishing the count
    // BEFORE the loop is what makes "3 of 10" mean something at minute twelve.
    await setPhase(job, 'synthesize', 0, conceptInputs.length)
    let synthesizedCount = 0
    for (const target of conceptInputs) {
      const synthesisInput = {
        concept: { slug: target.slug, title: target.title, currentMarkdown: target.currentMarkdown },
        source: { id: source.id, title: source.title, markdown: budget.markdown },
        predicates: space.predicates,
        ...(predicateDefs.length ? { predicateDefs } : {}),
        sourceKind: input.source_kind,
        ...(generatedLanguage ? { language: generatedLanguage } : {}),
        ...(space.charter ? { charter: space.charter } : {}),
      }
      const { result: synthesized } = await generateWithLanguageRepair({
        language: generatedLanguage,
        generate: (repair) =>
          llm.synthesize({ ...synthesisInput, ...(repair ? { languageRepair: true } : {}) }, { signal }),
        text: (output) => [output.summary, output.markdown, ...output.claims.map((claim) => claim.object)].join('\n'),
        onAttempt: (attempt) => {
          runs.push({ kind: 'synthesize', run: attempt.run })
          usage.input_tokens += attempt.run.usage.input_tokens
          usage.output_tokens += attempt.run.usage.output_tokens
        },
      })

      // Claims only WITH a supporting quote that is VERBATIM in the source.
      // The schema requires a non-empty quote, but not that it actually occurs
      // in the source — a paraphrased or hallucinated quote is an unverifiable
      // citation that would poison the KB. This deterministic verbatim-fidelity
      // gate (the load-bearing quality mechanism in comparable systems) drops
      // ungrounded claims; the benchmark measured 0 false positives across 43
      // real grounded claims, so a well-behaved model loses nothing.
      const rawClaims = synthesized.output.claims
      const claims = rawClaims
        .filter((claim) => claim.quote.trim().length > 0 && quoteGroundedIn(claim.quote, budget.markdown))
        .map((claim) => ({
          subject: claim.subject,
          predicate: claim.predicate,
          object: claim.object,
          confidence: claim.confidence,
          // v2 semantics — only present when the SOURCE stated them.
          valid_from: claim.valid_from,
          valid_until: claim.valid_until,
          context: claim.context,
          citations: [{ source_id: source.id, quote: claim.quote }],
        }))
      const dropped = rawClaims.length - claims.length
      if (dropped > 0) {
        // info, not warn: a drop IS the gate succeeding (routine quality
        // signal) — as a warn it drowned the log's real anomalies.
        logger.info('dropped ungrounded claims (quote not verbatim in source)', {
          ingest_id: job.id,
          concept: target.slug,
          dropped,
          kept: claims.length,
        })
      }
      allTriples.push(
        ...claims.map(({ subject, predicate, object, context, valid_from, valid_until }) => ({
          subject,
          predicate,
          object,
          context,
          valid_from,
          valid_until,
        })),
      )

      proposalConcepts.push({
        slug: target.slug,
        title: synthesized.output.title,
        summary: synthesized.output.summary,
        markdown: synthesized.output.markdown,
        // Synthesis-time anchor (see conceptInputs note): explicit null for
        // new concepts so a concept created+approved DURING synthesis still
        // fails stale-base instead of silently clobbering it.
        base_revision_id: target.baseRevisionId,
        claims,
        relations: synthesized.output.relations,
      })
      await setPhase(job, 'synthesize', ++synthesizedCount, conceptInputs.length)
    }

    // 5b. Decisions — ONE call for the whole source, against what the space
    // already decided.
    //
    // WHY not inside the loop above: a decision is a fact of the SOURCE, but
    // synthesis runs per concept. Every concept call read the same document,
    // so every call re-emitted the same choice under its own slug and one
    // decision entered the log five times (PROD: 26 rows, ~9 real decisions).
    // Extraction sees the whole source and the space's active decisions at
    // once, which is the only position from which "same choice, said twice"
    // is even decidable.
    await setPhase(job, 'decisions')
    const {
      decisions: proposalDecisions,
      duplicatesSuppressed,
      supersedeCount,
    } = await extractDecisionsFor(
      job,
      { title: source.title, markdown: budget.markdown },
      input.source_kind,
      space.charter,
      generatedLanguage,
      runs,
      usage,
      signal,
    )

    // 6. Deterministic contradiction detection (frame + context + interval +
    // normalized object) — run here so the proposal SUMMARY warns the
    // reviewer up front. The staging tx re-runs the same matcher for the
    // event payload, and wk_apply_proposal applies the dispute flip at
    // approval; all three share one rule, so they can never disagree.
    await setPhase(job, 'adjudicate')
    const contradictions = await findContradictions(db, job.space_id, { claims: allTriples })

    // 6b. Adjudication (adjudicate.v1): classify WHY the persisted-side pairs
    // differ. Advisory refinement, strictly bounded (cap per job) and
    // fail-open to 'contradictory' — the safe default is the human-review
    // dispute path, never a silently un-flagged collision.
    //   contradictory → keep the dispute pair (counts below, flip 5 disputes)
    //   complementary → stamp adjudication on the incoming claim (flip 5
    //                   exempts it) and drop the pair from the summary
    //   temporal      → stage supersedes_claim_id (flip 5c deprecates the old
    //                   claim deterministically at approval)
    let contradictionCount = 0
    let supersessionCount = 0
    let adjudicated = 0
    const claimByTriple = new Map(
      proposalConcepts.flatMap((entry) =>
        (entry.claims ?? []).map(
          (claim) => [`${claim.subject}\u0000${claim.predicate}\u0000${claim.object}`, claim] as const,
        ),
      ),
    )
    for (const pair of contradictions) {
      if (!pair.existing_claim_id || adjudicated >= ADJUDICATION_CAP) {
        if (pair.existing_claim_id || pair.existing_claim_id === null) contradictionCount += 1
        continue
      }
      adjudicated += 1
      const staged = claimByTriple.get(`${pair.subject}\u0000${pair.predicate}\u0000${pair.proposed_object}`)
      let verdict: 'contradictory' | 'temporal' | 'complementary' = 'contradictory'
      try {
        const result = await llm.adjudicate(
          {
            subject: pair.subject,
            predicate: pair.predicate,
            existing: { object: pair.existing_object, quote: pair.existing_quote },
            incoming: {
              object: pair.proposed_object,
              quote: (() => {
                const citation = staged?.citations?.[0]
                return citation && 'quote' in citation ? citation.quote : null
              })(),
            },
          },
          { signal },
        )
        runs.push({ kind: 'adjudicate', run: result.run })
        verdict = result.output.verdict
      } catch (error) {
        // Advisory stage: any failure (invalid output, refusal, 5xx) falls
        // back to the deterministic dispute path and never fails the job.
        logger.warn('adjudication failed — falling back to contradictory', {
          ingest_id: job.id,
          error: (error as Error).message,
        })
      }
      if (staged && verdict === 'complementary') {
        staged.adjudication = 'complementary'
        continue // resolved: not a contradiction, drop from the summary
      }
      if (staged && verdict === 'temporal') {
        staged.adjudication = 'temporal'
        staged.supersedes_claim_id = pair.existing_claim_id
        supersessionCount += 1
        continue
      }
      if (staged && verdict === 'contradictory') staged.adjudication = 'contradictory'
      contradictionCount += 1
    }

    // Every staged claim contributed exactly one triple above.
    const claimsCount = allTriples.length
    const summaryParts = [
      `Synthesized ${proposalConcepts.length} concept${proposalConcepts.length === 1 ? '' : 's'}`,
      `${claimsCount} claim${claimsCount === 1 ? '' : 's'}`,
    ]
    if (contradictionCount > 0) {
      summaryParts.push(`${contradictionCount} contradiction${contradictionCount === 1 ? '' : 's'} detected`)
    }
    if (supersessionCount > 0) {
      summaryParts.push(`${supersessionCount} supersession${supersessionCount === 1 ? '' : 's'}`)
    }
    if (proposalDecisions.length > 0) {
      summaryParts.push(`${proposalDecisions.length} decision${proposalDecisions.length === 1 ? '' : 's'}`)
    }
    // Suppressed duplicates stage nothing, so the summary is the only place a
    // reviewer learns the source repeated decisions the space already holds.
    if (duplicatesSuppressed > 0) {
      summaryParts.push(
        `${duplicatesSuppressed} decision${duplicatesSuppressed === 1 ? '' : 's'} already recorded (not re-staged)`,
      )
    }
    if (supersedeCount > 0) {
      summaryParts.push(`${supersedeCount} decision update${supersedeCount === 1 ? '' : 's'}`)
    }

    // 7. Propose — the ONE staging transaction (createProposal owns it).
    // input_hash = f(source hashes, prompt version): re-ingesting the same
    // content under the same prompt converges on the same pending proposal.
    await setPhase(job, 'propose')
    const inputHash = computeInputHash([source.content_hash], PROMPT_VERSIONS.synthesize)
    const synthesizeModel = runs.find((draft) => draft.kind === 'synthesize')?.run.model ?? 'unknown'
    const { proposal_id } = await createProposal(db, job.space_id, {
      title: `Ingest: ${source.title ?? `${acquired.kind} source`}`,
      summary: `${summaryParts.join(', ')} from source ${source.id}.`,
      input_hash: inputHash,
      source_ids: [source.id],
      // §1.14 AgentMeta — stamped onto every staged row by createProposal.
      agent_meta: {
        model: synthesizeModel,
        prompt_version: PROMPT_VERSIONS.synthesize,
        input_hash: inputHash,
        usage,
        source_ids: [source.id],
      },
      concepts: proposalConcepts,
      decisions: proposalDecisions,
    })

    // 8. Retire what this version replaced. A new stream version supersedes the
    // previous head, which makes any proposal still pending on that predecessor
    // a competitor to its own replacement — and for a coding session it is
    // strictly obsolete, because the longer transcript contained everything the
    // shorter one did. Done HERE, after the replacement exists, so the queue is
    // never briefly empty; done in SQL (0039) because proposal state changes
    // belong in SQL functions; a no-op when nothing is pending.
    if (source.supersedes_source_id) {
      const [outcome] = await db.call<{ retired: number }>('wk_retire_superseded_proposals', [
        job.space_id,
        source.supersedes_source_id,
        `superseded by a newer capture of the same source stream (source ${source.id})`,
      ])
      if (outcome && outcome.retired > 0) {
        logger.info('retired proposals superseded by a newer stream version', {
          ingest_id: job.id,
          source_id: source.id,
          superseded_source_id: source.supersedes_source_id,
          retired: outcome.retired,
        })
      }
    }

    return { sourceId: source.id, proposalId: proposal_id }
  }

  /**
   * Extend a claimed job's lease while its worker is alive. The timer is
   * serialized (never overlapping updates), and stop waits for a running
   * heartbeat before the terminal state transition clears lease ownership.
   */
  function startHeartbeat(job: JobRow): () => Promise<void> {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = Promise.resolve()
    const tick = () => {
      if (stopped) return
      inFlight = db
        .query<{ id: string }>(
          `UPDATE wk_ingest_jobs
              SET heartbeat_at = now(),
                  lease_expires_at = now() + ($3 || ' milliseconds')::interval
            WHERE id = $1
              AND status = 'running'
              AND lease_owner = $2
          RETURNING id`,
          [job.id, job.lease_owner, String(leaseMs)],
        )
        .then(({ rows }) => {
          if (!rows.length) {
            stopped = true
            logger.warn('ingest heartbeat lost lease ownership', { ingest_id: job.id })
          }
        })
        .catch((error) => {
          logger.error('ingest heartbeat failed; lease remains bounded', { ingest_id: job.id, error: String(error) })
        })
        .finally(() => {
          if (!stopped) timer = setTimeout(tick, heartbeatMs)
        })
    }
    timer = setTimeout(tick, heartbeatMs)
    return async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      await inFlight
    }
  }

  /** Wraps processJob with lease heartbeat, runtime ceiling and terminal state handling. */
  async function processClaimed(job: JobRow): Promise<void> {
    const startedAt = Date.now()
    const stopHeartbeat = startHeartbeat(job)
    const runs: AgentRunDraft[] = []
    // The runtime ceiling. The heartbeat proves a worker is ALIVE; a worker
    // blocked forever inside an LLM call is alive and renews the lease
    // indefinitely, which is how a job reached 23 minutes with nothing to
    // distinguish it from a wedged one. Aborting the request is what actually
    // stops the work — flipping the row alone would leave the call burning.
    const controller = new AbortController()
    const runtimeTimer = setTimeout(() => controller.abort(), maxRuntimeMs)
    let space: SpaceRuntime | null = null
    let sourceId: string | null = null
    try {
      space = await loadSpace(job.space_id)
      const result = await processJob(job, space, runs, controller.signal)
      sourceId = result.sourceId
      await finishJob(job, result, runs)
      options.metrics?.ingestJob('done', Date.now() - startedAt)
      logger.info('ingest job done', { ingest_id: job.id, proposal_id: result.proposalId, source_id: result.sourceId })
    } catch (error) {
      const timedOut = controller.signal.aborted
      const code = timedOut ? 'timeout' : ((error as { code?: string }).code ?? 'ingest_failed')
      const message = timedOut
        ? `ingest exceeded WIKIKIT_INGEST_MAX_RUNTIME_MS (${maxRuntimeMs}ms)`
        : error instanceof Error
          ? error.message
          : String(error)
      const details = (error as { details?: { source_id?: string } }).details
      const failedSourceId = details?.source_id ?? sourceId
      if (!timedOut && isQuotaExhausted(message)) {
        // Quota exhaustion parks the job instead of failing it — the work is
        // intact and resumes automatically. ONE error line for the incident;
        // the paused claims that follow are silent by design.
        const resumeAt = parseQuotaResumeAt(message) ?? new Date(Date.now() + QUOTA_FALLBACK_RESUME_MS).toISOString()
        quotaPausedUntil = Math.max(quotaPausedUntil, Date.parse(resumeAt))
        logger.error('ingest paused: provider quota exhausted; job parked until resume_at', {
          ingest_id: job.id,
          resume_at: resumeAt,
          error: message,
        })
        try {
          await quotaBlockJob(job, resumeAt, { code: 'quota_blocked', message }, runs)
        } catch (writeError) {
          logger.error('ingest quota park could not be persisted', { ingest_id: job.id, error: String(writeError) })
        }
        return
      }
      logger.error('ingest job failed', { ingest_id: job.id, code, error: message })
      try {
        await failJob(job, space?.slug ?? '', { code, message }, failedSourceId ?? null, runs)
        options.metrics?.ingestJob(timedOut ? 'timeout' : 'failed', Date.now() - startedAt)
      } catch (writeError) {
        // The failure write itself failed (DB down?): leave the job 'running'
        // for the reaper — flipping state is better done late than lost.
        logger.error('ingest failure could not be persisted', { ingest_id: job.id, error: String(writeError) })
      }
    } finally {
      clearTimeout(runtimeTimer)
      await stopHeartbeat()
    }
  }

  /**
   * Flip orphaned 'running' jobs (crashed worker) to failed:'worker_lost'.
   * Runs opportunistically before each claim — cheap (running rows are few)
   * and needs no extra timer. One tx: the flip and its wikikit.ingest.failed
   * outbox event commit together ('every state change writes an outbox
   * event') — failJob emits on every other failure path, and webhook
   * consumers must learn about crash-orphaned jobs the same way.
   */
  async function reapStale(): Promise<void> {
    await reapWith(
      { code: 'worker_lost', message: 'worker lease expired before this job finished' },
      `coalesce(j.lease_expires_at, j.started_at + ($2 || ' milliseconds')::interval) < now()`,
      leaseMs,
      'reaped orphaned ingest job as worker_lost',
    )
    // Backstop for the in-worker ceiling: a wedged worker (or one from a
    // binary that predates the ceiling) still renews its lease, so liveness
    // alone never catches it. The grace beyond the ceiling lets the worker's
    // own abort path win the normal race and write the richer error; the
    // terminal writes are guarded on (status='running', lease_owner), so a
    // straggler that returns afterwards no-ops instead of resurrecting the row.
    await reapWith(
      { code: 'timeout', message: 'ingest exceeded its runtime ceiling and was reaped' },
      `j.started_at < now() - (($2 || ' milliseconds')::interval)`,
      maxRuntimeMs + 2 * heartbeatMs,
      'reaped over-running ingest job as timeout',
    )
  }

  /** One reap pass: flip matching running jobs to failed + emit their events. */
  async function reapWith(
    error: { code: string; message: string },
    predicate: string,
    intervalMs: number,
    logMessage: string,
  ): Promise<void> {
    await db.tx(async (tx) => {
      const reaped = await tx.query<{ id: string; space_id: string; space_slug: string; runtime_ms: number }>(
        `UPDATE wk_ingest_jobs j
            SET status = 'failed',
                error = $1,
                finished_at = now(),
                lease_owner = null,
                lease_expires_at = null
           FROM wk_spaces s
          WHERE s.id = j.space_id
            AND j.status = 'running'
            AND ${predicate}
        RETURNING j.id, j.space_id, s.slug AS space_slug,
                  (extract(epoch from (now() - j.started_at)) * 1000)::bigint AS runtime_ms`,
        [JSON.stringify(error), String(intervalMs)],
      )
      for (const job of reaped.rows) {
        logger.warn(logMessage, { ingest_id: job.id })
        // Reaped jobs were invisible in telemetry: a crash-orphaned or
        // over-running job IS a terminal outcome, and one that never reaches
        // the counter cannot be alerted on.
        options.metrics?.ingestJob(error.code === 'timeout' ? 'timeout' : 'worker_lost', Number(job.runtime_ms) || 0)
        await tx.emitEvent(job.space_id, 'wikikit.ingest.failed', {
          ingest_id: job.id,
          space: job.space_slug,
          error,
        })
      }
    })
  }

  /**
   * Flip parked quota_blocked jobs whose resume window passed back to queued.
   * Runs opportunistically before each claim, like reapStale: cheap (the
   * partial index covers it) and multi-instance safe — whichever worker
   * polls first requeues, the claim below arbitrates as usual.
   */
  async function requeueQuotaBlocked(): Promise<void> {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE wk_ingest_jobs
          SET status = 'queued', resume_at = null, error = null
        WHERE status = 'quota_blocked' AND resume_at <= now()
      RETURNING id`,
    )
    if (rows.length) {
      logger.info('requeued quota-blocked ingest jobs (provider window reopened)', { count: rows.length })
    }
  }

  /**
   * Backpressure instead of a silent queue (WIKIKIT_INGEST_MAX_QUEUED_PER_SPACE).
   *
   * WHAT IS COUNTED, and why it is more than `status = 'queued'`: parked jobs
   * (quota_blocked) are counted too. They are work that has been accepted and not
   * done — the provider window is holding them — so leaving them out would let a
   * space with an exhausted quota accumulate unbounded work behind a cap that
   * reads zero, which is the exact situation the cap exists for. `running` is NOT
   * counted: those are draining right now, at most ingestConcurrency of them, and
   * counting them would make the effective ceiling wobble with the worker's pace.
   *
   * WHERE it sits in enqueue: AFTER the content-hash pre-check, before the insert.
   * A re-submission of content the archive already holds must keep answering
   * `already_ingested` with its source_id — that is the precise answer, and a
   * queue-full refusal would replace it with a vaguer one for a call that was
   * never going to queue anything.
   *
   * An ABSENT config field falls back to the shipped ceiling rather than to "no
   * ceiling" (DEFAULT_INGEST_MAX_QUEUED_PER_SPACE, the same constant the loader
   * spends): a guard that disappears when a field is missing is not a guard.
   */
  async function assertQueueHasRoom(enqueueDb: Db, spaceId: string): Promise<void> {
    const limit = config.ingestMaxQueuedPerSpace ?? DEFAULT_INGEST_MAX_QUEUED_PER_SPACE
    if (!Number.isFinite(limit) || limit <= 0) return
    const { rows } = await enqueueDb.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting
         FROM wk_ingest_jobs
        WHERE space_id = $1 AND status IN ('queued', 'quota_blocked')`,
      [spaceId],
    )
    const waiting = Number(rows[0]?.waiting ?? 0)
    if (waiting >= limit) throw new IngestQueueFullError(waiting, limit)
  }

  async function runOnce(): Promise<boolean> {
    // Quota pause: claiming into a known-closed provider window would only
    // turn queued jobs into quota_blocked ones (plus one wasted LLM call
    // each) — idle instead. The durable state lives in the parked rows.
    if (Date.now() < quotaPausedUntil) return false
    await requeueQuotaBlocked()
    await reapStale()
    const leaseOwner = randomUUID()
    // Claim oldest-first with SKIP LOCKED: concurrent workers each grab a
    // DIFFERENT queued row or none — never the same one, never blocking.
    const { rows } = await db.query<JobRow>(
      `UPDATE wk_ingest_jobs
          SET status = 'running',
              started_at = now(),
              heartbeat_at = now(),
              lease_owner = $1,
              lease_expires_at = now() + ($2 || ' milliseconds')::interval,
              phase = null,
              progress_done = null,
              progress_total = null
        WHERE id = (
          SELECT id FROM wk_ingest_jobs
           WHERE status = 'queued'
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, space_id, input, lease_owner`,
      [leaseOwner, String(leaseMs)],
    )
    const job = rows[0]
    if (!job) return false
    await processClaimed(job)
    return true
  }

  return {
    async enqueue(
      enqueueDb: Db,
      spaceId: string,
      args: IngestRequest,
    ): Promise<{ ingest_id: string } | IngestUnchanged | IngestCaptured> {
      const input = zIngestInput.parse(args)

      // Provenance loop-guard, and the ONE guard that outranks the capture
      // branch below: content carrying the top-level `wikikit:` frontmatter
      // key IS this wiki's own export mirror, and ingesting it would loop
      // approved knowledge back through review as if it were new evidence. It
      // must sit BEFORE the capture fast-path — a parked mirror note would
      // sail past every guard here and be synthesized later via
      // triage resolution re-checks LLM/queue-room but never re-reads the
      // content. URL ingests are covered by the acquirer's backstop (the body
      // is unknown at enqueue time). importBundle is deliberately NOT guarded:
      // an md/okf roundtrip is legitimate re-import and goes through the
      // review gate.
      const directBody = input.markdown ?? input.text
      if (directBody !== undefined && hasWikiKitProvenance(directBody)) {
        throw new UnprocessableError(
          'this content is a WikiKit export mirror (top-level `wikikit:` frontmatter) — mirrored knowledge is never ingested back',
        )
      }

      // Capture branches BEFORE every guard on purpose: parking a note asks
      // for no LLM and takes no queue slot, so neither the 503 nor the 429 may
      // refuse it — those are paid when triage resolves to processing. The dedup
      // pre-check is skipped too: identical text parked twice is two captured
      // rows (accepted — dedup is content-hash-on-archive, and nothing is
      // archived yet).
      if (input.capture) {
        const [job] = await enqueueDb.insert<{ id: string }>('wk_ingest_jobs', {
          space_id: spaceId,
          status: 'captured',
          input: JSON.stringify(input),
        })
        return { status: 'captured', ingest_id: job!.id }
      }

      // Fail fast instead of queuing a job that can only fail: the 503 must
      // reach the caller synchronously (zero-config principle — LLM-free
      // features work without a key, ingest tells you why it cannot).
      // Evidence asks for no model work either, so it passes keyless like
      // capture — but unlike capture it stays behind the dedup pre-check and
      // the queue ceiling below (it is real worker work).
      if (!input.evidence && !llm.configured) throw new LlmNotConfiguredError(llm.apiKeyEnv)

      const body = input.markdown ?? input.text
      if (body !== undefined) {
        const contentHash = sha256Hex(body)
        const [existing] = await enqueueDb.select<{ id: string }>('wk_sources', {
          space_id: `eq.${spaceId}`,
          content_hash: `eq.${contentHash}`,
          limit: 1,
        })
        if (input.external_source_id) {
          // Sync fast-path (§ sync matrix): connectors retry blindly, so a
          // known-content push is a head-pointer advance answered 200, never
          // a 409 — UNLESS the earlier work failed and nothing references
          // the source (then the re-push is the documented recovery path and
          // proceeds to a fresh job). The version-conflict check (same
          // marker, different bytes) lives inside recordStreamVersion.
          if (existing && !input.resynthesize && (await reingestBlocked(enqueueDb, spaceId, existing.id))) {
            const { stream, source } = await recordStreamVersion(enqueueDb, spaceId, {
              externalSourceId: input.external_source_id,
              sourceVersion: input.source_version ?? null,
              observedAt: input.observed_at,
              effectiveAt: input.effective_at,
              source: {
                kind: input.markdown !== undefined ? 'markdown' : 'text',
                title: input.title,
                raw: body,
                markdown: body,
                sourceKind: input.source_kind,
                derivedFromOutputId: input.derived_from_output_id,
                language: input.language,
              },
            })
            return { status: 'unchanged', source_id: source.id, stream_id: stream.id }
          }
        } else if (existing && !input.resynthesize && (await reingestBlocked(enqueueDb, spaceId, existing.id))) {
          // Synchronous dedup pre-check for direct bodies (§4.1): the content
          // is in hand, so the 409 must not cost the client an enqueue-poll
          // round trip. URL ingests defer to the worker — the body is unknown
          // here. A hash hit only 409s while the archived source is still
          // doing work (see module header); after a failed job the re-submit
          // proceeds and the worker reuses the archived row.
          throw new ConflictError('already_ingested', `content already ingested as source ${existing.id}`, {
            details: { source_id: existing.id },
            nextBestActions: [`GET /v1/spaces/{space}/sources/${existing.id} to see the existing source`],
          })
        }
      }

      if (input.resynthesize_source_id) {
        const active = await enqueueDb.query<{ id: string }>(
          `SELECT id FROM wk_ingest_jobs
            WHERE space_id = $1
              AND input->>'resynthesize_source_id' = $2
              AND status IN ('queued', 'running', 'quota_blocked')
            ORDER BY created_at DESC
            LIMIT 1`,
          [spaceId, input.resynthesize_source_id],
        )
        if (active.rows[0]) return { ingest_id: active.rows[0].id }
      }

      await assertQueueHasRoom(enqueueDb, spaceId)

      try {
        const [job] = await enqueueDb.insert<{ id: string }>('wk_ingest_jobs', {
          space_id: spaceId,
          status: 'queued',
          input: JSON.stringify(input),
        })
        return { ingest_id: job!.id }
      } catch (error) {
        if ((error as { code?: string }).code !== '23505' || !input.resynthesize_source_id) throw error
        const active = await enqueueDb.query<{ id: string }>(
          `SELECT id FROM wk_ingest_jobs
            WHERE space_id = $1
              AND input->>'resynthesize_source_id' = $2
              AND status IN ('queued', 'running', 'quota_blocked')
            ORDER BY created_at DESC
            LIMIT 1`,
          [spaceId, input.resynthesize_source_id],
        )
        if (!active.rows[0]) throw error
        return { ingest_id: active.rows[0].id }
      }
    },

    async resolveCapture(actionDb: Db, id: string, resolution: CaptureResolution): Promise<void> {
      const [job] = await actionDb.select<{
        id: string
        space_id: string
        status: string
        input: Record<string, unknown> | string
      }>('wk_ingest_jobs', {
        id: `eq.${id}`,
        limit: 1,
      })
      if (!job) throw new NotFoundError(`ingest job ${id} not found`)
      if (job.status !== 'captured') {
        throw new ConflictError('ingest_not_captured', `ingest job ${id} is ${job.status}, not captured`, {
          nextBestActions: [`GET /v1/ingests/${id} to see where the job is`],
        })
      }
      const input = typeof job.input === 'string' ? JSON.parse(job.input) : job.input
      const { raw_title: storedRawTitle, ...inputWithoutRawTitle } = input
      const rawTitle =
        typeof storedRawTitle === 'string' ? storedRawTitle : typeof input.title === 'string' ? input.title : undefined
      const updatedInput = {
        ...inputWithoutRawTitle,
        ...(rawTitle ? { raw_title: rawTitle } : {}),
        title: resolution.title,
        summary: resolution.summary,
        triage_resolution: resolution.action,
        ...(resolution.action === 'leave' ? { triage_question: resolution.question } : {}),
      }

      if (resolution.action === 'leave') {
        await actionDb.update(
          'wk_ingest_jobs',
          { id: `eq.${id}`, status: 'eq.captured' },
          { input: JSON.stringify(updatedInput) },
          { returning: false },
        )
        return
      }
      if (resolution.action === 'discard') {
        await actionDb.update(
          'wk_ingest_jobs',
          { id: `eq.${id}`, status: 'eq.captured' },
          { status: 'discarded', input: JSON.stringify(updatedInput), finished_at: new Date().toISOString() },
          { returning: false },
        )
        return
      }
      if (resolution.action === 'use_existing') {
        await actionDb.update(
          'wk_ingest_jobs',
          { id: `eq.${id}`, status: 'eq.captured' },
          {
            space_id: resolution.targetSpaceId,
            status: 'done',
            input: JSON.stringify(updatedInput),
            source_id: resolution.sourceId,
            finished_at: new Date().toISOString(),
          },
          { returning: false },
        )
        return
      }

      if (!llm.configured) throw new LlmNotConfiguredError(llm.apiKeyEnv)
      await assertQueueHasRoom(actionDb, resolution.targetSpaceId)
      await actionDb.update(
        'wk_ingest_jobs',
        { id: `eq.${id}`, status: 'eq.captured' },
        {
          space_id: resolution.targetSpaceId,
          status: 'queued',
          input: JSON.stringify(updatedInput),
        },
        { returning: false },
      )
    },

    start(): void {
      if (running) return
      running = true
      // N independent loops instead of a scheduler: SKIP LOCKED already
      // arbitrates between them, so the simplest possible concurrency wins.
      for (let i = 0; i < config.ingestConcurrency; i++) {
        loops.push(
          (async () => {
            while (running) {
              let processed = false
              try {
                processed = await runOnce()
              } catch (error) {
                logger.error('ingest worker iteration failed', { error: String(error) })
              }
              // Drain the queue back-to-back; only idle-sleep when empty.
              if (!processed && running) await sleep(pollMs)
            }
          })(),
        )
      }
    },

    async stop(): Promise<void> {
      running = false
      for (const wake of [...wakers]) wake()
      wakers.clear()
      await Promise.all(loops.splice(0))
    },

    runOnce,
  }
}
