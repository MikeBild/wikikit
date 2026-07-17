// Session capture — a coding-agent transcript in, a ChangeProposal out (or,
// usually, nothing at all).
//
// This is the "save" half of the coding-agent loop: a SessionEnd/Stop hook
// posts the session transcript, and whatever durable rules the human taught in
// it come back as a pending proposal for review.
//
// THE DESIGN DECISION — why the transcript is distilled and then DISCARDED,
// never archived as a source:
//   - Signal: a transcript is 95% noise (tool calls, file edits, test output).
//     Ingesting it whole would synthesize concept pages about one afternoon's
//     debugging. Distillation runs FIRST and is a filter: no learnings → no
//     source, no proposal, no synthesis cost. A routine session costs exactly
//     one cheap LLM call and writes nothing.
//   - Privacy: transcripts carry pasted secrets, customer data and half-formed
//     thoughts. WikiKit archives sources verbatim and forever — a transcript
//     is precisely the kind of thing that must not enter that record. Only the
//     distilled rules (which a human then reviews) are persisted.
//
// Everything after distillation is deliberately NOT new machinery: the
// rendered learnings go through the normal ingest pipeline, so they inherit
// content-hash dedup, the verbatim-quote grounding guard, contradiction
// detection against existing knowledge, and the one-proposal-per-run review
// gate. Re-teaching the same rule produces the same markdown → the same hash →
// `already_captured` instead of a duplicate proposal.
import { z } from 'zod'
import type { Db } from '../db/postgres.ts'
import { ConflictError, LlmNotConfiguredError } from '../domain/errors.ts'
import type { IngestPipeline } from '../ingest/pipeline.ts'
import type { LlmProvider } from '../llm/provider.ts'
import type { DistillOutput } from '../llm/schemas.ts'

/**
 * Client-side transcripts are capped by the hook, but never trust the wire:
 * a 10 MB transcript would blow the distill model's context. Corrections skew
 * LATE in a session ("no, always use X"), so when over the cap we keep the
 * TAIL — the head is the part safe to lose.
 */
const TRANSCRIPT_MAX_CHARS = 200_000

export const zCaptureSessionArgs = z.object({
  transcript: z.string().min(1).describe('The coding-agent session transcript; over-long input keeps its tail'),
  /** Titles the staged source. Absent → a stable default (keeps dedup working). */
  title: z.string().max(500).optional(),
})
export type CaptureSessionArgs = z.infer<typeof zCaptureSessionArgs>

export interface CaptureResult {
  /**
   * - `no_learnings` — the session taught nothing durable (the common case).
   * - `queued` — learnings found; an ingest is running, poll `ingest_id`.
   * - `already_captured` — identical learnings are already a source.
   */
  status: 'no_learnings' | 'queued' | 'already_captured'
  ingest_id: string | null
  /** How many durable rules were distilled (0 for no_learnings). */
  learnings: number
  /** wk_agent_runs id of the distill call — the audit anchor. Always present. */
  agent_run_id: string
}

/** Trim to the cap, keeping the tail (see TRANSCRIPT_MAX_CHARS). */
export function capTranscript(transcript: string): string {
  return transcript.length > TRANSCRIPT_MAX_CHARS
    ? transcript.slice(transcript.length - TRANSCRIPT_MAX_CHARS)
    : transcript
}

/**
 * Render distilled learnings as the markdown source the pipeline ingests.
 *
 * The quotes ride along verbatim on purpose: the grounding guard checks each
 * synthesized claim's quote against THIS text, so a rule whose evidence the
 * distiller invented cannot produce a grounded claim. Output is deterministic
 * (no timestamps, no ids) — that is what makes re-teaching the same rule
 * collapse onto the same content hash instead of piling up proposals.
 */
export function renderLearnings(learnings: DistillOutput['learnings']): string {
  const body = learnings
    .map((learning) => `## ${learning.title}\n\n${learning.rule}\n\n> ${learning.quote.replace(/\n/g, '\n> ')}`)
    .join('\n\n')
  return `# Session learnings\n\n${body}\n`
}

export interface CaptureDeps {
  llm: LlmProvider
  ingest: IngestPipeline
}

/**
 * Distill one session transcript and, only if it taught something, stage it.
 * Throws LlmNotConfiguredError (503) without an API key — capture is the one
 * part of the agent loop that genuinely needs the model.
 */
export async function captureSession(
  db: Db,
  spaceId: string,
  deps: CaptureDeps,
  args: CaptureSessionArgs,
): Promise<CaptureResult> {
  const input = zCaptureSessionArgs.parse(args)
  if (!deps.llm.configured) throw new LlmNotConfiguredError(deps.llm.apiKeyEnv)

  const distilled = await deps.llm.distill({ transcript: capTranscript(input.transcript) })

  // Recorded even when nothing was learned: the ledger answers "what did this
  // space spend model calls on", and a filter that returns nothing still ran.
  const [run] = await db.insert<{ id: string }>('wk_agent_runs', {
    space_id: spaceId,
    kind: 'distill',
    model: distilled.run.model,
    prompt_version: distilled.run.prompt_version,
    input_hash: distilled.run.input_hash,
    usage: JSON.stringify(distilled.run.usage),
    duration_ms: distilled.run.duration_ms,
  })
  const agent_run_id = run!.id
  const learnings = distilled.output.learnings.length

  // The whole point of the filter: a routine session ends here, having cost
  // one cheap call and written nothing but its audit row.
  if (learnings === 0) return { status: 'no_learnings', ingest_id: null, learnings: 0, agent_run_id }

  try {
    const { ingest_id } = await deps.ingest.enqueue(db, spaceId, {
      markdown: renderLearnings(distilled.output.learnings),
      title: input.title ?? 'Session learnings',
      // Not a meeting: decision mining would turn "always use X" into decision
      // records with no context or alternatives. These are conventions.
      source_kind: 'note',
    })
    return { status: 'queued', ingest_id, learnings, agent_run_id }
  } catch (error) {
    // Same rules taught again → same markdown → same content hash. That is a
    // success for a hook that fires after every session, not an error.
    if (error instanceof ConflictError && error.code === 'already_ingested') {
      return { status: 'already_captured', ingest_id: null, learnings, agent_run_id }
    }
    throw error
  }
}
