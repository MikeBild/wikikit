// Anthropic provider tests against a local HTTP stub (ANTHROPIC_BASE_URL
// pattern — the same seam the e2e suite uses). No network, no real key.
//
// What is pinned here: request shape (model routing, structured-output format,
// cache_control on the static system block, absence of sampling params),
// response handling (zod-validated output, refusal/max_tokens/garbage paths),
// and the wk_agent_runs audit meta including input_hash parity with the
// FakeProvider.
import { afterAll, describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config.ts'
import { createAnthropicProvider } from '../../src/llm/anthropic.ts'
import { createFakeProvider, loadLlmFixture } from '../helpers/fake-provider.ts'
import { LlmNotConfiguredError, LlmOutputInvalidError, LlmRefusedError } from '../../src/llm/provider.ts'
import { PROMPT_VERSIONS } from '../../src/llm/prompts/index.ts'
import type { AnswerInput, ClassifyInput, SynthesizeInput } from '../../src/llm/schemas.ts'

// ---------------------------------------------------------------------------
// Stub Anthropic API
// ---------------------------------------------------------------------------

interface StubState {
  /** Next response body factory; the handler resets to the default after use. */
  nextMessage: (requested: Record<string, unknown>) => Record<string, unknown>
  requests: Record<string, unknown>[]
}

function messageBody(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'stub-model-1',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 45, cache_creation_input_tokens: 0, cache_read_input_tokens: 80 },
    ...extra,
  }
}

/** Serialize a complete message as the SSE event stream the SDK expects. */
function sseFromMessage(message: Record<string, unknown>): string {
  const content = message.content as { type: string; text: string }[]
  const text = content.map((c) => c.text).join('')
  const start = { ...message, content: [], stop_reason: null, stop_sequence: null }
  const events: [string, Record<string, unknown>][] = [
    ['message_start', { type: 'message_start', message: start }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
    ],
    // split into two deltas to prove accumulation works
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 10) } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(10) } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: message.usage,
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

const state: StubState = {
  nextMessage: () => messageBody(JSON.stringify(loadLlmFixture('classify.output.json'))),
  requests: [],
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Record<string, unknown>
    state.requests.push(body)
    const message = state.nextMessage(body)
    if (body.stream === true) {
      return new Response(sseFromMessage(message), { headers: { 'content-type': 'text/event-stream' } })
    }
    return Response.json(message)
  },
})

afterAll(() => {
  server.stop(true)
})

// ---------------------------------------------------------------------------
// Config factory — a literal, not loadConfig(): unit tests must not depend on
// process.env or .env.defaults.
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    root: process.cwd(),
    production: false,
    host: '127.0.0.1',
    port: 4060,
    publicUrl: 'http://127.0.0.1:4060',
    databaseUrl: 'postgresql://test',
    keyPepper: 'test-pepper',
    bootstrapApiKey: '',
    anthropicApiKey: 'test-key',
    anthropicBaseUrl: `http://127.0.0.1:${server.port}`,
    modelSynthesis: 'claude-sonnet-5',
    modelClassify: 'claude-haiku-4-5',
    modelAnswer: 'claude-sonnet-5',
    maxBodyBytes: 10 * 1024 * 1024,
    maxIngestTokens: 100_000,
    ingestConcurrency: 2,
    webhookPollMs: 5000,
    webhookTimeoutMs: 10_000,
    webhookMaxAttempts: 10,
    webhookCircuitThreshold: 5,
    webhookAllowPrivateTargets: true,
    trustProxy: false,
    mcpSessionTtlMs: 30 * 60 * 1000,
    mcpMaxSessions: 200,
    logLevel: 'error',
    version: '0.0.0-test',
    llmConfigured: true,
    ...overrides,
  }
}

const classifyInput: ClassifyInput = {
  source: { title: 'OKF Announcement', markdown: 'Google released OKF as draft v0.1.' },
  conceptIndex: [{ slug: 'open-knowledge-format', title: 'Open Knowledge Format', summary: 'Bundle format.' }],
}

const synthesizeInput: SynthesizeInput = {
  concept: { slug: 'open-knowledge-format', title: 'Open Knowledge Format', currentMarkdown: '# OKF' },
  source: { id: 'src-1', title: 'OKF Announcement', markdown: 'The specification is published as draft v0.1.' },
  predicates: ['is', 'has_status', 'published_by'],
}

const answerInput: AnswerInput = {
  question: 'Is OKF production ready?',
  evidence: [{ kind: 'concept', slug: 'open-knowledge-format', text: 'OKF is a draft at v0.1.', status: null }],
}

function stubOnce(message: Record<string, unknown>): void {
  state.nextMessage = () => message
}

function lastRequest(): Record<string, unknown> {
  return state.requests[state.requests.length - 1]!
}

// ---------------------------------------------------------------------------

describe('llm_not_configured gate', () => {
  test('configured=false without an API key; every method throws LlmNotConfiguredError', async () => {
    const provider = createAnthropicProvider(makeConfig({ anthropicApiKey: '', llmConfigured: false }))
    expect(provider.configured).toBe(false)
    const before = state.requests.length
    await expect(provider.classify(classifyInput)).rejects.toBeInstanceOf(LlmNotConfiguredError)
    await expect(provider.synthesize(synthesizeInput)).rejects.toBeInstanceOf(LlmNotConfiguredError)
    await expect(provider.answer(answerInput)).rejects.toBeInstanceOf(LlmNotConfiguredError)
    expect(state.requests.length).toBe(before) // no network attempted
    // the error carries the 503 envelope facts
    const err = await provider.classify(classifyInput).catch((e: LlmNotConfiguredError) => e)
    expect(err).toMatchObject({ code: 'llm_not_configured', status: 503 })
    expect((err as LlmNotConfiguredError).next_best_actions[0]).toContain('ANTHROPIC_API_KEY')
  })
})

