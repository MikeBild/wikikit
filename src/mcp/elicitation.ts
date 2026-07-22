// Native MCP form elicitation for WikiKit's synchronous proposal-review gate.
//
// This module deliberately knows only the small form/result interface supplied
// by server.ts. It does not import the MCP Server or transport, so domain tools
// remain independently testable and cannot accidentally send unrelated
// server→client requests.
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { InvalidElicitationResponseError } from '../domain/errors.ts'
import type { ProposalWireDetail } from '../domain/proposals.ts'

export const REVIEW_NOTE_MAX_LENGTH = 2000

export const zProposalReviewElicitationContent = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(REVIEW_NOTE_MAX_LENGTH).optional(),
})

export type ProposalReviewElicitationContent = z.infer<typeof zProposalReviewElicitationContent>

export interface FormElicitationRequest {
  mode: 'form'
  message: string
  requestedSchema: {
    type: 'object'
    properties: {
      decision: {
        type: 'string'
        title: string
        description: string
        enum: ['approve', 'reject']
        enumNames: ['Approve', 'Reject']
      }
      note: {
        type: 'string'
        title: string
        description: string
        maxLength: number
      }
    }
    required: ['decision']
  }
}

export interface FormElicitationResult {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, string | number | boolean | string[]>
}

export type ElicitForm = (request: FormElicitationRequest) => Promise<FormElicitationResult>

function reviewMessage(proposal: ProposalWireDetail, retry: boolean): string {
  const claims = proposal.concepts.reduce((total, concept) => total + concept.claims_added.length, 0)
  const disputes = proposal.concepts.reduce((total, concept) => total + concept.claims_disputed.length, 0)
  const prefix = retry ? 'The previous form response was invalid. Please submit a valid decision.\n\n' : ''
  const removals = proposal.relations_removed ?? []
  // The form is the decision surface — a destructive change must be spelled
  // out HERE, not only in the wikikit_proposals diff (a removal-only proposal
  // would otherwise present as "0 concept(s), 0 decision(s)" and read as a
  // no-op at the exact point of decision).
  const removalBlock = removals.length
    ? `\n⚠ Approval DEACTIVATES ${removals.length} active relation(s):\n${removals
        .map((edge) => `  - ${edge.from_slug} ${edge.kind} → ${edge.to_slug}`)
        .join('\n')}\n`
    : ''
  return `${prefix}You are the final human reviewer for ChangeProposal "${proposal.title}" (${proposal.id}) in space "${proposal.space}".

Summary: ${proposal.summary || 'No summary provided.'}
Changes: ${proposal.concepts.length} concept(s), ${proposal.decisions.length} decision(s), ${claims} claim(s), ${disputes} disputed claim(s), ${removals.length} relation removal(s).
${removalBlock}
Inspect the complete diff with wikikit_proposals before deciding. Approve publishes the staged knowledge atomically; reject keeps it out of visible knowledge. Declining or cancelling this form makes no change.`
}

function formRequest(proposal: ProposalWireDetail, retry: boolean): FormElicitationRequest {
  return {
    mode: 'form',
    message: reviewMessage(proposal, retry),
    requestedSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          title: 'Decision',
          description: 'Your final human review decision for this ChangeProposal.',
          enum: ['approve', 'reject'],
          enumNames: ['Approve', 'Reject'],
        },
        note: {
          type: 'string',
          title: 'Review note',
          description: 'Optional rationale stored in the permanent proposal audit trail.',
          maxLength: REVIEW_NOTE_MAX_LENGTH,
        },
      },
      required: ['decision'],
    },
  }
}

function isInvalidParams(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.InvalidParams
}

/**
 * Ask at most twice. The SDK validates accepted content against requestedSchema;
 * zod validates it again before WikiKit exposes a domain decision.
 */
export async function elicitProposalReview(
  elicitForm: ElicitForm,
  proposal: ProposalWireDetail,
): Promise<{ action: 'accept'; content: ProposalReviewElicitationContent } | { action: 'decline' | 'cancel' }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result: FormElicitationResult
    try {
      result = await elicitForm(formRequest(proposal, attempt > 0))
    } catch (error) {
      if (isInvalidParams(error) && attempt === 0) continue
      if (isInvalidParams(error)) throw new InvalidElicitationResponseError()
      throw error
    }

    if (result.action !== 'accept') return { action: result.action }
    const parsed = zProposalReviewElicitationContent.safeParse(result.content)
    if (parsed.success) return { action: 'accept', content: parsed.data }
    if (attempt === 1) throw new InvalidElicitationResponseError()
  }

  // The loop always returns or throws; this keeps the exhaustiveness explicit.
  throw new InvalidElicitationResponseError()
}
