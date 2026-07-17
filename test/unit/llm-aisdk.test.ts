// AI SDK provider — deterministic, network-free. `generateObject` is mocked so
// we test THIS module's logic: the cache-control system message, usage mapping
// (incl. cachedInputTokens), finishReason → error mapping, model-id capture,
// provider selection, and the not-configured 503 path.
import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { LlmNotConfiguredError, LlmOutputInvalidError, LlmRefusedError } from '../../src/llm/provider.ts'
import type { ClassifyInput } from '../../src/llm/schemas.ts'

// Captured args + programmable result for the mocked generateObject.
let lastArgs: Record<string, unknown> | undefined
let nextResult: unknown
let nextThrow: unknown

mock.module('ai', () => ({
  NoObjectGeneratedError: class NoObjectGeneratedError extends Error {
    finishReason?: string
    static isInstance(e: unknown): boolean {
      return e instanceof NoObjectGeneratedError
    }
  },
  async generateObject(args: Record<string, unknown>) {
    lastArgs = args
    if (nextThrow) throw nextThrow
    return nextResult
  },
}))

// Import AFTER the mock is registered.
const { createLlmProvider } = await import('../../src/llm/aisdk.ts')
const { NoObjectGeneratedError } = (await import('ai')) as unknown as {
  NoObjectGeneratedError: { new (m?: string): Error & { finishReason?: string }; isInstance(e: unknown): boolean }
}

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    llmProvider: 'anthropic',
    llmApiKey: 'test-key',
    anthropicBaseUrl: '',
    modelClassify: 'claude-haiku-4-5',
    modelSynthesis: 'claude-sonnet-5',
    modelAnswer: 'claude-sonnet-5',
    llmConfigured: true,
    ...over,
  } as Config
}

const classifyInput: ClassifyInput = {
  source: { title: 'OKF', markdown: 'Google released OKF as draft v0.1.' },
  conceptIndex: [{ slug: 'open-knowledge-format', title: 'OKF', summary: 'A format.' }],
}

function okResult(object: unknown, extra: Record<string, unknown> = {}) {
  return {
    object,
    // AI SDK 7 usage shape: total inputTokens + a split in inputTokenDetails.
    usage: { inputTokens: 2020, outputTokens: 8, inputTokenDetails: { noCacheTokens: 120, cacheReadTokens: 1900 } },
    finishReason: 'stop',
    response: { modelId: 'claude-haiku-4-5-20251001' },
    ...extra,
  }
}

afterEach(() => {
  lastArgs = undefined
  nextResult = undefined
  nextThrow = undefined
})

describe('aisdk provider', () => {
  test('not configured → LlmNotConfiguredError, no call', async () => {
    const provider = createLlmProvider(makeConfig({ llmApiKey: '', llmConfigured: false }))
    expect(provider.configured).toBe(false)
    await expect(provider.classify(classifyInput)).rejects.toBeInstanceOf(LlmNotConfiguredError)
    expect(lastArgs).toBeUndefined()
  })

  // Regression: the 503 used to name ANTHROPIC_API_KEY whatever the provider
  // was, sending openai/google operators to set a variable that gates nothing.
  test('the not-configured 503 names the SELECTED provider key', async () => {
    for (const [provider, keyEnv] of [
      ['openai', 'OPENAI_API_KEY'],
      ['google', 'GOOGLE_GENERATIVE_AI_API_KEY'],
      ['anthropic', 'ANTHROPIC_API_KEY'],
    ] as const) {
      const llm = createLlmProvider(
        makeConfig({ llmProvider: provider, llmApiKeyEnv: keyEnv, llmApiKey: '', llmConfigured: false }),
      )
      expect(llm.apiKeyEnv).toBe(keyEnv)
      const err = (await llm.classify(classifyInput).catch((e: unknown) => e)) as LlmNotConfiguredError
      expect(err).toBeInstanceOf(LlmNotConfiguredError)
      expect(err.message).toContain(keyEnv)
      expect(err.next_best_actions.join(' ')).toContain(keyEnv)
    }
  })

  test('classify (anthropic): system prompt is a cache-controlled leading user part', async () => {
    nextResult = okResult({ affected: ['open-knowledge-format'], new: [] })
    const provider = createLlmProvider(makeConfig())
    const { output, run } = await provider.classify(classifyInput)

    expect(output).toEqual({ affected: ['open-knowledge-format'], new: [] })
    // AI SDK 7 forbids system messages in the array; the byte-stable system
    // prompt rides as the FIRST user text part WITH cache_control (the fix that
    // makes prompt caching actually work).
    const messages = lastArgs!.messages as { role: string; content: { text: string; providerOptions?: unknown }[] }[]
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content[0]!.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
    expect(messages[0]!.content[1]!.providerOptions).toBeUndefined() // rendered input is uncached
    expect(lastArgs!.system).toBeUndefined()
    // Fresh input + cache reads both recorded for cost telemetry.
    expect(run.usage).toEqual({ input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 1900 })
    expect(run.model).toBe('claude-haiku-4-5-20251001') // the model actually served
    expect(run.prompt_version).toBe('classify.v1')
  })

  test('non-anthropic provider uses plain system + prompt (no cache parts)', async () => {
    nextResult = okResult({ affected: [], new: [] })
    const provider = createLlmProvider(makeConfig({ llmProvider: 'openai', modelClassify: 'gpt-x' }))
    await provider.classify(classifyInput)
    expect(lastArgs!.messages).toBeUndefined()
    expect(typeof lastArgs!.system).toBe('string')
    expect(typeof lastArgs!.prompt).toBe('string')
  })

  test('finishReason length → LlmOutputInvalidError (truncation is not a partial success)', async () => {
    nextResult = okResult({ affected: [], new: [] }, { finishReason: 'length' })
    const provider = createLlmProvider(makeConfig())
    await expect(provider.classify(classifyInput)).rejects.toBeInstanceOf(LlmOutputInvalidError)
  })

  test('finishReason content-filter → LlmRefusedError', async () => {
    nextResult = okResult({ affected: [], new: [] }, { finishReason: 'content-filter' })
    const provider = createLlmProvider(makeConfig())
    await expect(provider.classify(classifyInput)).rejects.toBeInstanceOf(LlmRefusedError)
  })

  test('NoObjectGeneratedError → LlmOutputInvalidError', async () => {
    nextThrow = new NoObjectGeneratedError('could not satisfy schema')
    const provider = createLlmProvider(makeConfig())
    await expect(provider.classify(classifyInput)).rejects.toBeInstanceOf(LlmOutputInvalidError)
  })
})