describe('classify (non-streaming, structured output)', () => {
  test('happy path: parsed output + audit run meta', async () => {
    stubOnce(messageBody(JSON.stringify(loadLlmFixture('classify.output.json'))))
    const provider = createAnthropicProvider(makeConfig())
    const { output, run } = await provider.classify(classifyInput)

    expect(output).toEqual(loadLlmFixture('classify.output.json'))
    expect(run.model).toBe('stub-model-1') // model that actually served it
    expect(run.prompt_version).toBe(PROMPT_VERSIONS.classify)
    expect(run.input_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(run.usage).toEqual({ input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 80 })
    expect(run.duration_ms).toBeGreaterThanOrEqual(0)
  })

  test('request shape: model routing, json_schema format, cached system block, no sampling params', async () => {
    stubOnce(messageBody(JSON.stringify(loadLlmFixture('classify.output.json'))))
    await createAnthropicProvider(makeConfig()).classify(classifyInput)
    const req = lastRequest()

    expect(req.model).toBe('claude-haiku-4-5') // WIKIKIT_MODEL_CLASSIFY routing
    expect(req.stream).toBeUndefined()
    // structured outputs: json_schema with closed objects
    const format = (req.output_config as { format: { type: string; schema: Record<string, unknown> } }).format
    expect(format.type).toBe('json_schema')
    expect(format.schema.additionalProperties).toBe(false)
    // static system block carries cache_control (prompt caching contract)
    const system = req.system as { type: string; text: string; cache_control?: { type: string } }[]
    expect(system).toHaveLength(1)
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
    // claude-sonnet-5/haiku reject non-default sampling params — we send none
    expect(req.temperature).toBeUndefined()
    expect(req.top_p).toBeUndefined()
    expect(req.top_k).toBeUndefined()
  })

  test('input_hash parity with the FakeProvider for the same input', async () => {
    stubOnce(messageBody(JSON.stringify(loadLlmFixture('classify.output.json'))))
    const real = await createAnthropicProvider(makeConfig()).classify(classifyInput)
    const fake = await createFakeProvider().classify(classifyInput)
    expect(real.run.input_hash).toBe(fake.run.input_hash)
  })
})

describe('synthesize (streaming)', () => {
  test('streams, accumulates, validates, and reports usage', async () => {
    const fixture = loadLlmFixture('synthesize.output.json')
    stubOnce(messageBody(JSON.stringify(fixture), { model: 'stub-sonnet' }))
    const provider = createAnthropicProvider(makeConfig())
    const { output, run } = await provider.synthesize(synthesizeInput)

    expect(lastRequest().stream).toBe(true) // long synthesis streams
    expect(lastRequest().model).toBe('claude-sonnet-5')
    expect(output).toEqual(fixture as never)
    expect(run.model).toBe('stub-sonnet')
    expect(run.prompt_version).toBe(PROMPT_VERSIONS.synthesize)
    expect(run.usage.output_tokens).toBe(45)
  })
})

describe('answer', () => {
  test('routes to the answer model and validates output', async () => {
    stubOnce(messageBody(JSON.stringify(loadLlmFixture('answer.output.json'))))
    const { output, run } = await createAnthropicProvider(makeConfig()).answer(answerInput)
    expect(lastRequest().model).toBe('claude-sonnet-5')
    expect(output.not_in_knowledge_base).toBe(false)
    expect(run.prompt_version).toBe(PROMPT_VERSIONS.answer)
  })
})

describe('failure handling', () => {
  test('stop_reason refusal → LlmRefusedError (checked before content)', async () => {
    stubOnce(messageBody('', { content: [], stop_reason: 'refusal' }))
    const err = await createAnthropicProvider(makeConfig())
      .classify(classifyInput)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmRefusedError)
    expect(err).toMatchObject({ code: 'llm_refused' })
  })

  test('stop_reason max_tokens → LlmOutputInvalidError (truncated JSON is not a partial success)', async () => {
    stubOnce(messageBody('{"affected": ["x', { stop_reason: 'max_tokens' }))
    await expect(createAnthropicProvider(makeConfig()).classify(classifyInput)).rejects.toBeInstanceOf(
      LlmOutputInvalidError,
    )
  })

  test('non-JSON text → LlmOutputInvalidError', async () => {
    stubOnce(messageBody('I cannot help with that.'))
    await expect(createAnthropicProvider(makeConfig()).classify(classifyInput)).rejects.toBeInstanceOf(
      LlmOutputInvalidError,
    )
  })

  test('schema-invalid JSON → LlmOutputInvalidError carrying zod issues', async () => {
    stubOnce(messageBody(JSON.stringify({ affected: 'not-an-array', new: [] })))
    const err = await createAnthropicProvider(makeConfig())
      .classify(classifyInput)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmOutputInvalidError)
    expect((err as LlmOutputInvalidError).details).toBeDefined()
  })

  test('empty content without refusal → LlmOutputInvalidError', async () => {
    stubOnce(messageBody('', { content: [] }))
    await expect(createAnthropicProvider(makeConfig()).classify(classifyInput)).rejects.toBeInstanceOf(
      LlmOutputInvalidError,
    )
  })
})
