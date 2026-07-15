// Anthropic-backed LlmProvider (@anthropic-ai/sdk) — CONTRACTS.md §3.1.
//
// Design decisions (WHY):
// - Structured outputs (`output_config.format`, json_schema derived from the
//   same zod objects that re-validate the response): the API enforces shape,
//   zod enforces semantics — both must pass or we throw LlmOutputInvalidError.
// - Streaming for synthesis: revisions can be long; a non-streaming request
//   with a large max_tokens risks SDK HTTP timeouts. classify/answer outputs
//   are small and stay non-streaming. Either way callers see one Promise.
// - Prompt caching: the static system prompt carries cache_control — it is
//   byte-identical per prompt version, so every call after the first reads
//   the cached prefix. All volatile material lives in the rendered user turn.
// - stop_reason is checked BEFORE content is read: 'refusal' (safety
//   classifiers, HTTP 200 + empty/partial content) → LlmRefusedError;
//   'max_tokens' → LlmOutputInvalidError (a truncated JSON document is not a
//   partial success).
// - No sampling parameters: claude-sonnet-5 rejects non-default
//   temperature/top_p/top_k with a 400 — prompts steer behavior instead.
// - ANTHROPIC_BASE_URL: config surfaces it and we pass it explicitly so the
//   e2e Anthropic stub works even when the SDK's own env lookup is bypassed.
// - The client is constructed lazily: `configured:false` providers are valid
//   objects (LLM-free deployments), they just throw LlmNotConfiguredError on
//   use — the 503 path.
import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import {
  computeInputHash,
  LlmNotConfiguredError,
  LlmOutputInvalidError,
  LlmRefusedError,
  type LlmProvider,
  type LlmResult,
  type LlmUsage,
} from './provider.ts'
import { PROMPT_VERSIONS } from './prompts/index.ts'
import * as classifyV1 from './prompts/classify.v1.ts'
import * as synthesizeV1 from './prompts/synthesize.v1.ts'
import * as answerV1 from './prompts/answer.v1.ts'
import {
  toOutputJsonSchema,
  zAnswerOutput,
  zClassifyOutput,
  zSynthesizeOutput,
  type AnswerInput,
  type AnswerOutput,
  type ClassifyInput,
  type ClassifyOutput,
  type SynthesizeInput,
  type SynthesizeOutput,
} from './schemas.ts'
import type { z } from 'zod'

// Output ceilings per call kind. Classify/adjudicate emit tiny JSON;
// synthesis carries a full page body; answers are a few paragraphs.
const MAX_TOKENS = { classify: 2048, synthesize: 32_000, answer: 8192 } as const

interface PromptModule<I> {
  system: string
  render(input: I): string
}

