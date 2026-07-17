// A stub Anthropic Messages API — the seam that makes E2E possible.
//
// WHY this exists next to FakeProvider: FakeProvider replaces the provider
// OBJECT, so everything between our code and the vendor is untested — the AI
// SDK wiring, the structured-output request, the cache_control placement, the
// usage mapping, the finish-reason handling. Those are exactly the parts that
// break on a dependency bump, and they are invisible to every other suite.
// This stub replaces the vendor's HTTP ENDPOINT instead (config.anthropicBaseUrl
// → us), so the real `ai` + `@ai-sdk/anthropic` code path executes end to end
// with nothing mocked below our own composition root.
//
// It speaks the shape the SDK actually sends (verified against the live SDK):
//   POST <baseURL>/messages
//   { model, max_tokens, output_config: { format: { type: 'json_schema', schema } },
//     messages: [{ role: 'user', content: [systemPart(+cache_control), renderedPart] }] }
// and answers a normal message whose single text part is the JSON object.

export interface StubCall {
  model: string
  maxTokens: number
  /** The byte-stable system prompt — content part 0. */
  system: string
  /** The per-call rendered prompt — content part 1. */
  rendered: string
  /** Anthropic prompt caching: set by the SDK from providerOptions. */
  cacheControl: unknown
  /** The structured-output schema the SDK derived from our zod object. */
  schema: Record<string, unknown>
  parts: number
}

/** Which prompt is calling, keyed off the system prompt's opening line. */
export type CallKind = 'classify' | 'synthesize' | 'answer' | 'distill' | 'unknown'

export function callKind(system: string): CallKind {
  if (system.startsWith('You are the classification stage')) return 'classify'
  if (system.startsWith('You are the synthesis stage')) return 'synthesize'
  if (system.startsWith('You are the answer stage')) return 'answer'
  if (system.startsWith('You are the session-distillation stage')) return 'distill'
  return 'unknown'
}

export interface LlmStub {
  /** Pass as config.anthropicBaseUrl. */
  url: string
  /** Every request, in order — the assertion surface. */
  calls: StubCall[]
  stop(): void
}

interface AnthropicRequest {
  model: string
  max_tokens: number
  output_config?: { format?: { schema?: Record<string, unknown> } }
  messages: { role: string; content: { type: string; text?: string; cache_control?: unknown }[] }[]
}

/**
 * Start the stub. `respond` returns the object the model should "produce" for
 * a call; returning null answers with a `refusal` stop reason so the error
 * mapping can be driven too.
 */
export function startLlmStub(respond: (kind: CallKind, call: StubCall) => unknown): LlmStub {
  const calls: StubCall[] = []

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as AnthropicRequest
      const content = body.messages[0]?.content ?? []
      const call: StubCall = {
        model: body.model,
        maxTokens: body.max_tokens,
        system: content[0]?.text ?? '',
        rendered: content[1]?.text ?? '',
        cacheControl: content[0]?.cache_control,
        schema: body.output_config?.format?.schema ?? {},
        parts: content.length,
      }
      calls.push(call)

      const output = respond(callKind(call.system), call)
      if (output === null) {
        return Response.json({
          id: 'msg_stub',
          type: 'message',
          role: 'assistant',
          model: `${body.model}-stub`,
          content: [],
          stop_reason: 'refusal',
          usage: { input_tokens: 1, output_tokens: 0 },
        })
      }
      return Response.json({
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        // Deliberately not echoing body.model: the audit ledger must record the
        // model the API ANSWERED with (a real API returns a dated id), not the
        // alias we asked for. Suffixing proves the value flows from the wire.
        model: `${body.model}-stub`,
        content: [{ type: 'text', text: JSON.stringify(output) }],
        stop_reason: 'end_turn',
        // A cache read on every call: lets the suite assert the number reaches
        // wk_agent_runs instead of being dropped in the usage mapping.
        usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 1900 },
      })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop: () => void server.stop(true),
  }
}
