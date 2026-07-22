# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.9.1 - 2026-07-22

### Added

- Enforce the provider-neutral auth boundary with a repository contract test:
  runtime auth may expose only generic identity routes and protocol
  discriminators, never vendor-named branches, configuration keys or route
  aliases.

## 0.9.0 - 2026-07-22

### Added

- Add proposal-staged relation removals: `relations_removed` on
  `POST /v1/spaces/{space}/proposals` and `wikikit_propose` marks existing
  active relations for removal; the structured diff, markdown rendering and
  the human review page show the pending removals, approval deactivates the
  marked edges atomically (soft delete, audit marker kept), and rejection
  leaves them untouched. Removal-only proposals are valid.
- Add one provider-neutral MCP browser-auth list that can offer one scoped API
  key plus multiple named token-bridge and OIDC adapters concurrently;
  provider products are configuration values rather than WikiKit modes.
- Add configurable subject, email and verification claim paths for JWT bridge
  adapters without adding provider-specific branches.
- Add revocable operator sessions with an eight-hour idle limit, 24-hour
  absolute cap, live identity revalidation, explicit logout and account
  switching.
- Add the shared `mcp-auth-v1` sign-in and consent card with the WikiKit `W`
  badge and an OAuth 2.1 security scheme in OpenAPI.

### Changed

- Replace every provider-specific login route and config branch with
  `/v1/identity/login/start`, `/v1/identity/login/callback`,
  `/v1/identity/logout`, and the `protocol` discriminator. No legacy provider
  shape or route is accepted.

- Bind consent strictly to scopes requested by the client, supported by the
  server and currently permitted for the identity. `knowledge:read` remains
  mandatory and is never silently added to a request that omitted it.
- Allow reviewer credentials to inspect proposal details while keeping the
  irreversible approve/reject boundary on `knowledge:approve`.

### Removed

- Remove the former provider-specific configuration and login endpoints with
  no aliases or compatibility parser. Deployments must supply canonical
  `protocol` records before starting 0.9.0.

### Security

- Persist only opaque session/token hashes, recheck revocation and expiry at
  consent and token use, and keep credentials and identity assertions out of
  rendered pages, logs and history.

## 0.8.0

### Added

- Scope-matched hand-off instructions: the key is the policy. On a client
  without form elicitation, `wikikit_review_proposal` still returns the
  `human_review_required` hand-off with the `review_url`, but a key the
  operator deliberately granted `knowledge:approve` is now instructed that it
  may execute the user's clearly stated approve/reject instruction from the
  conversation over REST, quoting the user's words in the audit note. A
  `knowledge:review` key keeps the strict hands-off journey unchanged. Audits
  record the key name and `review_channel: "rest"`.

## 0.7.0

### Added

- Embedded human review page at `GET /review/{id}` — the one-click
  out-of-band surface for MCP clients without native form elicitation
  (ChatGPT connectors). The public shell is content-free; the proposal diff
  loads in the browser with the reviewer's own `knowledge:approve`
  credential, and approve/reject record `review_channel: "rest"`.
- The `human_review_required` hand-off from `wikikit_review_proposal` now
  carries a ready-to-share `review_url`, and the agent instructions tell the
  agent to hand exactly that link to the user.

## 0.6.0

### Added

- Structured hand-off for MCP clients without native form elicitation:
  `wikikit_review_proposal` now returns
  `outcome: "human_review_required"` with explicit agent instructions instead
  of an error. The proposal stays pending; a human reviews it out-of-band and
  the agent polls `wikikit_proposals` for the result. The hand-off is counted
  as its own content-free usage outcome (`handoff`).
- New scope `knowledge:review` gating `wikikit_proposals` and
  `wikikit_review_proposal`. `knowledge:approve` implies it, so existing keys
  keep working unchanged; the reverse never holds. The REST approve/reject
  endpoints still require `knowledge:approve`, which becomes the
  human-operator credential — agent keys minted with `knowledge:review` can
  never approve over HTTP.
