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

/** 422 unprocessable — well-formed request whose semantics are invalid
 *  (e.g. role AND scopes on an identity grant, or an unconfigured provider).
 *  Distinct from 400 bad_request: the shape parsed fine, the meaning did not. */
export class UnprocessableError extends DomainError {
  constructor(message: string) {
    super('unprocessable', message, 422)
  }
}

/** 409 — code narrows to the canonical conflicts. */
export type ConflictCode =
  | 'already_ingested'
  | 'proposal_not_pending'
  | 'stale_base'
  | 'sync_version_conflict'
  | 'identity_revoked'
  | 'concept_deleted'
  | 'concept_not_readable'
  | 'concept_not_deleted'
  | 'ingest_not_captured'

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

/**
 * 429 ingest_queue_full — this space already has WIKIKIT_INGEST_MAX_QUEUED_PER_SPACE
 * jobs waiting, so enqueue refuses instead of accepting work nobody will see
 * finish.
 *
 * WHY a REFUSAL and not a longer queue. Dropping fifty files into the inbox
 * costs fifty classify calls plus one synthesis call per affected page, i.e.
 * real money and hours of wall clock, and every one of them lands as a separate
 * proposal a human has to review. A queue that silently accepts all of it looks
 * identical to one that is keeping up — right up to the point where the review
 * backlog is unclearable (the production finding this cap exists for). The
 * person doing the dropping is the only one who can decide to stop, so they are
 * told.
 *
 * WHY it is NOT `rate_limited`, which is the neighbouring 429. Rate limiting is
 * about request FREQUENCY and its remedy is "wait and retry the same call".
 * Here the request was perfectly paced; what is full is the work queue, and the
 * remedy is different in kind — let the queue drain, or clear the review backlog
 * that is holding it. A client that treats this as a rate limit retries in a
 * loop and learns nothing, which is exactly why it gets its own code.
 *
 * `queued` and `limit` ride in the envelope so a bulk uploader can report "37 of
 * your 50 files were accepted, the queue is at its 200-job ceiling" without a
 * second round trip.
 */
export class IngestQueueFullError extends DomainError {
  constructor(queued: number, limit: number) {
    super(
      'ingest_queue_full',
      `this space already has ${queued} ingest jobs waiting (limit ${limit}) — nothing was queued`,
      429,
      {
        details: { queued, limit },
        nextBestActions: [
          'wait for the queue to drain and submit the rest — GET /v1/spaces/{space}/ingests?status=queued shows the backlog',
          'review the pending proposals the earlier jobs produced; a full queue usually means the review gate, not the worker, is the bottleneck',
          'raise WIKIKIT_INGEST_MAX_QUEUED_PER_SPACE only if a human really is going to review that much at once',
        ],
      },
    )
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
          'call wikikit_review_proposal again with only { proposal_id } and nothing else — its result tells you what this key may do next',
          'the decision belongs to the human: it travels through WikiKit’s native review form, the review_url page, or — only when this key holds knowledge:approve (the operator’s opt-in) — a REST call executing the user’s explicit chat instruction; never decide or default yourself',
          'if this client cannot show the review form, relay the review_url from the hand-off and check wikikit_proposals later',
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
