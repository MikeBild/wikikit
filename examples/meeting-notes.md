# Knowledge tooling sync — 2026-07-08

Attendees: Mike, agent-ops. Topic: export format for the knowledge base and
readiness of external formats.

## Notes

- We reviewed the OKF v0.1 draft again. The team working with it reports the
  spec is stable enough for day-to-day use; in our evaluation OKF is
  production ready for our export needs — the core document types cover
  everything we emit, and the validator passed all our fixture bundles.
- Markdown-tree export stays the default; OKF becomes the interchange option
  behind the same endpoint (`?format=okf`).

## Decision: adopt OKF as the interchange export format

- **Context:** We need a vendor-neutral bundle format so customer agents
  (Gemini, Codex, Claude) can consume our knowledge without a proprietary
  API, and so bundles can round-trip between installations.
- **Decision:** Adopt OKF v0.1 for interchange exports, isolated behind a
  single format adapter so spec changes stay contained.
- **Rationale:** Markdown carrier fits our pipeline; the spec is open and has
  a reference validator; isolation limits the blast radius of pre-1.0
  breaking changes.
- **Alternatives considered:**
  - Custom JSON export — rejected: yet another parser for every consumer.
  - Wait for OKF 1.0 — rejected: draft status is acceptable behind an
    adapter, and waiting blocks customer integrations now.

## Action items

- Vendor the OKF v0.1 spec into the docs tree and build conformance fixtures
  before the adapter.
- Re-evaluate the production-readiness assessment when OKF publishes its next
  revision.