- Documented per-client review journeys (native-form client, non-form client,
  human operator over REST) with the explicitly forbidden moves: collecting
  approve/reject in chat, passing the decision as tool input, and calling the
  REST review endpoints on the human's behalf.

### Changed

- Passing `decision`/`note` to `wikikit_review_proposal` is refused with a
  targeted `approval_requires_human` error before schema validation or any
  database access, replacing the generic strict-schema rejection.
- `elicitation_not_supported` is now a fail-closed backstop for mid-review
  capability loss; its guidance no longer points agents at the REST
  approve/reject endpoints.

## 0.5.0

### Added

- Native MCP form elicitation for ChangeProposal review. The agent supplies
  only the proposal id; the human chooses approve or reject and writes the
  optional review note inside the connected client.
- Durable `review_channel` provenance (`rest` or `mcp_elicitation`) on proposal
  responses, Markdown/OKF audit logs and approved/rejected webhooks.
- Configurable `WIKIKIT_MCP_ELICITATION_TIMEOUT_MS` and content-free outcome
  telemetry for accepted, declined, cancelled, timed-out and unsupported
  review attempts.

### Changed

- `wikikit_review_proposal` now accepts only `{proposal_id}`. MCP POSTs use SSE
  so `elicitation/create` and its response remain associated with the original
  tool call. Clients must reconnect/rescan the changed tool contract.

### Security

- MCP review fails closed when the client lacks form elicitation, returns an
  invalid response, declines, cancels or times out. None of those paths invokes
  the protected SQL review functions, and form contents are excluded from
  logs and usage telemetry.

## 0.4.0

### Added

- Opt-in, append-only, privacy-bounded usage telemetry for HTTP, MCP and the
  semantic knowledge/review workflows. Product-local HMAC actor/session ids
  support exact-window adoption without storing content, prompts, queries,
  tool arguments/results, network identifiers, credentials or dynamic ids.
- New aggregate resources: global `GET /v1/stats/mcp` and space-scoped
  `GET /v1/spaces/{space}/stats/http`, `/stats/usage` and `/stats/reviews`.
  They expose value state/kind, ratio evidence, exact-window uniques,
  latency/size distributions, traffic classes and quality metadata.
- Raw usage retention cleanup plus explicit organic/synthetic/internal
  traffic classification for production canaries and report collectors.

### Security

- Usage collection remains off by default and fails boot when enabled without
  an independent `WIKIKIT_USAGE_HMAC_SECRET`. Anonymous HTTP traffic is never
  fingerprinted and reporting/probe traffic is classified as internal.

## 0.3.2

### Fixed

- Proposal review details now expose every staged decision — including its
  context, decision, rationale and alternatives — consistently through HTTP
  JSON, human-readable Markdown and MCP, so reviewers see all rows an approval
  would activate.

## 0.3.1

### Fixed

- Automatic space routing scores each prompt word once at its strongest match,
  preventing a word and its stem from making one generic description term look
  like multiple independent routing signals.

## 0.3.0

### Added

- Dynamic, task-aware multi-space context selection through the
  `/v1/agent/context` HTTP endpoint and the `wikikit_context` MCP tool, with
  explicit manual space selection available for every project.
- Compact session briefings through `/v1/agent/briefing` and
  `wikikit_briefing`, plus discovery through `/v1/spaces` and
  `wikikit_spaces`.
- Per-space routing settings for stable descriptions, activation hints,
  priorities, and always-on behavior without a fixed primary/secondary
  taxonomy.
- WikiKit now ships immutable, code-versioned system knowledge for agents as
  `wikikit_guide`, `wikikit://system/agent-guide`, and `/agent-guide.md`.
  It includes dynamic multi-space routing and capability-based no-CLI setup
  for MCP clients without seeding tenant data.
- `/.well-known/llms.txt` and `/.well-known/llms-full.txt` mirror the embedded
  discovery documents for zero-configuration agent and connector discovery.

## 0.2.3

### Fixed

