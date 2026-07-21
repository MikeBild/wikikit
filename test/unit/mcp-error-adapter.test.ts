// toToolError — every failure becomes a terminal, actionable envelope in the
// SDK's fixed error frame (CONTRACTS §7.2, §8). The critical invariants:
// next_best_actions is ALWAYS present and non-empty (agents terminate instead
// of looping), and unknown errors NEVER leak internals.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  ConflictError,
  ForbiddenError,
  HumanDecisionRequiredError,
  LlmNotConfiguredError,
  NotFoundError,
} from '../../src/domain/errors.ts'
import { toToolError } from '../../src/mcp/error-adapter.ts'

function envelopeOf(result: ReturnType<typeof toToolError>): Record<string, unknown> {
  expect(result.isError).toBe(true)
  expect(result.content).toHaveLength(1)
  expect(result.content[0].type).toBe('text')
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

describe('toToolError', () => {
  test('DomainError maps code, message, request_id and carries its details', () => {
    const err = new ConflictError('already_ingested', 'content already ingested as source abc', {
      details: { source_id: 'abc' },
    })
    const envelope = envelopeOf(toToolError(err, 'req123456789'))
    expect(envelope.code).toBe('already_ingested')
    expect(envelope.error).toBe('content already ingested as source abc')
    expect(envelope.request_id).toBe('req123456789')
    expect(envelope.source_id).toBe('abc') // extra fields ride at the top level, like REST
  })

  test('next_best_actions is always present and non-empty', () => {
    for (const err of [
      new NotFoundError('concept x not found'),
      new ForbiddenError(),
      new LlmNotConfiguredError('ANTHROPIC_API_KEY'),
      new Error('boom'),
      'a bare string',
    ]) {
      const envelope = envelopeOf(toToolError(err, 'aaaabbbbcccc'))
      const actions = envelope.next_best_actions as string[]
      expect(Array.isArray(actions)).toBe(true)
      expect(actions.length).toBeGreaterThan(0)
    }
  })

  test('explicit nextBestActions on the error win over the defaults', () => {
    const err = new ConflictError('stale_base', 'moved on', { nextBestActions: ['reject this proposal'] })
    const envelope = envelopeOf(toToolError(err, 'aaaabbbbcccc'))
    expect(envelope.next_best_actions).toEqual(['reject this proposal'])
  })

  test('approval_requires_human carries the human-decision guidance', () => {
    const envelope = envelopeOf(toToolError(new HumanDecisionRequiredError(), 'aaaabbbbcccc'))
    expect(envelope.code).toBe('approval_requires_human')
    expect(String(envelope.error)).toContain('only { proposal_id }')
    const actions = (envelope.next_best_actions as string[]).join(' ')
    expect(actions).toContain('only { proposal_id }')
    expect(actions).toContain('never collect approve/reject in chat')
  })

  test('zod errors become bad_request with a per-field summary', () => {
    const parse = z.object({ space: z.string().min(1), limit: z.number().int() }).safeParse({ limit: 'x' })
    expect(parse.success).toBe(false)
    const envelope = envelopeOf(toToolError(parse.error, 'aaaabbbbcccc'))
    expect(envelope.code).toBe('bad_request')
    expect(String(envelope.error)).toContain('space')
    expect(String(envelope.error)).toContain('limit')
  })

  test('unknown errors are internal_error and never leak the message', () => {
    const envelope = envelopeOf(toToolError(new Error('postgres://user:secret@host/db exploded'), 'aaaabbbbcccc'))
    expect(envelope.code).toBe('internal_error')
    expect(String(envelope.error)).not.toContain('secret')
    expect(envelope.error).toBe('internal error')
  })
})
