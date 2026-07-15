// LLM provider contract — the exactly-three-method interface every consumer
// (ingest pipeline, query/answer) codes against (CONTRACTS.md §3.1).
//
// WHY an interface + factory instead of calling the Anthropic SDK directly:
// the ingest pipeline must be testable deterministically offline. The real
// provider (anthropic.ts) and the FakeProvider (fake.ts) implement the same
// three methods, so swapping them is a DI decision in the composition root,
// never a code path change. Every call returns an LlmRunMeta the CALLER
// persists to wk_agent_runs — the provider computes the audit facts (model,
// prompt_version, input_hash, usage, duration) but never touches the DB,
// keeping it transport- and storage-agnostic.
import { createHash } from 'node:crypto'
import type {
  AnswerInput,
  AnswerOutput,
  ClassifyInput,
  ClassifyOutput,
  SynthesizeInput,
  SynthesizeOutput,
} from './schemas.ts'

export interface LlmUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
}

export interface LlmRunMeta {
  model: string
  prompt_version: string
  /** sha256 hex of the canonical serialized input (see computeInputHash). */
  input_hash: string
  usage: LlmUsage
  duration_ms: number
}

export interface LlmResult<T> {
  output: T
  run: LlmRunMeta
}

export interface LlmProvider {
  /** False when no ANTHROPIC_API_KEY — callers answer 503 llm_not_configured. FakeProvider: true. */
  readonly configured: boolean
  /** Which existing concepts a source affects + which new concepts it warrants. Model: config.modelClassify. */
  classify(input: ClassifyInput): Promise<LlmResult<ClassifyOutput>>
  /** One call per affected concept: new revision + claims + relations. Model: config.modelSynthesis. */
  synthesize(input: SynthesizeInput): Promise<LlmResult<SynthesizeOutput>>
  /** Grounded Q&A over retrieved evidence with inline citations. Model: config.modelAnswer. */
  answer(input: AnswerInput): Promise<LlmResult<AnswerOutput>>
}

// ---------------------------------------------------------------------------
// Typed errors (map to the §8.2 envelope via their `code` field)
// ---------------------------------------------------------------------------
//
// WHY these live here and not in src/domain/errors.ts: the provider must be
// importable before the domain module exists (build-order independence), and
// the transports map errors by `code`, not by class identity — so any layer
// that catches these can produce the correct envelope without importing us.

/** 503 llm_not_configured — thrown by every method when no API key is set. */
export class LlmNotConfiguredError extends Error {
  readonly code = 'llm_not_configured' as const
  readonly status = 503
  readonly next_best_actions = [
    'set ANTHROPIC_API_KEY',
    'LLM-free endpoints (search, read, lint, export) work without it',
  ]
  constructor(message = 'LLM features are not configured: ANTHROPIC_API_KEY is not set') {
    super(message)
    this.name = 'LlmNotConfiguredError'
  }
}

/** Model produced output that fails the zod schema, truncates, or is not JSON. No silent partials. */
export class LlmOutputInvalidError extends Error {
  readonly code = 'llm_output_invalid' as const
  readonly status = 502
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'LlmOutputInvalidError'
  }
}

/**
 * stop_reason 'refusal' — safety classifiers declined the request (HTTP 200,
 * empty or partial content). Terminal: retrying the identical input will
 * refuse again, so callers surface it instead of looping.
 */
export class LlmRefusedError extends Error {
  readonly code = 'llm_refused' as const
  readonly status = 502
  readonly next_best_actions = ['rephrase or remove the offending source content', 'do not retry the identical request']
  constructor(message = 'the model refused this request (stop_reason: refusal)') {
    super(message)
    this.name = 'LlmRefusedError'
  }
}

// ---------------------------------------------------------------------------
// Canonical input hashing
// ---------------------------------------------------------------------------

/**
 * sha256 hex over the fully rendered prompt input. Canonical form is
 * `<prompt_version>\n<system>\n<rendered user prompt>` — everything that
 * reaches the model, in render order.
 *
 * WHY hash the RENDERED prompt rather than the raw input object: the hash is
 * the dedup + audit anchor (wk_agent_runs.input_hash, proposal input_hash
 * derivation). Two inputs that render to the same prompt ARE the same call;
 * conversely a prompt-template change (new version constant) changes every
 * hash, which is exactly the "prompt regression = product regression"
 * property we want. Fake and real providers share this function so tests can
 * assert hashes across implementations.
 */
export function computeInputHash(promptVersion: string, system: string, rendered: string): string {
  return createHash('sha256').update(`${promptVersion}\n${system}\n${rendered}`, 'utf8').digest('hex')
}