- The test suite strips an ambient `JOURNAL_STREAM` via a bun test preload,
  so logger tests no longer fail on systemd-launched or journal-forwarded
  environments (this broke the v0.2.2 release build). No runtime changes
  beyond 0.2.2.

## 0.2.2

### Added

- Log lines carry sd-daemon priority prefixes (`<3>` error, `<4>` warn) when
  running under systemd, so `journalctl -p err` surfaces application errors.
- Ingest jobs that hit provider quota exhaustion are parked in a new
  `quota_blocked` state with a `resume_at` parsed from the provider message
  (fallback +6h) and retried automatically, instead of failing permanently.

### Fixed

- OAuth authorize requests without PKCE parameters are rejected with
  400 `invalid_request` instead of failing with a 500 on the not-null
  constraint of `code_challenge`.
- Grounding drops ("quote not verbatim in source") are logged at info
  instead of warn — they are the validator succeeding, not a problem.

## 0.2.1

### Fixed

- Ingest status documentation now matches the existing no-review-work contract:
  `done` always carries the archived `source_id`, while `proposal_id` is null
  when classification finds no affected or new knowledge. HTTP OpenAPI, MCP
  tool help, README and LLM documentation now describe the same behavior.
- Release artifacts once again match the exact documented source revision and
  self-reported version, replacing the temporary 0.2.0 documentation hotfix.

## 0.2.0

### Added

- Space-scoped `/v1/spaces/{space}/stats/*` product analytics for ingest,
  knowledge growth/review, LLM usage and webhooks. Aggregates are read from
  WikiKit's PostgreSQL database and reuse existing `knowledge:read` keys.
- W3C Trace Context continuation and OpenTelemetry-aligned service,
  deployment, event, trace and span fields in structured runtime logs.

### Changed

- LLM call telemetry now distinguishes successful and failed provider calls;
  ingest and provider telemetry are wired into the production composition
  root instead of existing only as metric helpers.

## 0.1.15

### Changed

- Public documentation now describes the deployed remote-MCP contract
  consistently: the WikiKit-branded Firebase relay, multiple OIDC providers,
  the interactive `knowledge:approve` ceiling, and the separate proposal
  inspection/review tools.
- ChatGPT setup documents that an app scans and stores its tool and OAuth-scope
  contract. Recreate or rescan a connector after adding tools or scopes; do
  not silently elevate an existing grant.

### Fixed

- `llms.txt` now correctly identifies `wikikit_decisions` as a
  `knowledge:read` tool; only proposal inspection and final review require
  `knowledge:approve`.

## 0.1.14

### Added

- MCP proposal review is now complete: `wikikit_proposals` exposes the full
  staged diff and `wikikit_review_proposal` performs an explicit, confirmed
  approve/reject decision. Both require `knowledge:approve`.
- Remote MCP OAuth supports a dedicated WikiKit Firebase page, standard OIDC
  Authorization Code + PKCE providers, or a federated provider chooser.
  Identity-provider allow-lists and the read/propose/approve permission ceiling
  are independently configurable.

### Changed

- OAuth does not grant `knowledge:approve` by default; a client must request it
  and the selected identity provider must explicitly allow it.

## 0.1.13

### Fixed

- Allow the already validated OAuth client origin in the consent page's CSP
  `form-action`, so browser-enforced CSP permits the successful authorization
  redirect back to ChatGPT.

## 0.1.12

### Fixed

- Firebase-authenticated MCP consent now preserves the original PKCE challenge
  across the external browser login, allowing the authorization-code exchange
  to complete.

## 0.1.11

### Changed

- Remote MCP OAuth can now use the existing SubKit Firebase/Google browser
  sign-in bridge. WikiKit verifies the signed Firebase identity and an explicit
  email allow-list before showing OAuth consent, so ChatGPT never asks for a
  WikiKit operator API key.

### Security

- Firebase login states are opaque, single-use and server-stored; the shared
  Firebase page only posts ID tokens to WikiKit's fixed callback. OAuth grants
  remain scoped, refresh rotation remains intact, and an inactive Firebase
  identity immediately invalidates its MCP bearer token.

