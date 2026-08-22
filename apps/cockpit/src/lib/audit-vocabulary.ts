import type { TranslationKey } from './i18n'

/**
 * THE WORDS THE AUDIT TRAIL IS READ IN — §15.2's „Vorgang", „Art", „Ergebnis"
 * and the fallback behind „Verursacher".
 *
 * WHY THIS IS A MODULE AND NOT A CONST IN `pages/audit.tsx`.
 *
 * Because something has to be able to check it. A table inside a TSX page can
 * only be read by rendering the page or by parsing it as text, and neither
 * survives a refactor; a table in a plain module is imported by
 * test/unit/cockpit-pages/audit.test.ts, which derives the actions the SERVER
 * actually writes and fails on the first one nothing here names.
 *
 * That guard is the one this repository was missing. A derived list SHRINKS
 * SILENTLY: fewer entries is fewer things checked, which looks exactly like
 * fewer things wrong. So the two readings are independent on purpose — the
 * labels are written down here, the actions are read out of `src/http/routes.ts`
 * — and the test is where they have to agree.
 */

/**
 * The German name for one action, keyed by the action the server wrote.
 *
 * WikiKit's trail is narrow and its action vocabulary is closed: `auditedReview`
 * in src/http/routes.ts is the only writer, and it writes four. An action
 * nobody has named here is absent, and the caller prints the machine value
 * MARKED AS ONE — which §15.2 permits („als solcher erkennbar") and which is
 * neither an invented German sentence nor the word „Unbekannt".
 */
export const AUDIT_OPERATION_KEYS = {
  'proposal.approved': 'audit.op.proposalApproved',
  'proposal.rejected': 'audit.op.proposalRejected',
  'proposal.changes_requested': 'audit.op.proposalChangesRequested',
  'proposal.split': 'audit.op.proposalSplit',
} as const satisfies Record<string, TranslationKey>

/**
 * §15.2's „Art" — the KIND a row is about, keyed by `resource_type`.
 *
 * `resource_type` and not the left half of the action: what `proposal.rejected`
 * is ABOUT is a change proposal, and the verb is the other column.
 */
export const AUDIT_KIND_KEYS = {
  change_proposal: 'audit.kind.changeProposal',
} as const satisfies Record<string, TranslationKey>

/** §15.2's „Ergebnis" — the four outcomes audit.v1 stores. */
export const AUDIT_RESULT_KEYS = {
  success: 'audit.result.success',
  denied: 'audit.result.denied',
  error: 'audit.result.error',
  cancelled: 'audit.result.cancelled',
} as const satisfies Record<string, TranslationKey>

/** How the actor was established — the fallback behind §15.2's „Verursacher". */
export const AUDIT_ACTOR_KEYS = {
  identity: 'audit.actor.identity',
  api_key: 'audit.actor.apiKey',
  operator_session: 'audit.actor.operatorSession',
  system: 'audit.actor.system',
  anonymous: 'audit.actor.anonymous',
} as const satisfies Record<string, TranslationKey>

/** The German name for one action, or null when this module cannot name it. */
export function auditOperationKey(action: string): TranslationKey | null {
  return AUDIT_OPERATION_KEYS[action as keyof typeof AUDIT_OPERATION_KEYS] ?? null
}

/** The German kind for one resource type, or null. §15.2 forbids inventing „Unbekannt". */
export function auditKindKey(resourceType: string): TranslationKey | null {
  return AUDIT_KIND_KEYS[resourceType as keyof typeof AUDIT_KIND_KEYS] ?? null
}
