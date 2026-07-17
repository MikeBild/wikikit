// AI SDK-backed LlmProvider (Vercel AI SDK 7) — the single provider
// implementation (CONTRACTS.md §3.1). Replaces the raw vendor SDK so WikiKit is
// provider-agnostic: classify/synthesize/answer are one generateObject() call
// each, and switching provider is a config value (WIKIKIT_LLM_PROVIDER), never
// a code change.
//
// Design decisions (WHY):
// - Structured output via generateObject(schema): the model is constrained to
//   the SAME Zod objects the rest of the system validates with; a schema-invalid
//   response is a hard LlmOutputInvalidError (no silent partials).
// - Prompt caching CORRECTLY: cache_control must ride on a message part, not a
//   top-level system string (a benchmark showed ~5x input-token cost on
//   synthesis otherwise). The static system prompt is sent as a system MESSAGE
//   carrying providerOptions.anthropic.cacheControl, so every call after the
//   first reads the cached prefix. Anthropic-only — the guard skips it for
//   providers without prompt caching.
// - stop/finish reasons are checked: 'content-filter' → LlmRefusedError (a
//   safety refusal; retrying the identical input refuses again), 'length' →
//   LlmOutputInvalidError (a truncated object is not a partial success). The AI
//   SDK's own NoObjectGeneratedError (schema couldn't be satisfied) also maps to
//   LlmOutputInvalidError.
// - maxRetries: the SDK retries transient errors (429/5xx) with backoff, so a
//   flaky call no longer fails an ingest job on the first blip.
// - Lazy model construction: an unconfigured provider (no key) is a valid object
//   that throws LlmNotConfiguredError on use — the 503 path.
import { generateObject, NoObjectGeneratedError, type LanguageModel } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
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
import * as distillV1 from './prompts/distill.v1.ts'
import {
  zAnswerOutput,
  zClassifyOutput,
  zDistillOutput,
  zSynthesizeOutput,
  type AnswerInput,
  type AnswerOutput,
  type ClassifyInput,
  type ClassifyOutput,
  type DistillInput,
  type DistillOutput,
  type SynthesizeInput,
  type SynthesizeOutput,
} from './schemas.ts'
import type { z } from 'zod'

// Output ceilings per call kind (maxOutputTokens): classify emits tiny JSON;
// synthesis carries a full page body; answers are a few paragraphs.
const MAX_TOKENS = { classify: 2048, synthesize: 32_000, answer: 8192, distill: 4096 } as const

interface PromptModule<I> {
  system: string
  render(input: I): string
}

/** A resolved provider: a model factory + whether it supports Anthropic-style prompt caching. */
interface ResolvedProvider {
  model(id: string): LanguageModel
  supportsCaching: boolean
}

function resolveProvider(config: Config): ResolvedProvider {
  switch (config.llmProvider) {
    case 'openai':
      return { model: createOpenAI({ apiKey: config.llmApiKey }), supportsCaching: false }
    case 'google':
      return { model: createGoogleGenerativeAI({ apiKey: config.llmApiKey }), supportsCaching: false }
    case 'anthropic':
    default:
      return {
        // baseURL lets the e2e stub intercept; undefined → the SDK default.
        model: createAnthropic({
          apiKey: config.llmApiKey,
          ...(config.anthropicBaseUrl ? { baseURL: config.anthropicBaseUrl } : {}),
        }),
        supportsCaching: true,
      }
  }
}

