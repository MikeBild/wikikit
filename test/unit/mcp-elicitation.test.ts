import { describe, expect, test } from 'bun:test'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { InvalidElicitationResponseError } from '../../src/domain/errors.ts'
import type { ProposalWireDetail } from '../../src/domain/proposals.ts'
import {
  REVIEW_NOTE_MAX_LENGTH,
  elicitProposalReview,
  type FormElicitationRequest,
  type FormElicitationResult,
} from '../../src/mcp/elicitation.ts'

const proposal: ProposalWireDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  space: 'demo',
  status: 'pending',
  title: 'Update operating model',
  summary: 'Adds one reviewed rule.',
  created_at: '2026-07-21T08:00:00.000Z',
  reviewer: null,
  review_note: null,
  review_channel: null,
  reviewed_at: null,
  source_ids: [],
  agent_meta: { model: 'manual', prompt_version: 'manual' },
  concepts: [
    {
      slug: 'operating-model',
      is_new: true,
      old_markdown: null,
      new_markdown: '# Operating model',
      claims_added: [{ subject: 'review', predicate: 'requires', object: 'human' }],
      claims_disputed: [],
      claims_deprecated: [],
      relations_added: [],
    },
  ],
  decisions: [],
  relations_removed: [],
}

describe('native proposal review elicitation', () => {
  test('requests a flat human-owned decision form and accepts valid content', async () => {
    let request: FormElicitationRequest | undefined
    const result = await elicitProposalReview(async (value) => {
      request = value
      return { action: 'accept', content: { decision: 'approve', note: 'Reviewed.' } }
    }, proposal)

    expect(result).toEqual({ action: 'accept', content: { decision: 'approve', note: 'Reviewed.' } })
    expect(request!.mode).toBe('form')
    expect(request!.requestedSchema.required).toEqual(['decision'])
    expect(request!.requestedSchema.properties.decision.enum).toEqual(['approve', 'reject'])
    expect(request!.requestedSchema.properties.note.maxLength).toBe(REVIEW_NOTE_MAX_LENGTH)
    expect(request!.message).toContain(proposal.id)
    expect(request!.message).toContain('Inspect the complete diff')
    expect(request!.message).toContain('0 relation removal(s)')
  })

  test('the form message spells out staged relation removals — the human must see the destructive part', async () => {
    let request: FormElicitationRequest | undefined
    await elicitProposalReview(
      async (value) => {
        request = value
        return { action: 'decline' }
      },
      {
        ...proposal,
        relations_removed: [{ from_slug: 'alpha', to_slug: 'legacy-store', kind: 'depends_on' }],
      },
    )
    expect(request!.message).toContain('1 relation removal(s)')
    expect(request!.message).toContain('DEACTIVATES 1 active relation(s)')
    expect(request!.message).toContain('alpha depends_on → legacy-store')
  })

  for (const action of ['decline', 'cancel'] as const) {
    test(`${action} is a terminal no-op`, async () => {
      expect(await elicitProposalReview(async () => ({ action }), proposal)).toEqual({ action })
    })
  }

  test('retries one invalid accepted payload, then returns the valid decision', async () => {
    const responses: FormElicitationResult[] = [
      { action: 'accept', content: { decision: 'maybe' } },
      { action: 'accept', content: { decision: 'reject' } },
    ]
    const messages: string[] = []
    const result = await elicitProposalReview(async (request) => {
      messages.push(request.message)
      return responses.shift()!
    }, proposal)
    expect(result).toEqual({ action: 'accept', content: { decision: 'reject' } })
    expect(messages).toHaveLength(2)
    expect(messages[1]).toStartWith('The previous form response was invalid.')
  })

  test('retries an SDK InvalidParams once and fails closed after the second invalid response', async () => {
    let calls = 0
    await expect(
      elicitProposalReview(async () => {
        calls += 1
        throw new McpError(ErrorCode.InvalidParams, 'schema mismatch')
      }, proposal),
    ).rejects.toBeInstanceOf(InvalidElicitationResponseError)
    expect(calls).toBe(2)
  })
})
