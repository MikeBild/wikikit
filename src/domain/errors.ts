// Typed domain errors (CONTRACTS §8.2) — thrown by domain modules, mapped to
// wire envelopes by the transports (HTTP status + §8.1 JSON envelope, MCP tool
// error via the error adapter).
//
// WHY typed classes instead of `Object.assign(new Error(), { statusCode })`:
// the error code table is a WIRE CONTRACT here — REST
// clients and MCP agents branch on `code`, so every throw site must pick from
// the canonical set instead of inventing ad-hoc strings. The class carries
// everything the envelope needs (code, status, next_best_actions, extra
// payload fields like already_ingested's source_id) so transports never
// reverse-engineer a message.
export class DomainError extends Error {
  /** Machine code from the §8.2 table — the `code` field of the envelope. */
  readonly code: string
  /** HTTP status the transports map this error to. */
  readonly statusCode: number
  /** Short imperative hints — agents terminate instead of retry-looping. */
  readonly nextBestActions: string[]
  /** Extra envelope fields (e.g. already_ingested carries `source_id`). */
  readonly details: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    statusCode: number,
    options: { nextBestActions?: string[]; details?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.statusCode = statusCode
    this.nextBestActions = options.nextBestActions ?? []
    this.details = options.details ?? {}
  }
}

/** 400 bad_request — zod details belong in the message. */
export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('bad_request', message, 400, { details })
  }
}

/** 401 unauthorized — unknown or revoked key. */
export class UnauthorizedError extends DomainError {
  constructor(message = 'unauthorized') {
    super('unauthorized', message, 401)
  }
}

/** 403 insufficient_scope — known key, missing scope or wrong space. */
export class ForbiddenError extends DomainError {
  constructor(message = 'insufficient scope') {
    super('insufficient_scope', message, 403)
  }
}

/** 404 not_found. */
export class NotFoundError extends DomainError {
  constructor(message = 'not found') {
    super('not_found', message, 404)
  }
}

/** 409 — code narrows to the three canonical conflicts. */
export type ConflictCode = 'already_ingested' | 'proposal_not_pending' | 'stale_base'

export class ConflictError extends DomainError {
  constructor(
    code: ConflictCode,
    message: string,
    options: { nextBestActions?: string[]; details?: Record<string, unknown> } = {},
  ) {
    super(code, message, 409, options)
  }
}

/** 413 body_too_large. */
export class PayloadTooLargeError extends DomainError {
  constructor(message = 'request body too large') {
    super('body_too_large', message, 413)
  }
}

/** 429 rate_limited. */
export class RateLimitError extends DomainError {
  constructor(message = 'rate limited') {
    super('rate_limited', message, 429)
  }
}

/** 409 — the connected MCP client cannot present the required native form.
 *  Backstop only: the review tool detects the missing capability up front and
 *  returns a human_review_required hand-off; this fires when the capability
 *  vanishes mid-flight. The hints must never point the agent at a channel it
 *  could operate itself. */
export class ElicitationNotSupportedError extends DomainError {
  constructor() {
    super('elicitation_not_supported', 'the connected MCP client cannot present WikiKit’s native review form', 409, {
      nextBestActions: [
        'tell the user the proposal stays pending and that a human must review it out-of-band or from an elicitation-capable MCP client',
        'check wikikit_proposals later to see whether the human has decided',
        'do not collect approve/reject in chat and do not approve or reject through any other channel on the human’s behalf',
      ],
    })
  }
}

/** 400 — the caller tried to pass the human review decision as tool input.
 *  Structural refusal, not a validation nit: approve/reject is a person's
 *  decision and never travels through arguments a model controls. */
export class HumanDecisionRequiredError extends DomainError {
  constructor() {
    super(
      'approval_requires_human',
      'approve/reject is a human decision, not tool input — wikikit_review_proposal accepts only { proposal_id }',
      400,
      {
        nextBestActions: [
          'call wikikit_review_proposal again with only { proposal_id } and nothing else',
          'the decision travels only through WikiKit’s native review form or an out-of-band review the human performs themselves — never collect approve/reject in chat and never submit it through any tool, REST call, or connector on the human’s behalf',
          'if this client cannot show the review form, tell the user the proposal stays pending until a human reviews it, and check wikikit_proposals later',
        ],
      },
    )
  }
}

/** 408 — a human did not complete the MCP form within the configured window. */
export class ElicitationTimeoutError extends DomainError {
  constructor() {
    super('elicitation_timeout', 'the MCP review form timed out before the human completed it', 408, {
      nextBestActions: ['confirm the proposal is still pending, then start the review again'],
    })
  }
}

/** 400 — the client accepted a form but returned content outside its schema. */
export class InvalidElicitationResponseError extends DomainError {
  constructor() {
    super('invalid_elicitation_response', 'the MCP client returned an invalid review form response', 400, {
      nextBestActions: ['update or reconnect the MCP client, then start the review again'],
    })
  }
}

/** 502 — the elicitation transport failed; the protected write never ran. */
export class ElicitationFailedError extends DomainError {
  constructor() {
    super('elicitation_failed', 'the MCP review form could not be completed', 502, {
      nextBestActions: ['reconnect the MCP client, confirm the proposal is still pending, and retry'],
    })
  }
}

/**
 * 503 llm_not_configured — LLM-free features keep working without a key.
 * `keyEnv` is the key of the SELECTED provider (config.llmApiKeyEnv /
 * LlmProvider.apiKeyEnv): naming ANTHROPIC_API_KEY on an openai deployment
 * would send the operator to fix a variable that does not gate anything.
 */
export class LlmNotConfiguredError extends DomainError {
  constructor(
    readonly keyEnv: string,
    message = `no ${keyEnv} configured — LLM features are disabled`,
  ) {
    super('llm_not_configured', message, 503, {
      nextBestActions: [
        `set ${keyEnv} and restart`,
        'use the LLM-free endpoints (search, read, lint, export) meanwhile',
      ],
    })
  }
}