## 0.1.10

### Added

- OAuth 2.1 authorization for public remote MCP clients such as ChatGPT:
  protected-resource and authorization-server discovery, safe dynamic public
  client registration, authorization code + PKCE S256, consent, scoped bearer
  tokens, rotating refresh tokens and token revocation.
- Hourly OAuth housekeeping for expired authorization artifacts, revoked token
  retention and unused dynamically registered clients.

### Security

- OAuth tokens are HMAC-hashed at rest, bound to the canonical `/mcp`
  resource, and revalidated against the backing WikiKit API key on every
  exchange and MCP request. Refresh-token replay revokes the whole token
  family. OAuth grants cannot obtain human-only approval or admin privileges.

## 0.1.9

### Added

- Durable ingest leases with unique owners, heartbeats and bounded expiry.
  Long-running LLM work now renews its lease, while crashed workers still end
  as auditable `worker_lost` failures.
- Administrative `GET /v1/api-keys` and idempotent
  `DELETE /v1/api-keys/{id}` endpoints. Inventory responses expose usage and
  revocation metadata but never plaintext keys or hashes; space-scoped admins
  remain confined to their own space.

### Changed

- Contradiction detection is cardinality-aware. Only predicates explicitly
  listed in a space's `settings.functional_predicates` are single-valued;
  undeclared predicates are multi-valued and complementary objects stay
  verified. The migration reconciles disputes and synthetic contradiction
  relations produced by the old blanket matcher.
- Lint excludes revisions explicitly marked as structural migration references
  from empty/orphan findings. Isolated Subkit-migrated content pages receive
  deterministic relations to their domain anchor; genuine claim-free pages
  remain visible as hygiene findings.

### Fixed

- Exact concept-slug search now bypasses PostgreSQL web-search hyphen operator
  parsing and receives a stable rank boost. Existing non-null vectors remain
  untouched; legacy null vectors are backfilled.
- The ingest reaper no longer judges liveness from the original `started_at`,
  which previously killed healthy jobs after 15 minutes when concurrency was
  greater than one.

## 0.1.8

**No runtime changes** — the binary is byte-identical to v0.1.7 (verified by
building both and comparing hashes). Upgrading is optional; this release exists
so the work below is in the record.

### Changed

- The two drift suites are now one (`test/unit/drift.test.ts`). They checked
  overlapping things with slightly different scanners, and that split cost
  accuracy rather than merely duplicating effort: the stricter of the two
  env-var scanners forced `WIKIKIT_SKIP_DOTENV` — a test-harness-only
  variable — into the operator documentation, because "a drift test wants it"
  is indistinguishable from "an operator needs it" when there is more than one
  list. Each of the 12 surviving checks was verified to still fail when the
  drift it guards is introduced; the 5 tests that disappeared were duplicates,
  not coverage.
- `docs/ARCHITECTURE.md` now lists every drift gate (the prompt-file and
  provider-key guards were missing) and states that codegen drift stays
  separate in `embedded-drift.test.ts` on purpose.
- `CONTRIBUTING.md` points at the test-tier table instead of restating the
  tiers a second time, 30 lines below it — the copy did not know about e2e.

## 0.1.7

### Added

- **Coding-agent loop for Claude Code and Codex**
  ([docs/coding-agent-integration.md](docs/coding-agent-integration.md)): a
  SessionStart hook injects the space's concept index plus a grounding rule, and
  a SessionEnd/Stop hook captures what the session taught. Ready-to-use hook
  scripts in [`examples/agent-hooks/`](examples/agent-hooks) — no CLI, just curl
  and jq, and every failure path exits silently so a knowledge base being down
  can never break a session.
- **Session distillation** (`POST /v1/spaces/{space}/agent/sessions`): post a
  coding-agent transcript; the server distils **only durable rules a human
  explicitly taught or corrected** and stages them as one ChangeProposal. A
  routine session answers `no_learnings` and writes nothing — capture is a
  filter first, so the review queue stays worth reading. The transcript is
  distilled and dropped, never archived (transcripts carry secrets; sources are
  kept forever). Distilled rules flow through the normal ingest pipeline, so
  they inherit content-hash dedup (re-teaching a rule → `already_captured`, not
  a duplicate), the grounding guard, and contradiction detection against
  existing knowledge.
