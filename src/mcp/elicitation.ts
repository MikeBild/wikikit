// Native MCP elicitation for WikiKit's proposal-review gate — form mode (the
// primary channel: the in-client review dialog, i.e. the terminal form in
// Claude Code/Codex) and URL mode (2025-11-25, the fallback when the form is
// unavailable or provably unrendered: the browser review page, out of band).
//
// This module deliberately knows only the small request/result interfaces
// supplied by server.ts. It does not import the MCP Server or transport, so
// domain tools remain independently testable and cannot accidentally send
// unrelated server→client requests.
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

export interface UrlElicitationRequest {
  mode: 'url'
  /** Unique id for this elicitation — the key notifications/elicitation/complete refers to. */
  elicitationId: string
  /** The review page. MUST NOT be pre-authenticated (spec: Safe URL Handling) —
   *  the page verifies the reviewer's identity itself with their own key. */
  url: string
  message: string
}

export interface UrlElicitationResult {
  action: 'accept' | 'decline' | 'cancel'
}

export type ElicitUrl = (request: UrlElicitationRequest, opts: { proposalId: string }) => Promise<UrlElicitationResult>

/**
 * A form-mode cancel arriving faster than any human could have read the form
 * is the CLIENT auto-cancelling (capability advertised, form never rendered) —
 * observed in the wild, and from the wire indistinguishable from a deliberate
 * dismissal except by time. Below this threshold the review tool falls back
 * (URL consent if available, else the manual hand-off) instead of reporting a
 * human decision that never happened.
 */
export const FORM_FAST_CANCEL_MS = 2000

function reviewSummary(proposal: ProposalWireDetail, retry: boolean): string {
  const claims = proposal.concepts.reduce((total, concept) => total + concept.claims_added.length, 0)
  const disputes = proposal.concepts.reduce((total, concept) => total + concept.claims_disputed.length, 0)
  const prefix = retry ? 'The previous form response was invalid. Please submit a valid decision.\n\n' : ''
  const removals = proposal.relations_removed ?? []
  // The elicitation message is the decision surface — a destructive change
  // must be spelled out HERE, not only in the wikikit_proposals diff (a
  // removal-only proposal would otherwise present as "0 concept(s),
  // 0 decision(s)" and read as a no-op at the exact point of decision).
  const removalBlock = removals.length
    ? `\n⚠ Approval DEACTIVATES ${removals.length} active relation(s):\n${removals
        .map((edge) => `  - ${edge.from_slug} ${edge.kind} → ${edge.to_slug}`)
        .join('\n')}\n`
    : ''
  return `${prefix}You are the final human reviewer for ChangeProposal "${proposal.title}" (${proposal.id}) in space "${proposal.space}".

Summary: ${proposal.summary || 'No summary provided.'}
Changes: ${proposal.concepts.length} concept(s), ${proposal.decisions.length} decision(s), ${claims} claim(s), ${disputes} disputed claim(s), ${removals.length} relation removal(s).
${removalBlock}`
}

function reviewMessage(proposal: ProposalWireDetail, retry: boolean): string {
  return `${reviewSummary(proposal, retry)}
Inspect the complete diff with wikikit_proposals before deciding. Approve publishes the staged knowledge atomically; reject keeps it out of visible knowledge. Declining or cancelling this form makes no change.`
}

/**
 * The URL-mode review request. Accepting only OPENS the review page — the
 * decision itself happens there, out of band, with the reviewer's own
 * credential; the server later signals notifications/elicitation/complete.
 */
export function urlReviewRequest(
  proposal: ProposalWireDetail,
  reviewUrl: string,
  elicitationId: string,
): UrlElicitationRequest {
  return {
    mode: 'url',
    elicitationId,
    url: reviewUrl,
    message: `${reviewSummary(proposal, false)}
Accepting opens WikiKit's review page in your browser — the full diff and the approve/reject decision live there, never in this client. Declining or cancelling makes no change; the proposal stays pending.`,
  }
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