export function createLlmProvider(config: Config, deps: { logger?: Logger } = {}): LlmProvider {
  const logger = deps.logger
  let resolved: ResolvedProvider | undefined

  function provider(): ResolvedProvider {
    if (!config.llmConfigured) throw new LlmNotConfiguredError(config.llmApiKeyEnv)
    return (resolved ??= resolveProvider(config))
  }

  // How the static system prompt reaches the model. Two shapes:
  // - Anthropic: AI SDK v7 forbids system messages in the array, and a
  //   top-level `system` string cannot carry cache_control — so the byte-stable
  //   system prompt is sent as the FIRST text part of a user message WITH
  //   cache_control. That part becomes the cached prefix (cache-read on every
  //   later call); the rendered input follows as a second, uncached part.
  // - Other providers (no Anthropic prompt caching): the plain top-level
  //   `system` string + `prompt`.
  function promptFields<I>(p: ResolvedProvider, prompt: PromptModule<I>, rendered: string) {
    if (p.supportsCaching) {
      return {
        messages: [
          {
            role: 'user' as const,
            content: [
              {
                type: 'text' as const,
                text: prompt.system,
                providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } },
              },
              { type: 'text' as const, text: rendered },
            ],
          },
        ],
      }
    }
    return { system: prompt.system, prompt: rendered }
  }

  function extractUsage(usage: {
    inputTokens?: number
    outputTokens?: number
    // AI SDK 7: inputTokens is the TOTAL input (fresh + cache reads);
    // inputTokenDetails splits it. We record the FRESH count as input_tokens
    // (billed at full rate) and cache reads separately (~0.1x) — the cost-
    // accurate shape the audit ledger and telemetry expect.
    inputTokenDetails?: { cacheReadTokens?: number; noCacheTokens?: number }
  }): LlmUsage {
    const cacheRead = usage.inputTokenDetails?.cacheReadTokens
    const fresh = usage.inputTokenDetails?.noCacheTokens ?? usage.inputTokens ?? 0
    const out: LlmUsage = { input_tokens: fresh, output_tokens: usage.outputTokens ?? 0 }
    if (typeof cacheRead === 'number') out.cache_read_input_tokens = cacheRead
    return out
  }

  async function call<I, T>(args: {
    kind: 'classify' | 'synthesize' | 'answer' | 'distill'
    model: string
    promptVersion: string
    prompt: PromptModule<I>
    input: I
    schema: z.ZodType<T>
  }): Promise<LlmResult<T>> {
    const p = provider()
    const rendered = args.prompt.render(args.input)
    const started = Date.now()
    let result
    try {
      result = await generateObject({
        model: p.model(args.model),
        schema: args.schema,
        ...promptFields(p, args.prompt, rendered),
        maxOutputTokens: MAX_TOKENS[args.kind],
        maxRetries: 2,
      })
    } catch (error) {
      // The SDK could not produce a schema-valid object (malformed/parse fail):
      // a hard error carrying the cause, mirroring the raw provider's contract.
      if (NoObjectGeneratedError.isInstance(error)) {
        throw new LlmOutputInvalidError(`${args.kind}: model did not produce schema-valid output`, {
          cause: (error as Error).message,
          finishReason: (error as { finishReason?: string }).finishReason,
        })
      }
      throw error
    }
    const duration_ms = Date.now() - started

    // A truncated object is not a partial success; a safety refusal is terminal.
    if (result.finishReason === 'length') {
      throw new LlmOutputInvalidError(
        `${args.kind}: output truncated at maxOutputTokens — structured output is incomplete`,
      )
    }
    if (result.finishReason === 'content-filter') {
      throw new LlmRefusedError(`${args.kind}: model refused (finishReason: content-filter)`)
    }

    const run = {
      // The model id the provider actually served (aliases resolve server-side).
      model: (result.response as { modelId?: string })?.modelId ?? args.model,
      prompt_version: args.promptVersion,
      input_hash: computeInputHash(args.promptVersion, args.prompt.system, rendered),
      usage: extractUsage(result.usage),
      duration_ms,
    }
    logger?.debug('llm call complete', {
      kind: args.kind,
      model: run.model,
      prompt_version: run.prompt_version,
      duration_ms,
      ...run.usage,
    })
    return { output: result.object, run }
  }

  return {
    get configured() {
      return config.llmConfigured
    },
    get apiKeyEnv() {
      return config.llmApiKeyEnv
    },
    classify(input: ClassifyInput): Promise<LlmResult<ClassifyOutput>> {
      return call({
        kind: 'classify',
        model: config.modelClassify,
        promptVersion: PROMPT_VERSIONS.classify,
        prompt: classifyV1,
        input,
        schema: zClassifyOutput,
      })
    },
    synthesize(input: SynthesizeInput): Promise<LlmResult<SynthesizeOutput>> {
      return call({
        kind: 'synthesize',
        model: config.modelSynthesis,
        promptVersion: PROMPT_VERSIONS.synthesize,
        prompt: synthesizeV1,
        input,
        schema: zSynthesizeOutput,
      })
    },
    answer(input: AnswerInput): Promise<LlmResult<AnswerOutput>> {
      return call({
        kind: 'answer',
        model: config.modelAnswer,
        promptVersion: PROMPT_VERSIONS.answer,
        prompt: answerV1,
        input,
        schema: zAnswerOutput,
      })
    },
    distill(input: DistillInput): Promise<LlmResult<DistillOutput>> {
      return call({
        // Filter-shaped like classify, so it rides the same cheap model: it
        // runs after EVERY captured session and usually returns nothing.
        kind: 'distill',
        model: config.modelClassify,
        promptVersion: PROMPT_VERSIONS.distill,
        prompt: distillV1,
        input,
        schema: zDistillOutput,
      })
    },
  }
}
