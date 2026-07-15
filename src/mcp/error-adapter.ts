// MCP tool-error adapter (CONTRACTS §7.2, §8) — every failure a tool handler
// can produce becomes a TERMINAL, ACTIONABLE envelope serialized into the
// SDK's fixed `{ isError: true, content: [{ type: 'text', text }] }` frame.
//
// WHY envelopes instead of bare strings (SubKit production learning): an agent
// that receives "not found" as prose retries the same call in a loop, burning
// tokens; an agent that receives `{code, next_best_actions}` terminates and
// pivots. The envelope is byte-shaped like the REST §8.1 error body (same
// `code`, same `request_id` discipline) so operators can match an MCP failure
// to HTTP logs with a single grep.
import { z } from 'zod'
import { DomainError } from '../domain/errors.ts'

// A type alias (not an interface) on purpose: object type literals get an
// implicit index signature, which makes this assignable to the SDK's
// passthrough CallToolResult without a cast at the dispatch site.
export type ToolErrorResult = {
  isError: true
  content: [{ type: 'text'; text: string }]
}

/**
 * Fallback hints per canonical code — `next_best_actions` is ALWAYS present
 * (contract §7.2), so even errors thrown without hints steer the agent
 * somewhere terminal instead of leaving it guessing.
 */
const DEFAULT_ACTIONS: Record<string, string[]> = {
  bad_request: ['fix the listed input fields and call the tool again once'],
  unauthorized: ['verify the API key configured for this MCP server'],
  insufficient_scope: ['use a key holding the required scope', 'call tools/list to see what this key can do'],
  not_found: ['call tools/list to see available tools', 'use wikikit_search to discover existing content'],
  already_ingested: [
    'the content is already knowledge — do not re-submit it',
    'use wikikit_read on the affected concepts',
  ],
  proposal_not_pending: ['fetch the proposal via REST GET /v1/proposals/{id} to see its terminal status'],
  stale_base: ['re-ingest the source so it is synthesized against the current revision'],
  llm_not_configured: ['set ANTHROPIC_API_KEY and restart', 'use the LLM-free tools (search, read, lint) meanwhile'],
  internal_error: ['do not retry immediately', 'report the request_id to the operator'],
}

/** Compact, single-line rendering of zod issues — enough to fix the call. */
function zodIssuesSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
}

/**
 * Render any thrown value into the MCP tool-error frame. Terminal by
 * construction: the text is a JSON envelope with `code`, `request_id` and a
 * non-empty `next_best_actions`, never a bare string.
 */
export function toToolError(err: unknown, requestId: string): ToolErrorResult {
  let code = 'internal_error'
  // WHY the internal message never leaks (contract §8.2): an unrecognized
  // error may carry connection strings or SQL fragments; agents need the code,
  // operators get the real error from the log line keyed by request_id.
  let message = 'internal error'
  let actions: string[] = []
  let details: Record<string, unknown> = {}

  if (err instanceof DomainError) {
    code = err.code
    message = err.message
    actions = err.nextBestActions
    details = err.details
  } else if (err instanceof z.ZodError) {
    code = 'bad_request'
    message = `invalid tool input — ${zodIssuesSummary(err)}`
  }

  if (actions.length === 0) actions = DEFAULT_ACTIONS[code] ?? DEFAULT_ACTIONS.internal_error!

  const envelope = {
    error: message,
    code,
    request_id: requestId,
    next_best_actions: actions,
    // Extra fields ride at the top level exactly like the REST envelope
    // (e.g. already_ingested carries source_id).
    ...details,
  }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(envelope) }] }
}