- **Push gate** (`bun run gate`, `bun run hooks:install`): one command runs
  every check CI runs — lint, typecheck, unit + contract, integration, e2e —
  and installs as a `pre-push` hook, so a red CI run should be a surprise. It
  fails loudly when Docker is missing rather than quietly checking less than
  you think, and prints any `SKIP=` bypass in the summary.
- **E2E tier** (`test/e2e`, `bun run test:e2e`): the real `ai` +
  `@ai-sdk/anthropic` against a stub Anthropic endpoint
  (`config.anthropicBaseUrl`), so the vendor edge is covered — request shape,
  `cache_control` placement, usage mapping, error mapping. Every other tier
  injects `FakeProvider` and is blind to all of it: losing prompt caching
  multiplies the input-token bill while nothing else fails. No key, no network,
  no cost.
- **Benchmarks** (`benchmarks/`, `bun run bench`): deterministic and
  network-free — prompt rendering, the grounding guard's O(claims × source)
  normalization, the markdown pipeline, chunking. It reports and never gates
  (wall-clock assertions are flaky and train people to bypass gates); the cost
  regression that _does_ gate is the new `test/unit/prompt-budget.test.ts`,
  which caps system-prompt tokens — a prompt is billed on every call of its
  kind, forever, and nothing else noticed it growing.
- **MCP self-description**: the server now advertises a `resources` capability
  and returns usage `instructions` on `initialize`. `resources/list` /
  `resources/read` serve `llms.txt` and `llms-full.txt` over MCP, so an
  agent that can only speak MCP can still read the documentation written for it.

### Changed

- `503 llm_not_configured` now names the key of the **selected** provider — an
  `openai` deployment is no longer told to set `ANTHROPIC_API_KEY`.
- The `LlmProvider` interface gains a fourth method, `distill()`.

### Fixed

- Documentation drift across README, CHANGELOG, `docs/CONTRACTS.md` §10,
  `.env.example` and `.env.defaults`, all of which had gone stale since v0.1.3.
  Drift tests now cover them, plus the env templates and the CHANGELOG itself —
  the docs CI checks stayed accurate, the ones it did not check did not.
- `SECURITY.md` described an Anthropic-only LLM boundary and did not mention
  that session capture sends whole transcripts to the model provider.
- Removed `test/evals/`, an empty placeholder referenced by nothing since the
  initial commit.

## 0.1.6

### Added

- **Document upload** (`POST /v1/spaces/{space}/ingest/document`): send a
  `pdf`, `docx`, `xlsx`, `md`, `txt` or `csv` file as the raw request body with
  a `?filename=` query param — the extension selects the extractor. The
  document is extracted to Markdown and enters the same pipeline as any other
  source: archived verbatim, deduped by content hash, synthesized, and staged
  as one pending ChangeProposal.

## 0.1.5

### Changed

- **Verbatim-quote grounding guard**: a synthesized claim is kept only when its
  supporting quote occurs verbatim in the source the model actually read
  (whitespace- and case-normalized). The schema always required a non-empty
  quote but never verified it — a paraphrased or invented quote is an
  unverifiable citation. Ungrounded claims are dropped and logged with a
  `dropped`/`kept` count. Benchmarked at 0 false positives across 43 real
  grounded claims.

## 0.1.4

### Added

- **Multi-provider LLM**: `WIKIKIT_LLM_PROVIDER` selects `anthropic` (default),
  `openai` or `google`, with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or
  `GOOGLE_GENERATIVE_AI_API_KEY` respectively. Switching provider is a config
  value, not a code change; an invalid value fails the boot.

### Changed