export function createAnthropicProvider(config: Config, deps: { logger?: Logger } = {}): LlmProvider {
  const logger = deps.logger
  let client: Anthropic | undefined

  function getClient(): Anthropic {
    if (!config.llmConfigured) throw new LlmNotConfiguredError()
    // Lazy singleton: constructed on first real call so an unconfigured boot
    // never touches the SDK, and tests can point ANTHROPIC_BASE_URL at a stub.
    client ??= new Anthropic({
      apiKey: config.anthropicApiKey,
      ...(config.anthropicBaseUrl ? { baseURL: config.anthropicBaseUrl } : {}),
    })
    return client
  }

  function requestParams<I>(model: string, prompt: PromptModule<I>, input: I, schema: z.ZodType, maxTokens: number) {
    return {
      model,
      max_tokens: maxTokens,
      // cache_control on the static system block: everything up to here is
      // byte-stable per prompt version → cached prefix on every later call.
      system: [{ type: 'text' as const, text: prompt.system, cache_control: { type: 'ephemeral' as const } }],
      messages: [{ role: 'user' as const, content: prompt.render(input) }],
      output_config: { format: { type: 'json_schema' as const, schema: toOutputJsonSchema(schema) } },
    }
  }

  function extractUsage(message: Anthropic.Message): LlmUsage {
    const usage: LlmUsage = {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
    }
    if (typeof message.usage.cache_read_input_tokens === 'number') {
      usage.cache_read_input_tokens = message.usage.cache_read_input_tokens
    }
    return usage
  }

  function parseOutput<T>(kind: string, message: Anthropic.Message, schema: z.ZodType<T>): T {
    // Order matters: judge stop_reason before touching content — a refusal
    // arrives as HTTP 200 with empty (or partial, mid-stream) content.
    if (message.stop_reason === 'refusal') throw new LlmRefusedError(`${kind}: model refused (stop_reason: refusal)`)
    if (message.stop_reason === 'max_tokens') {
      throw new LlmOutputInvalidError(`${kind}: output truncated at max_tokens — structured output is incomplete`)
    }
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
    if (!text) throw new LlmOutputInvalidError(`${kind}: response contained no text content`)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new LlmOutputInvalidError(`${kind}: response is not valid JSON`, { text: text.slice(0, 500) })
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      // No silent partials: schema-invalid output is a hard error carrying the
      // zod issues so wk_ingest_jobs.error and logs show WHAT was malformed.
      throw new LlmOutputInvalidError(`${kind}: output failed schema validation`, parsed.error.issues)
    }
    return parsed.data
  }

  async function call<I, T>(args: {
    kind: 'classify' | 'synthesize' | 'answer'
    model: string
    prompt: PromptModule<I>
    promptVersion: string
    input: I
    schema: z.ZodType<T>
    stream: boolean
  }): Promise<LlmResult<T>> {
    if (!config.llmConfigured) throw new LlmNotConfiguredError()
    const params = requestParams(args.model, args.prompt, args.input, args.schema, MAX_TOKENS[args.kind])
    const started = Date.now()
    // Streaming vs create is a transport detail: both paths resolve to the
    // same complete Message (finalMessage collects the stream), so parsing
    // and audit metadata are identical.
    const message = args.stream
      ? await getClient().messages.stream(params).finalMessage()
      : await getClient().messages.create(params)
    const duration_ms = Date.now() - started
    const output = parseOutput(args.kind, message, args.schema)
    const run = {
      // message.model is what actually served the request (aliases resolve
      // server-side) — the honest value for the wk_agent_runs audit ledger.
      model: message.model,
      prompt_version: args.promptVersion,
      input_hash: computeInputHash(args.promptVersion, args.prompt.system, args.prompt.render(args.input)),
      usage: extractUsage(message),
      duration_ms,
    }
    logger?.debug('llm call complete', {
      kind: args.kind,
      model: run.model,
      prompt_version: run.prompt_version,
      duration_ms,
      ...run.usage,
    })
    return { output, run }
  }

  return {
    get configured() {
      return config.llmConfigured
    },
    classify(input: ClassifyInput): Promise<LlmResult<ClassifyOutput>> {
      return call({
        kind: 'classify',
        model: config.modelClassify,
        prompt: classifyV1,
        promptVersion: PROMPT_VERSIONS.classify,
        input,
        schema: zClassifyOutput,
        stream: false,
      })
    },
    synthesize(input: SynthesizeInput): Promise<LlmResult<SynthesizeOutput>> {
      return call({
        kind: 'synthesize',
        model: config.modelSynthesis,
        prompt: synthesizeV1,
        promptVersion: PROMPT_VERSIONS.synthesize,
        input,
        schema: zSynthesizeOutput,
        stream: true, // long output — stream to dodge HTTP timeouts
      })
    },
    answer(input: AnswerInput): Promise<LlmResult<AnswerOutput>> {
      return call({
        kind: 'answer',
        model: config.modelAnswer,
        prompt: answerV1,
        promptVersion: PROMPT_VERSIONS.answer,
        input,
        schema: zAnswerOutput,
        stream: false,
      })
    },
  }
}
