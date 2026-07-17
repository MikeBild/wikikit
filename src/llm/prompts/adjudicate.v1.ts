// adjudicate.v1 — classify why two claims with the same (subject, predicate)
// frame carry different objects. Optional pipeline stage (plan: cuttable);
// the deterministic exact-frame matcher finds the pair, this call only decides
// whether the difference is a real contradiction.
//
// WHY this exists at all: "lives-in Berlin" vs "lives-in Hamburg" may be a
// contradiction, a move (temporal), or two residences (complementary). The
// distinction decides whether wk_apply_proposal marks both claims disputed.
// Runs on the classify model (cheap, tiny output).
//
// NOTE: this prompt ships versioned and golden-tested but UNWIRED — there is
// no adjudicate() on LlmProvider. Every method on that interface is a
// deliberate contract change (CONTRACTS.md §3.1), and this one has not been
// made: the deterministic exact-frame matcher decides disputes today.
// Do NOT edit this text in place; create adjudicate.v2.ts and bump
// PROMPT_VERSIONS.
import type { AdjudicateInput } from '../schemas.ts'

export const version = 'adjudicate.v1'

export const system = `You are the contradiction adjudication stage of WikiKit, a knowledge system with status-tracked claims. Two claims share the same subject and predicate but state different objects. Classify the relationship.

Verdicts:
- "contradictory": both cannot be true of the same thing at the same time. Example: "okf / has_status / production-ready" vs "okf / has_status / draft" with contemporaneous sources.
- "temporal": both were true at different times — the incoming claim updates or supersedes the existing one. Example: a version number that increased.
- "complementary": both can hold simultaneously — the objects are not mutually exclusive, or describe different facets. Example: a project that "depends_on" two different libraries.

Rules:
- Judge only from the given triples and quotes; do not use outside knowledge about the subject.
- When in doubt between contradictory and temporal, prefer "contradictory" — a human reviewer resolves disputes, but a silently missed contradiction corrupts the knowledge base.
- "reason" is one or two sentences a reviewer will read in the proposal diff.`

export function render(input: AdjudicateInput): string {
  return `## Frame

Subject: ${input.subject}
Predicate: ${input.predicate}

## Existing claim

Object: ${input.existing.object}
Supporting quote: ${input.existing.quote ?? '(none recorded)'}

## Incoming claim

Object: ${input.incoming.object}
Supporting quote: ${input.incoming.quote ?? '(none recorded)'}

Classify the relationship between these two claims.`
}