- **LLM calls run on the Vercel AI SDK 7** behind the unchanged three-method
  `LlmProvider` interface: classify/synthesize/answer are one
  `generateObject(schema)` call each, constrained to the same Zod objects the
  rest of the system validates with. Transient failures (429/5xx) are retried
  with backoff instead of failing an ingest on the first blip.
- Anthropic prompt caching now measures as intended — the byte-stable system
  prompt rides as a cache-controlled leading text part, so calls after the
  first read the cached prefix.

### Removed

- `@anthropic-ai/sdk` and `src/llm/anthropic.ts`, replaced by `ai` +
  `@ai-sdk/{anthropic,openai,google}`.

## 0.1.3

### Changed

- Documentation presents WikiKit standalone — all references to sibling
  products removed.

## 0.1.2

### Fixed

- `llms.txt` and `llms-full.txt` are embedded at compile time, so the release
  binary serves them instead of 404ing outside a source checkout.

## 0.1.1

### Fixed

- The MCP transport is mounted in `createApp`, fixing a `404` on `POST /mcp` in
  production builds.

## 0.1.0

Initial release: a headless, AI-native knowledge system for humans and agents.

### Added

- **Ingest pipeline** (`POST /v1/spaces/{space}/ingest`, async): sources
  (markdown, text or URL) are archived verbatim with sha256 dedup, classified
  against the concept index, synthesized into concept revisions with claims,
  citations and relations, checked for exact-frame contradictions, and staged
  as one pending ChangeProposal per run.
- **Review gate**: proposal content is staged as real rows, structurally
  invisible to readers; `GET /v1/proposals/{id}` renders a structured diff
  (JSON, or `text/markdown` via Accept); approve/reject are atomic SQL
  functions with stale-base protection, reviewer audit and space-epoch bump.
- **Claims model**: subject/predicate/object statements with confidence,
  verbatim-quote citations and a lifecycle
  (`proposed → verified → disputed → deprecated`); contradicting pairs are
  disputed on approval and linked with a `contradicts` relation.
- **Decisions** as first-class records (context, decision, rationale,
  alternatives), extracted from meeting-style sources.
- **LLM-free query core**: PostgreSQL full-text `search` with `<mark>`
  headlines, and `lint` (contradictions, missing citations, broken relations,
  stale claims, orphans, …) as a CI-consumable report.
- **Grounded Q&A** (`POST /v1/spaces/{space}/query`): answers only from
  retrieved evidence with inline citations, flags disputed claims, and says
  "not in the knowledge base" instead of hallucinating.
- **MCP server** (Streamable HTTP at `/mcp`): scope-gated tool visibility with
  `wikikit_spaces`, `wikikit_briefing`, `wikikit_context`, `wikikit_search`, `wikikit_read`, `wikikit_sources`, `wikikit_decisions`,
  `wikikit_history`, `wikikit_lint`, `wikikit_ingest`, `wikikit_ingest_status`,
  `wikikit_propose` — deliberately no approve tool; session leases with idle
  TTL, hard cap and hijack guards.
- **Export/import**: deterministic zip bundles as an Obsidian-friendly
  Markdown tree (claims round-trip losslessly via frontmatter) or as an OKF
  v0.1 bundle; imports pass the same review gate as LLM output.
- **Standard Webhooks**: signed events (`wikikit.proposal.created`,
  `proposal.approved`, `proposal.rejected`, `concept.updated`,
  `ingest.failed`) from a transactional outbox with backoff and a circuit
  breaker.
- **Auth**: scoped, optionally space-scoped `wk_` API keys hashed with an
  HMAC pepper; scopes `knowledge:read` / `knowledge:propose` /
  `knowledge:approve` / `admin`.
- **Ops**: OpenAPI 3.1 generated live from the route registry
  (`/openapi.json`, with a committed snapshot), `llms.txt`/`llms-full.txt`
  served, Prometheus `/metrics`, `/health` and `/ready` probes, structured
  JSON logs, graceful drain, self-migrating single Bun binary
  (`--migrate`/`--version` ops flags), zero-config local development, and
  drift tests keeping code, spec and docs in lockstep.
