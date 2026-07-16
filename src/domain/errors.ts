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

/** 503 llm_not_configured — LLM-free features keep working without a key. */
export class LlmNotConfiguredError extends DomainError {
  constructor(message = 'no ANTHROPIC_API_KEY configured — LLM features are disabled') {
    super('llm_not_configured', message, 503, {
      nextBestActions: [
        'set ANTHROPIC_API_KEY and restart',
        'use the LLM-free endpoints (search, read, lint, export) meanwhile',
      ],
    })
  }
}
