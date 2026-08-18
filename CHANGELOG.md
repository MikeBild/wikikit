# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.47.1 - 2026-08-18

### Fixed

- The compact Start task table now gives its direct action column the width of
  its content, folds the wiki name into the task on phones and uses stable,
  unique, readable selectors even when several tasks belong to the same wiki.

## 0.47.0 - 2026-08-18

### Changed

- Start is now a compact operator surface with one cross-wiki search and one
  flat table of open proposals and inbox-triage tasks with direct actions.
- Search covers every visible wiki by default and can be narrowed to the
  current wiki. Grounded Q&A remains explicitly wiki-scoped.
- Browser verification creates a unique temporary wiki and always deletes it
  during teardown, including after a failed assertion.

### Added

- Global search and attention APIs that rank and collect results across the
  wikis visible to the authenticated key without client-side fan-out.
- Explicit, confirmed wiki deletion for global administrators, blocked while
  ingest work is queued or running and otherwise handled through FK cascades.

### Removed

- The test-wiki environment distinction, its list filter and its Cockpit
  settings. All visible wikis now follow one lifecycle.
- Dashboard summaries, recent-decision panels and nested cards from Start.

### Fixed

- Empty task summaries, German and English search-scope labels, responsive
  table spacing and empty `204 No Content` responses are now rendered and
  serialized correctly.

## 0.46.1 - 2026-08-18

### Fixed

- Multiple decision cards now prefix their provenance selectors with the
  visible card position, keeping every Playwright selector unique on real
  production queues.

## 0.46.0 - 2026-08-18

### Changed

- Scheduled briefings and check reports are now report history, never human
  decisions and never promotable knowledge. Only proposals and unresolved inbox
  triage appear in Decisions; only grounded answers can create a reviewed
  knowledge proposal.
- The Cockpit no longer has a second wiki selector in the sidebar. The URL is
  authoritative, the Wikis page changes it, and scoped pages show the selected
  wiki as passive context.
- Newly generated briefings and check reports follow the wiki language and
  explain what, if anything, a person needs to decide.

### Added

- Configured per-model input, output and cache-read prices, measured USD cost,
  cache-hit ratios and explicit unpriced-usage totals per wiki and across the
  installation.
- A localized Model usage view with token and cost time series, plus a global
  administrator view. Unknown prices remain visible and are never presented as
  zero cost.
- A real evidence-token budget for grounded answers. Responses now report the
  budget, used estimate and whether evidence was truncated.
- Playwright release screenshots and layout checks at 390, 768, 1280 and 1920
  pixels across every Cockpit navigation route.

### Fixed

- Wiki tables, decision lists and wide Cockpit views now share responsive
  container rules, flexible identity columns and one compact row-action menu.
  Fact explanations wrap instead of silently clipping on phones.
- German and English copy now consistently distinguishes answers, reports,
  knowledge proposals, selected wikis and model-usage measurements.

## 0.45.0 - 2026-08-18

### Changed

- The Cockpit start page now begins with a production-wiki overview. Wikis are
  a primary navigation destination instead of installation-only setup, and
  test wikis stay hidden until explicitly requested.
- Decisions now contain only work that requires a human choice: proposals,
  inbox triage and unfiled generated results. Check findings remain under
  Check, where informational observations and actionable repairs are clearly
  separated.
- Every decision shows where it came from and what it would change. The
  cross-wiki overview uses the same open-work definition, including deferred
  and discarded decisions.
- All new Cockpit labels, explanations, states, actions and error messages are
  available in both English and German. Authored wiki and source titles remain
  unchanged.

### Added

- Source pages now list the current pages and pending proposals that use the
  archived source.
- An unused-source finding explains that nothing is broken and offers an
  explicit, review-gated “propose knowledge” action that re-runs the current
  synthesis pipeline over the immutable archived content.

### Removed

- The unexplained six-step knowledge-cycle cards and their inconsistent links.
- Check findings from the decisions queue, including the legacy `care`
  attention kind and its persisted overlays.
- Obsolete cross-wiki fields for seven-day proposal activity and
  generated-only proposal counts.

## 0.44.4 - 2026-08-18

### Fixed

- Page and deleted-page selectors now use visible row positions instead of
  page slugs, because readable imported slugs can still contain opaque UUID
  suffixes.
- Generated-report provenance wraps inside the Wiki overview's waiting column
  instead of clipping at phone, tablet and laptop widths.

## 0.44.3 - 2026-08-18

### Changed

- The Cockpit start page now leads with knowledge search, concrete open work
  and published pages instead of an unexplained six-step lifecycle. Navigation
  uses the same visible names — Search and Check — as the pages it opens.
- Check is now an explicit read-only action. It explains what will happen
  before the run, groups findings by rule afterwards and links every actionable
  finding to its exact source, page, proposal or guidelines target.

### Fixed

- The decisions page now uses one consistent content width and spacing rhythm,
  has stable top-level breadcrumbs, groups repeated check findings, and keeps
  secondary queue actions behind a clearly named menu.
- Attention responses carry structured check findings and severity counts, so
  the Cockpit no longer parses English summaries or invents an age for findings
  produced by the current check.
- German Cockpit copy now consistently calls the feature “Prüfen” and its
  saved outputs “Prüfberichte”; leftover Care/Pflege labels were removed.

## 0.44.2 - 2026-08-17

### Fixed

- The production Cockpit browser check now waits for late capability-driven
  tables and their loading skeletons to settle before measuring layout. Cell
  findings include the selector and measured widths instead of an empty icon
  label, so a real overflow remains distinguishable from loading geometry.

## 0.44.1 - 2026-08-17

### Fixed

- Large production queues now give every Cockpit action a unique, readable
  selector instead of repeating one selector across as many as 200 rows.
- Connector streams, wiki environments and Inbox timestamps now collapse or
  wrap at the tablet boundary, keeping every table inside its surface in German
  as well as English.

## 0.44.0 - 2026-08-17

### Changed

- **The Cockpit now follows one six-step knowledge lifecycle.** Capture,
  triage, retrieve, care, check and remember replace the former parallel inbox
  and changes workflows. `/decisions` is the single human-attention queue;
  reviewed decisions live at `/decision-log`, and proposal review is nested
  below decisions. Removed routes have no aliases or fallbacks.
- **Every inbound item is captured before processing.** Triage suggests an
  editable target wiki, title and summary, detects exact existing sources, and
  requires a human resolution: process, reuse, leave open or discard.
- **Sources and outputs have stable summaries and source titles are required.**
  Archived evidence is visibly locked, care checks report their timestamp and
  guideline revision, and lint messages carry a localization key, arguments
  and an English default.

### Added

- A unified attention API for open, deferred, discarded and decided work,
  including overdue reminders and previous identical rejection context.

## 0.43.2 - 2026-08-16

### Fixed

- **A source or space language now governs the proposal, not only search.**
  `language: de` previously selected German stemming while classify,
  synthesis and decision extraction were still free to write English pages.
  `en` and `de` now reach every proposal-producing prompt. Synthesized pages
  and decisions pass a deterministic language-dominance check; one explicitly
  marked repair call is allowed and audited, and a second mismatch fails the
  ingest without staging invalid prose. Technical identifiers, controlled
  predicates and verbatim citations remain unchanged. `simple` stays
  language-neutral.

## 0.43.1 - 2026-08-16

### Fixed

- **A model id from the wrong provider now fails the boot, not the first
  query.** `WIKIKIT_LLM_PROVIDER=openai` with the shipped `WIKIKIT_MODEL_*`
  defaults — which are Anthropic ids — was accepted by config, reported
  `ready` with `llm_configured: true`, and then returned HTTP 500 on the first
  real query, after the request had been accepted and the caller had waited.
  Model ids do not carry across providers, and nothing checked that the
  configured model belonged to the configured provider. Each of
  `WIKIKIT_MODEL_SYNTHESIS`, `WIKIKIT_MODEL_CLASSIFY` and `WIKIKIT_MODEL_ANSWER`
  is now checked at config parse time, and a mismatch refuses the boot naming
  the setting, the model, the provider it belongs to, the selected provider and
  both repairs.

  The check is a shape heuristic (`claude-…` anthropic, `gpt-…`/`o…` openai,
  `gemini-…` google) and it is one-sided on purpose: an id matching none of
  them PASSES. WikiKit ships as a binary an operator runs for months, so a
  guard that rejected tomorrow's model name would cost more boots than the
  mismatch it prevents — this catches an obvious mismatch, it does not maintain
  a registry of valid models.

- **`WIKIKIT_MODEL_EMBEDDING` is held to `WIKIKIT_EMBEDDING_PROVIDER` the same
  way.** The exposure is identical and the failure quieter: the embedder is a
  background worker, so a Google embedding id under `openai` never surfaced as
  a failed request, only as retries in the log. Checked only while a provider
  is selected — under `none` the value is carried and sent nowhere, so it
  cannot be wrong and must not refuse a boot.

## 0.43.0 - 2026-08-16

### Fixed

- **The provider switch now actually switches.** `WIKIKIT_LLM_PROVIDER` has
  offered `anthropic | openai | google` all along, but on `openai` the service
  booted clean, reported `llm_configured: true`, and then failed every
  `POST /v1/spaces/{space}/query` with HTTP 500: OpenAI's structured outputs
  require that every key in `properties` also appear in `required`, and the
  answer schema left `cited_source_ids` out. The provider had been handing the
  AI SDK a bare zod object and letting the SDK derive the wire schema, whose
  input projection drops any key carrying a `.default()`. Anthropic tolerates
  the omission, so a declared capability failed on first real use.

  The wire schema is now WikiKit's own, built by the one walker that already
  enforced `additionalProperties: false`: it lists every property key in
  `required` and widens the genuinely optional ones to accept `null`.
  Optionality lives in the value, not in the key — the model can still decline
  a field instead of inventing one, which for `cited_source_ids` in a
  verbatim-quote knowledge base is the failure that matters most. A declined
  array parses back to `[]`, so nothing downstream ever sees `null`.

### Changed

- **Switching provider is documented as the five variables it really takes.**
  The three `WIKIKIT_MODEL_*` defaults are Anthropic model ids that OpenAI and
  Google 404 on, so setting provider and key alone yields a green `/ready` and
  a broken wiki. `docs/CONFIGURATION.md` now spells out the full switch and
  notes that `llm_configured` proves a key was supplied, not that the model
  ids suit the provider.

## 0.42.1 - 2026-08-16

### Fixed

- **An optional ranker can no longer refuse the boot.** The pgvector guard
  checked whether the extension was _available_ but not whether the role was
  allowed to create it. pgvector is not a trusted extension, so on a
  least-privilege database — the ordinary case, where the application owns its
  schema but is not a superuser — `CREATE EXTENSION` raised
  `insufficient_privilege`, the migration aborted, and the server refused to
  start. A feature the product calls optional took the whole service down.
  Both the original migration and the repair now catch that one error, log
  what an operator has to do about it, and leave retrieval lexical. The fix
  for the underlying condition is unchanged and one line: a superuser runs
  `CREATE EXTENSION vector` once, and the next boot picks it up.

## 0.42.0 - 2026-08-16

### Fixed

- **A wiki that gained pgvector after its first boot can finally have it.**
  Migration 0018 wraps every vector object in a guard, so a database whose host
  had no pgvector recorded 0018 as applied having created nothing — no
  `wk_embeddings`, no hybrid search functions. Installing the extension later
  fixed nothing, because the runner never re-executes a recorded tag: a
  matching hash is skipped and a drifted hash is backfilled in place. The
  instruction 0018 itself gave — "re-run migrations" — was advice this codebase
  cannot take, and that sentence is corrected. `0041_wk_embeddings_repair` is
  the supported path: a tag the journal has not seen, guarded exactly like
  0018, idempotent throughout, and therefore a no-op both where pgvector is
  still absent and where the objects already stand. It takes the
  source-evidence body verbatim from 0040 rather than replaying 0018's, because
  0040 dropped the four-argument signature for a seven-argument one and the
  runtime pins the wider call — a repair that replayed 0018 alone would have
  restored the narrow function and broken every `approved_then_sources` search.
  0018 and 0040 remain authoritative for a fresh install.

### Added

- **Degrading to lexical retrieval is no longer silent.** The listening line
  reports `vector_available` beside `llm_configured`, and a configured
  embedding provider on a host without pgvector now raises a warning that names
  the consequence rather than the symptom: retrieval stays lexical and no
  embeddings are produced. That combination is the one worth interrupting for,
  because the deployment looks fully equipped from its environment alone and
  says nothing while doing half the work. Availability still never gates
  startup — the server boots either way, which is the existing doctrine and not
  something an observability change gets to revisit.
- **`matched_via` is now part of the response contract.** The hybrid SQL has
  always reported which arm found a hit (`lexical`, `vector` or `both`), the
  code has always carried it and CONTRACTS has always documented it, but the
  field was missing from `zSearchResponse` and so never reached OpenAPI or a
  generated client. It is optional by design: a lexical-only deployment omits
  it rather than reporting an arm that was never chosen.

## 0.41.0 - 2026-08-15

### Added

- **An index window for evidence, with the archive left intact.**
  `WIKIKIT_SOURCE_INDEX_DAYS` (default `0` — indexed forever, so the feature is
  off until an operator asks for it) drops the retrieval chunks of aged sources
  on an hourly sweep. Machine-written reports arrive by the hundred each week
  and every one of them stays searchable forever; the obvious fix — deleting old
  sources — is the one thing this product promised never to do, and it would
  have cost two foreign-key loosenings and the provenance they carry. So the
  bytes stay: `wk_sources` is untouched, only `wk_source_chunks` goes, and
  because `persistSourceChunks` is idempotent a source can be re-indexed at any
  time. A source is spared while any claim cites it, while a pending or approved
  proposal names it, while it is the head of a sync stream, while an ingest job
  is queued or running or parked on a quota, and always if it was derived from
  an output. The one sentence this amends: everything archived is searchable —
  now for as long as it is indexed, and the operator sets that window.
- **The health surface says how much of the archive search can still reach.**
  `GET /v1/spaces/{space}/health` (and `wikikit_health`, and the scheduled health
  report) gains an `archive` block beside `ingest_queue`:
  `{sources, indexed, unindexed, index_days}`. It is reported whether or not a
  window is set, so the size of the decision is visible before it is made rather
  than after a sweep; `index_days` is null when sources stay indexed forever.
- **The archived tier can be narrowed — and only that tier.**
  `GET /v1/spaces/{space}/search`, `POST /v1/spaces/{space}/query` and
  `wikikit_search` take `evidence_from`, `evidence_to` (ISO instants with
  offset, half-open, over when a source was archived) and
  `evidence_source_kind` (`meeting|article|note`). They narrow the
  `source_evidence` hits; the approved arm is answered with the same statement
  and the same values whether they are set or not, because the two tiers share
  no clock — a page is dated by its review, a source by its arrival — and no
  kind alphabet. A filter also does not switch the tier on: narrowing an arm
  and asking for it are two different requests. Migration 0040 pushes the
  predicates into both arms of the hybrid function BEFORE their candidate cut,
  so a filtered search still returns a full page instead of one starved by
  fusion over unfiltered candidates. In the console the two controls sit beside
  the tier switch, appear only where they can act, and an empty result names
  the filter instead of blaming the search words.
  Two limits, stated rather than smoothed over: `source_kind` is present only
  where the ingesting client declared one, so filtering by it drops every
  source that never named itself — most connector-fed material among them —
  and there is deliberately no `report` value. "Machine-fed versus hand-filed"
  is a `stream_id` question and is noted as a follow-up rather than smuggled
  into this alphabet.

## 0.40.0 - 2026-08-15

### Added

- **A coding session is one document, not fourteen.** `POST
/v1/spaces/{space}/agent/sessions` accepts an optional `session_id` — the
  coding agent's own — and captures carrying it become versions of a single
  source stream keyed `agent-session:<session_id>`. Hooks fire on every
  turn-end their host offers, and each time they post the same transcript
  grown longer, so one afternoon could archive a dozen near-identical sources
  and stack a dozen competing proposals on the review queue. Now the growth
  lands as a supersedes chain on one stream, and a re-capture whose learnings
  did not change answers `already_captured` through the sync fast-path instead
  of forking. No `source_version` is sent: content-hash dedup already decides
  sameness, and a transcript-derived marker would 409 whenever the distiller
  worded the same rules differently. Captures without a `session_id` behave
  exactly as before.

### Changed

- **A superseded capture no longer leaves a competitor behind.** When a new
  stream version supersedes the previous head, proposals still pending on that
  predecessor are terminated as `failed` the moment the replacement is staged,
  with a review note naming the newer source (new SQL function
  `wk_retire_superseded_proposals`, migration 0039). They were obsolete by
  construction — the newer transcript contains everything the older one saw —
  and previously survived until a reviewer opened one and burned it on
  `stale_base`. Approved, rejected, failed and split proposals are never
  touched.

## 0.39.0 - 2026-08-14

### Added

- **Evidence, by decision instead of by luck.** `POST
/v1/spaces/{space}/ingest` accepts `evidence: true`: the source runs acquire
  → archive → chunk and the job completes done with `proposal_id` null before
  classify ever runs — zero model calls, zero review work. Until now a
  machine-written report stream paid a classify call per document and hoped
  the model proposed nothing; every false positive became a proposal a human
  had to reject. Now the caller says what the content is — evidence to cite,
  not knowledge to review — and the pipeline takes them at their word. The
  archived source is searchable in the `source_evidence` tier immediately and
  citable by chunk from a later curated proposal. Dedup, the queue ceiling and
  the connector sync contract apply unchanged; like capture it works without
  an LLM key; `evidence` refuses to combine with `capture` or `resynthesize`.

## 0.38.0 - 2026-08-14

### Added

- **An export format for markdown vaults.** `GET
/v1/spaces/{space}/export?format=obsidian` renders a serialize-only bundle
  made for note vaults: `index.md` with `[[slug]]` links, one file per concept
  and decision, relations as a readable `## Related` link list — and no
  `sources/`, no `log.md`, so a vault mirror never re-imports its own pushed
  notes. Every file opens with a `wikikit:` frontmatter marker naming its
  space, kind and slug. The bundle is a pure function of approved knowledge:
  same knowledge, same bytes. Import refuses the format — it is a projection,
  not a round-trip.
- **The export answers conditional requests.** The export handler now stamps a
  strong content-hash `ETag` and honors `If-None-Match` with `304 Not
Modified`, so a sync client polling for changes pays nothing while the
  knowledge stands still.
- **Source streams can be walked to the end.** `GET
/v1/spaces/{space}/source-streams` accepts an `after` cursor
  (`external_source_id` ascending) and returns `next_after`, so a connector
  reconciling more than one page no longer loses the tail. Without a cursor
  the list keeps its newest-first order.
- **Ingest refuses its own echo.** A document whose frontmatter carries the
  top-level `wikikit:` marker is a WikiKit export mirror; pushing it back is
  now a `422` — before the capture branch, so parked captures cannot smuggle
  one in either — and URL acquisition fails the job when the fetched body
  carries the marker. The review gate stays the only way knowledge changes;
  this guard merely stops the feedback loop before it archives.

## 0.37.1 - 2026-08-14

### Fixed

- **The Inbox speaks German everywhere.** The production verification of 0.37.0
  caught six phrases the console rendered in English under the German locale —
  the capture card's label among them. The catalog had every translation; the
  render path did not reach it, because the table's translation wrapper cannot
  see through a component boundary and the form labels stood outside any
  wrapper. All six now route through the reviewed catalog.
- **Answer rows carry each test id once.** The answers table stamped
  `answers-row-N-…` twice — once on the cell, once on the element inside it — a
  latent duplication that only became visible when the first kept report gave
  the list its first row in production. The cell keeps the id; the inner
  elements keep only the ids that name something of their own.

## 0.37.0 - 2026-08-14

### Added

- **The number that counts now lives in one place.** With nine wikis, the only
  figure that decides an operator's morning — how many changes are waiting, and
  how long the oldest has waited — was scattered across eight per-space pages.
  `GET /v1/stats/overview` and `wikikit_overview` answer it in one LLM-free
  read: per visible space the review backlog with the age of its oldest change,
  proposal activity over the last 7 days and the visible page count, with
  totals summed server-side and a one-row answer for a space-scoped key. Each
  backlog also says how much of it is **derived** — pending changes whose every
  cited source is stamped `derived_from_output_id`, the mark promotion leaves on
  an answer filed back in. That split is provenance, never a quality verdict:
  distilled human knowledge hiding behind a stack of machine reports is exactly
  what the overview exists to make visible. No verdict anywhere, and every
  absent age is `null`, never `0` — the same discipline as the health read.
- **The Wikis page carries the numbers, not just the names.** The cockpit's
  cross-wiki list gains sortable columns for the open backlog (linked straight
  to the filtered changes queue of that wiki), the age of its oldest change,
  the 7-day pulse and the page count, with a totals strip above the table and
  attention order — oldest wait first — as the default. Identity renders
  before numbers; an overview read that fails leaves dashes, never a blanked
  table.
- **The session briefing states the backlog.** `GET /v1/agent/briefing` (and
  `/v1/agent/context`, which inherits the field) now carries
  `pending_changes: { total, oldest_days, spaces }` and prints the same two
  lines the scheduled briefing already uses — "N change(s) pending review." /
  "Oldest: D day(s) old." — per briefed space, with a sum line across several.
  A space with nothing pending gets no line, and the token-budget trim removes
  pinned concepts only, never these fact lines.
- **A place to think: capture without processing.** Ingest was processing, not
  an inbox — submitting anything demanded an LLM key, a slot under the
  per-space queue ceiling, and started model work. `POST .../ingest` with
  `capture: true` (and `wikikit_ingest` with the same flag, which now works
  keyless) parks the text verbatim as a `wk_ingest_jobs` row in the new
  `captured` status instead: no LLM call, no dedup, no queue slot, `200
{status:"captured", ingest_id}`. Nothing runs until a human decides —
  `POST /v1/ingests/{id}/process` promotes the note into the ordinary pipeline
  and pays the guards capture skipped (LLM key, queue room) at that moment;
  `POST /v1/ingests/{id}/discard` ends it (`discarded`, terminal, the row stays
  for the record). Promotion is deliberately not an MCP tool: parking is
  decision-free, un-parking is a human step. A promoted row keeps its
  `created_at` and therefore jumps to the queue front; identical text parked
  twice is two captured rows — both documented decisions.
- **The inbox holds thoughts, not just documents.** The cockpit's Inbox gains a
  quick-capture card — one textarea, one button, nothing to configure — and a
  "Parked" strip listing the wiki's captured notes with title and excerpt
  (served by the job list, which still never ships the body), their age with a
  warning past 30 days, and Process/Discard behind confirmations that state
  the exact effect.
- **The numbers stay honest.** Captured and discarded rows are excluded from
  the ingest volume statistics (a parked note never entered the pipeline) and
  never count against the per-space queue ceiling — the ceiling meters work,
  and it applies the moment a capture is promoted.
- **Lint learns rhythm and three new rules.** Every rule now carries a fixed
  tier beside its fixed severity: `?tier=quick` (also on `wikikit_lint` and
  `wikikit_health`) runs only the queue/inbox/charter pulse — cheap counts an
  operator can ask for on every visit — while the default `deep` runs the full
  knowledge scan and is a strict superset, so the rhythms nest instead of
  forking. Scheduled health runs pass `deep` explicitly: the persisted report
  is the full protocol even if the default ever becomes overridable. The new
  rules: `stale-proposals` (warn) names the pending changes older than 14 days
  with `{proposal_id, title, days_open}` — the age is what turns a queue into a
  backlog, and the `unreviewed-proposals` census stays beside it;
  `stale-captures` (warn) names thoughts parked past 30 days, because capture
  deliberately bypasses every gate and needs a pressure valve — an old inbox
  item is a signal, not an error; `missing-charter` (info) fires when no
  current charter revision exists, so the absence of a steering document is a
  visible choice rather than an accident.
- **Health counts the parked thoughts.** The composed health read's ingest
  queue gains `captured` and `oldest_captured_days` (null when nothing is
  parked, days because the wait that matters is the thirty-day one) — beside
  `depth`, never inside it, exactly like `quota_blocked`: a parked thought
  waits for a decision, not for a worker. The scheduled health report renders
  the same facts.
- **Care findings become three-part rows, and the reports get a shelf.** Every
  finding on the cockpit's Care page now answers all three questions: what the
  linter said, why it counts (a per-rule explanation behind a help icon, in
  both languages), and where the fix happens — stale changes route to the
  change, parked thoughts to the Inbox, the missing charter to Guidelines. A
  change that also has a stale warning appears once, as the warning, with the
  folded census rows stated rather than hidden. The ingest-queue card shows the
  parked count with its oldest age, and a new "Kept care reports" section lists
  the persisted health reports — including the empty ones, because an empty
  report is information: it says somebody looked.
- **Every page knows its neighborhood.** New LLM-free read
  `GET /v1/spaces/{space}/concepts/{slug}/neighbors`
  (`wikikit.concept-neighbors.v1`): the reviewed relations folded to their far
  endpoint in BOTH directions — inbound is the backlink surface the concept
  read never carried, same-space only — each with the resolved page title, plus
  `same_source`: the same-space concepts whose verified/disputed claims quote
  the same archived sources, ranked by how many distinct sources the two pages
  share. The count travels because it IS the argument for the suggestion; pages
  already related and the page itself are excluded, because the list exists to
  surface what the relations do not already show. No embeddings — relations and
  shared citations first. `zConceptResponse` is untouched: agents pin that
  shape, and the neighborhood is a second, independently-loading read.
- **The cockpit's Related pages panel becomes the neighborhood.** Three groups
  — Outgoing, Incoming, and Same sources with its "n shared sources" hint — on
  a query of their own, so a slow or failing neighborhood read never blanks the
  document above it. Cross-wiki targets stay inert text (this console cannot
  address another wiki's page), and an empty neighborhood renders as a
  statement rather than a panel that silently is not there.

### Rollback

- The `0038_wk_capture` migration only widens the `wk_ingest_jobs` status
  CHECK (strict superset) and adds a partial index; it is forward-only.
  Rolling back the binary to 0.36.0 is safe with the migration in place:
  0.36.0 tolerates rows in the new statuses — its worker claims only
  `queued`, its queue cap counts only `queued`/`quota_blocked`, and its health
  read filters explicitly — but it can neither list nor promote them, so
  clear the Parked strip (process or discard) before rolling back if the
  Inbox must stay usable. Never roll back across this schema boundary and
  then further.

## 0.36.0 - 2026-08-14

### Added

- **A new wiki is armed with a daily briefing from the moment it exists.** The
  scheduler shipped in 0.35.0 with nothing switched on, so a wiki reported
  nothing until somebody remembered to give it a timetable — and the number the
  briefing exists to publish (how long the oldest undecided change has been
  waiting) is exactly the number that goes unnoticed while it accrues.
  `WIKIKIT_DEFAULT_BRIEFING` seeds it at creation: `07:00`, `07:00 <IANA zone>`,
  or `off`. UTC when no zone is given, because the server has no other zone to
  know and defaulting to the author's would be wrong for every other deployment.
  A malformed value refuses to start the binary rather than falling back to an
  hour nobody chose. Only the briefing is seeded, never the weekly health report:
  the briefing spends no model tokens, and an empty wiki has nothing to say in a
  health document. Existing wikis are untouched — this is a create-time default,
  not a migration, and the seeded row is an ordinary schedule the **Care** page
  edits in one place.

## 0.35.0 - 2026-08-14

### Added

- **A good answer can now be kept — and filed back into the wiki.** Until now a
  `/query` answer existed only in the chat window that asked for it; the sole
  trace was an audit row saying a model call happened, not what it said. Every
  answer is now an **output** (`GET /v1/spaces/{space}/outputs`,
  `GET /v1/outputs/{id}`, `wikikit_outputs`), re-readable and shareable, and
  `POST /v1/outputs/{id}/promote` / `wikikit_promote_output` archives one as a
  source and stages a change. Promotion runs the ORDINARY pipeline — content
  hash, grounding guard, contradiction detection, one proposal a human approves
  — and never writes knowledge directly. Filing answers back automatically,
  which is how the folder-based versions of this idea work, would leave the wiki
  quoting itself as evidence: every claim would still carry a verbatim quote
  from an archived document, and the document would be the wiki. The promoted
  source is marked as derived, and the new `self-derived-only` lint rule (warn)
  reports a page whose visible claims rest on nothing else — the one risk this
  loop introduces ships with the rule that finds it.
- **The inbox is a place, and it takes a whole folder at once.** The console's
  new **Inbox** drops many files, pastes many URLs one per line, and takes typed
  notes, then shows what arrived — every job with its stage and progress — next
  to the changes still waiting for a decision, because "what came in" and "what
  of it needs me" is one question. `GET /v1/spaces/{space}/ingests` is the list
  behind it; per-space job history was previously unaddressable. A bulk drop is
  N independent jobs and never one batch: each source keeps its own content
  hash, its own change and its own review, and a single change holding forty
  documents is a change nobody can decide.
- **One read now answers "how is this wiki doing".**
  `GET /v1/spaces/{space}/health` and `wikikit_health` compose the lint report,
  the coverage block and the two live queues — changes waiting for a human WITH
  the age of the oldest, and ingest work still in flight — in one LLM-free
  request. The age is the point: a count of pending changes reads the same on
  the day a backlog appears as it does a month later. The console's new **Care**
  page is that report, every line linking to the page or change it is about, and
  System's lint card now points there: System is installation diagnosis, not
  knowledge maintenance. There is deliberately no overall verdict — every
  threshold that would produce one is your policy, not WikiKit's.
- **Maintenance can run without anybody remembering to look.** An optional
  per-wiki schedule (`GET|PUT /v1/spaces/{space}/schedules`, scope `admin`, or
  the Care page) writes a daily or weekly **briefing** — what was approved, what
  is waiting and for how long, where the wiki is thin — and a **health report**,
  which also emits the new `wikikit.health.reported` webhook. Both are assembled
  from counts, titles and slugs and spend no model tokens, because a daily job
  that costs money is a daily job somebody switches off. The vocabulary is a
  closed set (daily at HH:MM, or weekly on a weekday, in an IANA timezone) and
  not a cron expression: nobody can verify `*/7 3 * * 1-5` by reading it, and
  what is actually wanted is "every morning" — the operator's morning, which is
  what the timezone is for. WikiKit still sends no e-mail; delivery is the
  output plus the webhook.
- **`WIKIKIT_OUTPUT_RETENTION_DAYS`** (default 365, `0` keeps forever) expires
  unpromoted outputs hourly; a promoted one is never collected, since its text
  already lives on as a source. **`WIKIKIT_SCHEDULER_ENABLED`** (default `true`)
  switches the worker off for a deployment that wants one binary of several
  producing reports — though it need not, since due rows are claimed with
  `FOR UPDATE SKIP LOCKED` and N instances already produce one report per
  window.

### Changed

- **The sidebar is the loop, in the order the work happens.** Inbox → Pages →
  Changes → Answers → Care; everything that is a way into one of those rather
  than a step of it — Sources, Decisions, Guidelines, Search — moved into a
  collapsed **Archive & control** block. Nine open entries is a menu; five is a
  model, and an operator who reads the sidebar downwards has read the product.
  **Changes stays visible** although folding it into the Inbox would have
  reached a tidier four: it is the one queue whose neglect does real damage, and
  a hidden backlog never says so. Home is the same loop, with the next sensible
  step on each stage.
- **The charter is called Guidelines on screen** (German: Leitlinien). "Charter"
  reads as a legal document; what it is, is house style for a wiki. The rename
  stops at the label — the route, the `wikikit_charter*` tools, the table and
  every doc anchor keep the name, because renaming an API breaks contracts for
  nothing. A wiki with no guidelines yet is now offered a six-field starter
  (purpose, what belongs in, what does not, page types, emphasis, voice) that
  seeds the ordinary editor, so the write still passes the same confirmation.
- **Ingest refuses instead of queueing without limit.** Above
  `WIKIKIT_INGEST_MAX_QUEUED_PER_SPACE` waiting jobs (default 200) enqueue
  answers `429 ingest_queue_full` with the queue depth and the limit, and
  nothing is queued. Dropping fifty files costs fifty classification calls plus
  a synthesis call per affected page and produces fifty changes to review; a
  queue that silently accepts all of it looks exactly like one that is keeping
  up, right until the backlog is unclearable. The refusal is a distinct code
  from `rate_limited` on purpose — the pacing was fine, and retrying in a loop
  learns nothing.
- **Ingest job status carries `created_at`.** A queued job had neither a start
  nor a finish time, so the state it spends most of its life in could not be
  aged — "waiting since when" was unanswerable, on the single read as well as in
  the new list.

## 0.34.1 - 2026-08-13

### Changed

- **The ingest runtime ceiling now sits well clear of real work** (90 minutes,
  was 45). It bounds a hang, whose duration is unbounded — not slow work, whose
  duration is one synthesis call per affected concept. A production job that
  legitimately ran 31 concepts in 31 minutes showed the old default sitting
  barely above real work, where a larger document would have been failed with
  `timeout` mid-progress. Overshooting is cheap now that a running job publishes
  phase and progress: a stall is visible within a heartbeat, long before any
  ceiling.

## 0.34.0 - 2026-08-13

### Fixed

- **A decision recorded once is proposed once.** Decisions used to be mined by
  synthesis, which runs one call per affected concept; every call read the same
  source and proposed the same choice under its own slug, so a single settled
  decision could enter the log five times. Decisions now come from one
  extraction call per ingest (`decisions.v1`) that sees the space's active
  decisions and marks a find as already recorded, or as an update to one. The
  proposal summary reports what it suppressed, and a decision that replaces
  another retires it on approval — giving the long-declared `superseded` status
  its first writer.
- **A slow ingest no longer looks like a stuck one.** A running job publishes
  the stage it is in (`acquire | classify | synthesize | decisions | adjudicate
| propose`) and, during synthesis, how many concepts of the total it has
  finished. `GET /v1/ingests/{id}` and `wikikit_ingest_status` return those
  alongside `started_at`, `heartbeat_at` and `finished_at`, and the Cockpit says
  which stage is running and how far along it is.

### Added

- **A wall-clock ceiling per ingest job** (`WIKIKIT_INGEST_MAX_RUNTIME_MS`,
  default 90 minutes). The lease only proved a worker was alive — one blocked
  inside an LLM call renewed it forever. The worker now aborts the request and
  fails the job with `error.code=timeout`; the reaper flips over-running rows
  the same way as a backstop, and both outcomes reach the metrics counter.
- **`resynthesize` on ingest.** Re-runs the current pipeline over content the
  archive already holds, which the `already_ingested` guard otherwise refuses —
  the operator path for "the pipeline improved, read that source again".

## 0.33.10 - 2026-08-11

### Fixed

- **German production views finish at the component boundary.** The Charter's
  revision metadata now translates its lower-case status explicitly, while the
  browser verifier leaves authored Markdown untouched instead of mistaking its
  English words for untranslated Cockpit chrome.
- **Long localized change states remain readable at tablet width.** Status cells
  and their semantic badges wrap within the table rather than clipping or
  forcing horizontal scrolling.

## 0.33.9 - 2026-08-11

### Fixed

- **Production-sized Cockpit rows keep selectors semantic and unique.** Changes,
  sources, streams, webhooks, deliveries and identity grants now use visible row
  positions instead of database identifiers. Cell contents no longer repeat the
  selector already owned by their shared table cell, and timestamps without a
  caller-defined testing role no longer share a global fallback selector.
- **Real production values fit responsive tables.** Long charter authors wrap,
  and identity scope ceilings collapse at tablet width, closing overflow cases
  that only appear with populated production data.

## 0.33.8 - 2026-08-11

### Changed

- **The Cockpit now applies one shadcn interaction system throughout.** Buttons,
  form fields, tabs, dialogs, sheets, alerts, toasts and page actions share the
  same component hierarchy, spacing and icon ownership. Icon-only actions expose
  keyboard-accessible help instead of duplicating icons or relying on inline prose.
- **Responsive tables use explicit information priority.** Essential columns stay
  visible, secondary columns collapse on phones, and optional columns also collapse
  on tablets. Headers and cells wrap within their surfaces instead of introducing
  horizontal table or document scrolling in either supported language.
- **Cockpit selectors and localisation are complete runtime contracts.** Interactive
  elements and async states use unique semantic `data-testid` values without opaque
  database identifiers. English and neutral German copy are checked statically and
  across every navigable production-browser route at phone, tablet and laptop widths.

## 0.33.7 - 2026-08-10

### Fixed

- **Mobile tables remove collapsed columns from layout, not only from paint.**
  The shared data table now derives its rendered columns from the Cockpit's
  768px media-query store, so hidden columns no longer reserve fixed-layout
  width or distort empty-state `colSpan` values. Pages declares the same
  responsive column capability as every other table.
- **The production browser check waits for a measurable UI.** It waits for
  loaded styles, the mounted shell and settled table reads without relying on
  `networkidle`, which live System requests intentionally prevent. Hidden cells
  are excluded from clipping findings.

## 0.33.6 - 2026-08-10

### Fixed

- **Cockpit tables now fit without horizontal scrolling.** At the mobile
  breakpoint, secondary columns collapse while identity, state and row actions
  remain available; the shared shadcn table uses a fixed, wrapping layout for
  the remaining columns. The browser release check now rejects horizontal
  scrolling in every visible table on every Cockpit route at phone and laptop
  widths.
- **Help follows one shadcn interaction hierarchy.** Short explanations use a
  specific hover/focus tooltip and open a longer click/touch popover; field help
  is attached directly to its label. Dense supplemental prose was removed from
  forms, source details and empty states while critical effects, permissions
  and errors remain visible.
- **The expanded responsive and help contracts are regression tested.** Stable
  `data-testid` selectors, German and English copy, keyboard access, responsive
  column policy and the zero-scroll browser probe are covered by the Cockpit
  design checks.

## 0.33.5 - 2026-08-10

### Fixed

- **Cockpit actions now follow one visual hierarchy.** The shared shadcn button
  uses the blue action token for the sole primary variant on every route;
  outline, ghost and destructive buttons keep their semantic roles, and page
  actions are no longer repeated inside empty states.
- **Contextual explanations replace dense supplemental prose.** A shared,
  keyboard-accessible help control combines a short hover/focus tooltip with a
  click/touch popover on Charter, Search, Sources, System and Wikis surfaces,
  with complete German and English copy and stable `data-testid` selectors.
- **Custom table empty states render exactly one icon.** The generic inbox icon
  is omitted when a domain-specific empty state is supplied. Regression tests
  now enforce the button hierarchy, shadcn icon spacing, reachable help,
  absence of native `title` fallbacks and non-duplicated actions.

## 0.33.4 - 2026-08-10

### Fixed

- **Opaque identifiers are removed from remaining knowledge labels.** Legacy
  generated change titles and summaries, staged-page labels, relation targets,
  deleted pages and decision labels now use semantic fallbacks whenever their
  stored presentation text contains a UUID; identifiers remain unchanged in
  routes, API requests and `data-testid` selectors.

## 0.33.3 - 2026-08-10

### Fixed

- **German localisation now reaches every Cockpit component boundary.** Shared
  buttons, badges, cards and page-specific overview panels translate their
  rendered labels, explanatory copy, counters and time windows while keeping
  titles and other user-authored content verbatim.
- **Production browser verification now audits localisation on every route.**
  The read-only Cockpit check rejects visible English UI phrases in German mode
  alongside its document-overflow, table-containment and cell-clipping checks.

## 0.33.2 - 2026-08-10

### Fixed

- **German localisation now also covers asynchronously loaded content.** Query
  results, empty states and loading shapes pass through the same translation
  boundary as the surrounding page, including the Home statistics that exposed
  the remaining English labels in production.

## 0.33.1 - 2026-08-10

### Fixed

- **The Pages index no longer needs horizontal scrolling.** Its primary and
  evidence columns fit the available width, secondary columns collapse on
  narrow screens, and the production browser check now exercises a named wiki
  and rejects any horizontally scrolling Pages table.
- **German localisation covers the complete static Cockpit surface.** Shared
  controls, dialogs, table content, labels, help text, placeholders and
  accessibility names use explicit phrase translations. An AST regression test
  rejects new static Cockpit copy without German coverage.
- **Opaque identifiers stay internal.** UUID-shaped page titles, slugs, parent
  changes, source fallbacks and webhook event identifiers no longer appear as
  end-user labels; routes and `data-testid` selectors remain unchanged.

## 0.33.0 - 2026-08-10

### Added

- **The Cockpit now has a consistent shadcn-based interaction system.** Account,
  profile, theme, language and sign-out controls live in one user menu; forms
  use shared checkbox, radio, toggle and progress primitives; and the System
  area is organised into Overview, Knowledge and Activity.
- **English and German Cockpit localisation.** The initial language follows the
  browser, can be changed manually, persists across sessions and formats dates
  and numbers with the selected locale.
- **Stable browser-test selectors.** Cockpit interactions and table structure
  carry explicit `data-testid` attributes, guarded by an AST regression test.

### Changed

- **Internal UUIDs are no longer presented as user-facing labels.** Routes,
  API calls and test selectors continue to use stable identifiers internally,
  while the interface prefers titles, names and semantic fallbacks.
- Production Cockpit verification uses language-independent `data-testid`
  selectors for the edit, review and approval loop.

## 0.32.1 - 2026-08-09

### Added

- **Pages can now be deleted without deleting knowledge.** `DELETE` and restore
  proposals are review-gated across REST, MCP and the Cockpit. Approval hides
  the page while preserving its revision and claim history, removes local
  active relations through the ordinary proposal path, and emits dedicated
  lifecycle webhooks. Restore brings back the last visible revision without
  reviving removed relations; deleted slugs remain reserved until restored.
  MCP adds `wikikit_deleted_concepts`, `wikikit_concept_delete` and
  `wikikit_concept_restore`.

## 0.32.0 - 2026-08-09

Three entries from 0.31.0's Known, and the first of them was made by 0.31.0
itself — a release that deleted a state and left the screen still able to draw
it.

### Fixed

- **The index was silent about its own silence.** A reference target's
  measurement is withheld on purpose: the marker is the deployment's statement
  that the row is not a knowledge page, and 0.28.0 stopped reporting three
  zeros for it. What it left was a hole. The field was simply gone, so a client
  had to work out WHY from the rest of the response — and WikiKit's own console
  did exactly that, reading the whole list, deciding whether the build looked
  like one that measures, and describing every bare row accordingly.

  That inference worked and was still the wrong shape, because a client
  reconstructing a reason from an absence eventually reconstructs the wrong one.
  It already did: a row whose `claims` arrived and whose `uncited_claims` did
  not looked exactly like furniture, and was confidently called a reference
  target.

  The row now says it. `not_measured: {reason}` stands where `evidence` would
  have been, on the concept list and on search hits alike, carrying
  `withheld_claims` when the page nevertheless holds visible claims — the count
  the measurement would have reported.

  Two answers were refused. **Measuring the page after all** would undo 0.28.0:
  the marker decides and the counts do not, which is what keeps the rule
  readable off a single row. And **turning the index into a defect report**
  would grow a second linter beside the first: there is no severity here, no
  advice and no verdict. `scaffolded-claims` owns the judgement that a marked
  page holding claims is a contradiction somebody should resolve, and reports
  the same count from the same aggregate. What a reader gains is smaller and
  exactly what was missing — that a real number exists and is not being shown.

  One absence learned to speak; the other had nothing to say. A page that
  stopped being readable between the ranking and the count is still simply
  missing, because there the row genuinely is not there.

- **The System card explained a provenance the server had stopped sending.**
  0.31.0 deleted the legacy fallback and its `fallback` origin; the console kept
  the warning tone, the legend entry and the "Nobody configured this" sentence
  that went with it, and its test kept pinning all three. Nothing was wrong on
  screen — the branch was unreachable from the only server this console talks
  to — but the next reader would have believed the state existed. The console's
  origin set is now a value held against the schema, so the two cannot drift
  again. The unknown-origin passthrough is untouched: an origin a NEWER server
  invents still prints itself rather than borrowing a settled one, which is a
  different job from carrying an older one.

- **A forgotten marker set was caught by a hand-written list, not by the
  compiler.** `scaffoldingKinds` was an optional trailing option, so a new call
  site could omit it and still typecheck; the guarantee was a source scan over
  four boundary modules that a fifth had to be added to by hand. A list of
  places to remember is precisely what gets forgotten. It is required now, and a
  call site that omits it fails `tsc` — which it promptly did, on a module the
  scan had never covered.

  The built-in marker had also been written twice, once in the loader and once
  in the domain, each pinned by its own test: moving it would have reddened one
  suite and shipped a build whose parser honoured one marker while its
  attribution named another. The domain owns the constant now and the loader
  reads it. Exactly one test still writes the string out in full, and says why
  in the file: a single source guarantees the two MOVE TOGETHER, never that the
  value is still right, and renaming it silently would leave every installation
  whose pages carry the old marker without reference targets.

### Known

0.31.0 carried four bullets. Three close above. The fourth stands:

- **A scaffolding-marked page that does hold claims is still not measured.**
  Unchanged and unchanged on purpose — the marker decides, the counts do not.
  What ends here is the silence around it: the index now names the withheld
  count instead of leaving a reader to find it in the lint report. An operator
  can still withhold a real measurement from their own index by declaring a
  marker that pages with claims carry; they can no longer do it without the
  index saying so.

## 0.31.0 - 2026-08-09

0.30.0 could describe the shipped fallback but not delete it: one deployment's
private import marker, still a default, because removing it would have turned
absent evidence into a measured zero on pages nobody had been told about. The
route it added is what makes the removal safe — an installation can now read the
markers it honours off the process itself, before it upgrades rather than after.
So the fallback goes. **If any of your pages rely on a scaffolding marker that
this build recognised without being told, name it in `WIKIKIT_SCAFFOLDING_KINDS`
before you upgrade** — one line in the environment, and `GET /v1/installation/knowledge-config`
on the instance you are about to replace tells you the value (anything it
attributes `fallback` is exactly what you must declare). Skip that and nothing
breaks or disappears, but those pages stop being reference targets: their
evidence turns from absent into three zeros and the linter starts filing
findings against them. The rest of this entry is the long form of that
paragraph.

Two more things come off the same **Known** list. A page that carries a
scaffolding marker and holds claims anyway has been recorded as unreported since
0.28.0 and reachable from the outside since 0.29.0; the linter now reports it.
And a promise from 0.26.0 turned out to have a shelf life: an operator can clear
an identity's stored email, and the next sign-in writes it straight back. No
code changed for that one — what changed is that three surfaces now say so.

### Removed

- **BREAKING — the shipped scaffolding-marker fallback is deleted. Set
  `WIKIKIT_SCAFFOLDING_KINDS` before you upgrade if you were relying on it.**
  WikiKit's built-in set is now exactly `structural-reference` and nothing else;
  every other marker is one the installation declared. The one-line fix is to
  set `WIKIKIT_SCAFFOLDING_KINDS` to that marker in the environment — on the old
  build, so the report below can confirm it took — and then upgrade.

  What happens if you do not: the pages carrying that marker stop being
  reference targets. Their `evidence` comes back as three zeros (`claims`,
  `uncited_claims`, `sources`) in the concept list and on `kind: "concept"`
  search hits instead of being absent, and `orphan-concepts`,
  `unsourced-concepts` and `empty-concepts` begin filing findings against them.
  Nothing is deleted, moved or hidden — the pages read exactly as they did, with
  the same body, claims and relations — but the counts change and the lint
  report grows. On the installation that motivated the fallback that is 49 pages
  across five wikis, each of which would go from "not measured" to the assertion
  that a knowledge page rests on nothing.

  `GET /v1/installation/knowledge-config` (admin) on the instance you are about
  to upgrade is how you find out whether this is you: a marker attributed
  `fallback` there is precisely the value you need to declare. That is what
  0.30.0 built the route for, and it is the reason this deletion is a documented
  upgrade step rather than a surprise.

  Two smaller consequences follow. `origin: "fallback"` is gone from the
  `wikikit.knowledge-config.v1` response — with no shipped default it is
  unreachable, and a schema that keeps an enum value nothing can produce teaches
  a client to handle a case that no longer exists — so the response, the OpenAPI
  snapshot and the generated console types now carry two origins, `built_in` and
  `configured`. And the literal itself is out of the repository: it lived in
  exactly two tracked files and both are edited here, which is what 0.29.0 and
  0.30.0 each said would happen in one commit on the day the fallback went.

### Corrections to the record

- **0.26.0 said an identity's stored email could be cleared. It can be cleared
  until that person next signs in.** The entry was about a mechanism, and the
  mechanism works: `PUT /v1/identities/{provider}/{subject}` reads `email` in
  three states — absent keeps the stored address, `null` clears it, a string
  sets it — and `null` really does write `NULL` to the column. What it does not
  do is what an operator deleting a stale address is actually trying to do,
  because nothing keeps it deleted.

  Every SSO-callback path for a row that already exists mirrors the provider's
  asserted address back unconditionally: the allowlist upsert through
  `ON CONFLICT ... SET email = excluded.email`, the already-registered path
  through `UPDATE ... SET email = $3`. Neither consults the stored value, and
  there is no branch anywhere that preserves a deliberately cleared `NULL`. So
  the clear survives exactly as long as the identity stays away.

  **The mirroring is right and is unchanged here.** The column states what the
  provider currently asserts about that identity, not what an operator once
  typed into a dialog, which is the only reading under which the address is
  worth anything for allow-list matching or for telling two grants apart. A
  clear that stuck would be a row quietly disagreeing with the identity provider
  forever, with nothing on any screen to say which of the two you were looking
  at. The defect was never the write; it was that we described a temporary
  effect as a permanent one.

  Erasure that lasts comes from the identity no longer signing in. Clear the
  address and **then** revoke the grant — a revoked row denies login, so no
  callback reaches the write, and both writes additionally carry
  `revoked_at IS NULL` in their `WHERE` so a concurrent revoke stops the rewrite
  too. The order is not stylistic: `PUT` against a revoked grant is a `409`
  naming `identity_revoked` unless you pass `restore: true`, and `restore: true`
  un-revokes the row, which reopens the very rewrite you were closing. The other
  route is to remove the person at the identity provider. Revoking alone erases
  nothing — the revoke handler stamps `revoked_at` and kills tokens and keys, and
  never touches `email`.

  This is a correction of a claim and not a new capability: no behaviour
  changed and no migration ran. The grant dialog in the console, the route
  summary that feeds `docs/openapi.json`, and `docs/CONTRACTS.md` §7.0 now each
  state the limit and both escapes, in place of a note that said the provider
  "may" write the address back.

### Added

- **`scaffolded-claims` (warn) — the linter reports a reference-target page that
  holds knowledge.** A readable page carrying a scaffolding marker that
  nevertheless states visible claims is the one row in a space about which the
  marker and the content disagree, and until now nothing anywhere said so. Such
  a page has its `evidence` withheld from the concept list and from
  `kind: "concept"` search hits, `orphan-concepts` / `unsourced-concepts` /
  `empty-concepts` all skip it, and its claims are perfectly visible on the page
  read — so the index says "not measured" about a page whose claims are real
  knowledge, and every surface an operator would check to find out why agrees
  that nothing is wrong.

  The finding names the slug, the visible-claim count (the same
  `EVIDENCE_LATERAL` aggregate the index would have rendered, so the number
  cannot disagree with the measurement being withheld) and both readings of the
  contradiction — the marker is wrong for this page, or those claims belong on
  the page it points at — because the linter cannot know which, and guessing
  would send half the operators who read it to edit the wrong thing. It does not
  name the marker: lint is served to agents through `wikikit_lint`, and 0.30.0
  declined to hand every connected model the strings that make a page exempt
  from the evidence measurement and from three fault rules.

  **Why the obvious alternative was refused.** The tempting fix is not a rule at
  all: make the marker conditional on the counts, so that a marked page holding
  claims simply stops being treated as a reference target and gets measured and
  linted like anything else. That trades a loud, rare problem for a quiet,
  common one. Today the marker decides alone, so the answer is readable off a
  single row and is the deployment's own statement about that row rather than an
  inference WikiKit drew from whatever happened to be attached to it. Make it
  conditional and a page changes category whenever a proposal lands or a claim
  is deprecated: `evidence` appears and disappears from the index, three lint
  rules start and stop reporting it, and nothing in the row explains why. The
  contradiction would stop being reported because it would stop existing —
  resolved silently, on whichever side the counts happened to fall that day.

  Pages carrying WikiKit's own `structural-reference` are reported too, not
  exempted. A claim on a page an operator's import marked is a plausible local
  convention with a probably-wrong marker; a claim on a page WikiKit created as
  furniture, whose body is the product's own sentence saying the knowledge lives
  on the pages it points at, means something the product asserts about its own
  data has stopped being true. That is the more alarming case, not the safer
  one, and a rule that trusts an invariant goes silent exactly when the
  invariant breaks.

  Warn, not error: the knowledge is fine — the claims are real and the page read
  shows them — and what is wrong is the index's account of the page. One of the
  two readings is a page an operator may legitimately be part-way through
  re-categorising, and failing CI on every installation over a state the
  operator's own declaration produces is not a call a lint rule may make on
  their behalf. Not info either: something is expected of the reader, and until
  it is done a measurement the wiki has already computed is being kept out of
  the index.

- **`WIKIKIT_OAUTH_OPERATOR_SESSION_ABSOLUTE_TTL_MS` — the absolute ceiling on a
  signed-in browser session is now an operator's to set.** 0.26.0 recorded, under
  **Known**, that a console tab left visible on an unattended machine renews its
  own idle window until the absolute cap, and closed with the advice that
  operators needing a shorter bound "should shorten the absolute cap, which is
  the control that actually means what it says". It was not a control. It was a
  constant in `src/oauth/server.ts`. It is a control now.

  **The default does not move.** Twenty-four hours, exactly as before, so no
  deployment's sessions change length on upgrade. This release is about who gets
  to choose the number, not about a better number: the choice is a risk
  judgement about a room, and a laptop in a locked office and a shared terminal
  on an open-plan floor do not want the same answer. WikiKit knows which one it
  is running in exactly never.

  **The rejected alternative stays rejected.** 0.26.0 considered inferring
  whether a human is present from input events and refused it, and nothing here
  revisits that: presence detection is brittle and invasive, and every wrong
  guess either signs a reviewer out mid-edit or blesses an empty desk. A session
  that ends on a guess ends in the middle of somebody's review. What is left
  once you decline to guess is a number, and the honest thing is to let the
  person who can see the room set it.

  **A ceiling below the idle window is refused at boot, not honoured.** The floor
  is the eight-hour idle window itself — stated against `OPERATOR_SESSION_IDLE_MS`
  rather than as a round number, so shortening the window can never leave the
  bound rejecting ceilings that are perfectly reachable. Below it the session
  expires before it could ever go idle: the idle limit becomes unreachable,
  every deadline the operator was told to expect is silently replaced by this
  one, and nothing in the running system says so. That is a configuration
  mistake, and a boot that refuses it while naming both numbers is a better
  outcome than one that accepts it and leaves somebody working out months later
  why sessions die early. Exactly equal is allowed and coherent — a fixed-length
  session that renewal cannot extend. The roof is thirty days, the default
  rotating refresh-token lifetime, because a cap settable to a year is
  decoration and a browser cookie has no business outliving the longest-lived
  credential WikiKit mints unasked.

  The ceiling is stamped into the session row at mint, so changing the variable
  governs sessions created afterwards and never lengthens one somebody is
  already holding. That is also why the renewal invariant needed no code change:
  `least(absolute_expires_at, …)` has always clamped against the column, never
  against a constant.

### Known

0.30.0 carried four bullets and 0.30.1 carried none. One of the four closes
outright, one closes in the half that was ever closable, two survive unchanged,
and the deletion above opens one of its own.

- **The fallback still names one deployment's private migration tag.** Closed.
  Deleted above, along with the `fallback` origin it produced. The built-in set
  is one marker the product writes and reads back itself; anything else is a
  declaration by the installation that made it. This is the bullet 0.29.0 opened
  and 0.30.0 said would end in a single commit, and it did.

- **A scaffolding-marked page that does hold claims is absent too.** Survives,
  narrowed to what is actually left. The behaviour is unchanged and stays
  unchanged on purpose: the marker decides, the counts do not, so such a page's
  `evidence` is still withheld from the concept list and from search hits while
  its claims stay fully readable on the page. An operator can still withhold a
  real measurement from their own index by declaring a marker that pages with
  claims carry. What closes is the silence — `scaffolded-claims` now reports
  exactly that page, with the count that is being withheld — so the remaining
  gap is one surface wide rather than total: the index still says nothing about
  such a row, and the reader has to be looking at the lint report to learn why.

- **A call site that forgets the configuration is caught by a test, not by the
  compiler.** Unchanged, and untouched by this release: `scaffolded-claims` lives
  inside `lintSpace`, which already receives the markers, so no new composition
  boundary appeared. `scaffoldingKinds` is still an optional trailing option that
  a new caller can omit and still compile, and the guarantee is still the source
  scan in `test/unit/domain-concepts.test.ts` over four boundary modules that a
  fifth must be added to by hand. Deleting the fallback makes the failure mode
  slightly less bad — a caller that forgets now falls back to the built-in
  marker, which is also what an undeclared installation legitimately uses — and
  no less likely.

- **The System card still renders an origin the server can no longer send.**
  New, and a direct consequence of the deletion above. `zKnowledgeConfigResponse`
  now has two origins; `apps/cockpit/src/pages/system.logic.ts` still knows
  three, with the warning tone, the legend entry and the "Nobody configured
  this" sentence that went with `fallback`, and `test/unit/cockpit-pages/system.test.ts`
  still pins all three. Nothing is wrong on screen — the branch is simply
  unreachable from this build's own server, which is the only server the
  embedded console ever talks to. It was left standing rather than removed in a
  release whose console change was otherwise a single paragraph of copy, and it
  costs a card that carries one dead case until it goes. The unknown-origin
  passthrough 0.30.0 added stays either way: it is what makes a NEWER server's
  origin print itself, which is a different job from carrying an older one.

- **A console branch is argued for rather than rendered.** Unchanged, and this
  release meets it from the other side. The grant dialog's rewritten note is
  static JSX under an existing guard: no derived text, nothing moved into
  `identities.logic.ts`, so there is nothing for `test/unit/cockpit-pages/` to
  pin and no test was invented for a string. That is the same limit the search
  card and the knowledge-config card recorded — the suite proves `.logic.ts` and
  has no renderer — and it will keep recurring until it can render.

## 0.30.1 - 2026-08-08

Documentation only; nothing in the binary changed.

### Fixed

- **The deployment guide implied a drain you cannot watch.** It described what
  a draining instance refuses — REST and the OAuth machine plane with
  `503 {"code":"draining"}`, `/mcp` with a JSON-RPC error frame — and told an
  operator to read the 503 series off `/metrics` during a deploy. Both are
  true and neither is observable the way the page suggested.

  Closing the listener is part of draining, so a client opening a _new_
  connection during the window is refused by the kernel and gets a transport
  error rather than a 503. The refusals reach a client that already holds a
  connection, and the window itself lasts only as long as the workers take to
  stop. Measured on an idle production instance at roughly 40 ms sampling
  against loopback, a restart produced no observable 503 at all: the process
  went from serving to not listening between two consecutive samples.

  That is the design working. What it costs is a false expectation: an
  operator who restarts a quiet installation, watches from outside, and sees
  no 503 has not found a broken drain gate — there was nothing in flight, so
  nothing was refused. The page now says so, says the refusal shapes earn
  their keep exactly when the instance is busy, and points at the journal
  (`draining` with its signal, one `mcp session evicted … "reason":"shutdown"`
  per live session) as the place a drain is actually confirmed.

## 0.30.0 - 2026-08-08

0.29.0 turned the set of revision markers that make a page a reference target
into configuration, and then wrote down, under **Known**, what that left open:
the default still names one deployment's private migration tag, "and the
documentation cannot say which". The obvious reading of that sentence is that
`docs/CONFIGURATION.md` should print the value and a guard is stopping it. That
reading is wrong, and this release does not act on it. The guard that keeps
production references out of `docs/` is right, and it was not the problem: a
marker that is a fact about one import on one database does not belong in a page
that every installation reads, guard or no guard.

The problem was the other half of the sentence. That configuration decides
whether 49 pages on a real installation are measured or not — whether their
`evidence` is served as three integers or withheld, whether the linter files
faults against them — and there was no way to find out which markers a running
installation honoured except to open `src/config.ts` for the build you hoped you
were running. Configuration that silently decides what gets measured, and cannot
be read back from the thing doing the measuring, is an operability defect no
amount of documentation closes. A document describes the product. Only the
process knows the deployment.

### Added

- **`GET /v1/installation/knowledge-config` — the installation reports its own
  knowledge-shaping configuration.** Scope `admin`, no alternative scope. It
  answers with the markers this process is actually honouring, in the order the
  reads apply them, and with `schema_version: "wikikit.knowledge-config.v1"`,
  the `version` of the build that answered, and the name of the environment
  variable that changes them.

  **Why an endpoint rather than a better page.** The answer differs per
  installation, so the only writer who can be right about it is the installation.
  This also makes the report unfalsifiable in the way that matters during an
  upgrade: it is produced from the same `deps.config` the concept list, `/search`,
  `/query` and the linter read, so it cannot describe a set of markers the reads
  do not use. A document could at best describe the default of one build; the
  route describes the process answering the request.

  **Why provenance and not just the values.** A flat list of markers answers the
  wrong question. The first thing an operator asks on seeing an unexpected marker
  is "did I put that there", and here "no" splits in two: `structural-reference`
  is WikiKit's own, written and read back by the product and not configurable
  away; anything else the operator did not write is the deployment-specific
  default WikiKit still ships, which they can and eventually should replace.
  Three origins, three different actions — `built_in`, `configured`, `fallback` —
  and a bare array of strings supports none of them.

  The group also carries `configured: true|false` for the variable itself, which
  is **not** derivable from the items and is the one fact the list structurally
  cannot hold: an installation that sets
  `WIKIKIT_SCAFFOLDING_KINDS=structural-reference` produces items that are all
  `built_in`, byte-identical to an installation that set nothing at all, and the
  two need opposite advice. That case has its own test.

  **Why admin, and why it is deliberately absent from the service descriptor.**
  Nothing in the response is a secret, and it is still not public. The service
  descriptor is unauthenticated and describes the _product_ — the same bytes on
  every deployment of a build. The moment it also describes the deployment, every
  future field added to this report becomes a public field, decided by whoever
  adds it, without anyone deciding that publishing it was the change. Keeping the
  two apart is what makes the rule below enforceable at all. What is guarded is
  the VALUES, not the path — every admin path is already public in
  `/openapi.json`, which is unauthenticated too, and none of them carries an
  answer. So a test drives `serviceDescriptorHandler` with a marker no build
  ships and asserts the anonymous response contains neither it nor any
  configuration key, pinning the descriptor's body to its four product-level
  fields; and `serviceDescriptorHandler` carries a `WHAT DOES NOT BELONG HERE`
  block so the next contributor meets the argument before the mistake.

  **The rule, because this is the endpoint shape that rots.** Configuration
  reports grow one harmless field at a time until one of them leaks. A value may
  appear in this response only if BOTH hold: it is knowledge-shaping — it changes
  which pages WikiKit measures, lints or synthesises, so an operator reading an
  unexpected count needs it to explain the count — and it is not a secret, not
  key material, not a connection string, **and not derived from one**. Derived is
  the clause that does the work: a length, a prefix, a fingerprint, a hash and a
  plain is-it-set boolean are all derived, because each narrows a search for the
  real value. `llm_configured: true` is named in the schema as refused rather
  than left to judgement — it is the most harmless-looking field imaginable and
  is exactly the one that starts the drift, and whether an LLM is configured is
  already answered where it matters, by the `503 llm_not_configured` envelope.
  Enforcement is an allowlist and not a denylist: `z.strictObject` at every
  level, a handler that names every field it emits and never spreads a config
  object, and a test that asserts the actual response keys against a literal
  list. Adding a field means editing that list, which is the point.

  **No MCP tool, on purpose.** The reader here is an operator explaining a count
  on their own installation, and the console and a curl serve them. An agent
  gains almost nothing: the contract fixes what an absent `evidence` object
  MEANS, identically on every installation, so the marker set explains why one
  row is silent but changes how no response is read. Against that sits handing
  every connected model the literal strings that make a page exempt from
  evidence and from three lint rules — one short step from "write the page with
  that kind and the linter stops complaining" — plus a second constituency
  arguing for another field the day the rule above says no. The argument is
  recorded at the handler so a future release re-opens it deliberately or not at
  all.

  The marker literal appears nowhere in the new code, the new tests, or the
  documentation: the handler reports whatever `deps.config` holds, and the tests
  assert attribution, counts and identity against `loadConfig()`. It still lives
  in exactly the two tracked places 0.29.0 left it in, and both still go in one
  commit the day the fallback does.

- **The console shows the same answer, on the System page.** A card, "What this
  installation counts as a reference target", listing each marker with a badge
  whose _word_ carries the provenance ("Comes with WikiKit", "Set on this
  installation", "Shipped default") and whose tone only agrees with it — the
  shipped default is the one of the three where the value deciding what gets
  measured was chosen by neither the operator nor the product, and it is the one
  drawn as a warning. Each origin present is explained once below the rows, not
  once per row, and the group-level `configured` flag is rendered as its own
  sentence using the variable name **the server sent**, because that is the fact
  the rows cannot carry. An origin invented by a newer server prints itself
  rather than passing as one of the three. The card is admin-only data on a page
  a `knowledge:read` reader can open, so it follows this page's existing rule and
  renders the server's own 403 instead of vanishing: a reader should be able to
  see that the answer exists and is not theirs, which is a different fact from
  "no data".

### Changed

- **`docs/CONFIGURATION.md` stops sending the operator to the source.** The
  section on `WIKIKIT_SCAFFOLDING_KINDS` ended with "the literal is in
  `src/config.ts`". It now says plainly that this page will not print that value
  and does not need to, gives the `curl`, and names what comes back and what each
  provenance means. The equivalent pointer is in `docs/CONTRACTS.md` §5.3 and in
  `llms.txt`/`llms-full.txt` beside the paragraphs that explain why `evidence`
  can be absent — the exact place a reader forms the question the route answers.

- **`Config` gained `scaffoldingKindsDeclared`.** The merged marker list cannot
  answer "did the operator write this": the parse is the only place that ever
  knows, and it discarded that. `parseIdentityScopes` already carried the same
  `declared` notion for the same reason, so this is the existing shape rather
  than a new one. Two alternatives were rejected: reading `process.env` in the
  handler (a handler that reports configuration should report the configuration
  the process loaded, not go behind it and risk disagreeing), and comparing the
  effective list against the private fallback constant (which misattributes an
  operator who deliberately configures the same value the product ships).

### Known

0.29.0 carried four bullets. One is closed in half and is rewritten to what
survives; the other three stand, and one of them predicted this release.

- **The fallback still names one deployment's private migration tag.** The
  documentation half of this bullet is closed: an operator no longer has to open
  `src/config.ts` to learn what their installation honours, because the
  installation says so. The fallback itself is not closed and did not move. It is
  still in `src/config.ts`, still for the continuity reason 0.29.0 gave — 49 pages
  across five wikis report absent evidence only because that marker is
  recognised, and shipping an empty default would turn those absences into a
  measured zero, which is the sentence "this page rests on nothing" said about
  pages that hold nothing by design. What the new route changes is that the
  fallback is now visible as a fallback: an operator whose report attributes a
  marker to `fallback` is being told, in the response itself, that this value was
  chosen by neither them nor the product and is theirs to replace. That is the path to
  deleting it, not the deletion. It ends when every installation declares its own
  markers, and on that day the two occurrences of the literal go together.

- **A scaffolding-marked page that does hold claims is absent too.** Unchanged
  and carried forward verbatim in substance: the marker decides, not the counts,
  so such a row reports no evidence summary even though its claims are real and
  the page read still shows them. Nothing here narrows it — this release reports
  the markers, it does not change what they do. No such page exists on the
  installation measured here.

- **A call site that forgets the configuration is caught by a test, not by the
  compiler.** Unchanged, and this release is the case it named. 0.29.0 wrote that
  the realistic failure is "next release's handler", and next release's handler
  is exactly what landed: `knowledgeConfigHandler` had to reach for
  `deps.config.scaffoldingKinds` by hand, and nothing in the type system would
  have objected if it had not. It is pinned by its own tests, which boot
  `loadConfig()` and assert the report equals what the reads would use — but that
  is one more hand-written guarantee, not a structural one, and the source scan in
  `test/unit/domain-concepts.test.ts` still covers a list of four modules that a
  fifth composition boundary must be added to by hand. A route that REPORTS the
  configuration has a failure the read modules do not: it can disagree with the
  behaviour it describes, which is worse than being merely wrong.

- **A console branch is argued for rather than rendered.** Unchanged in kind, and
  now true of one more card. `test/unit/cockpit-pages/` proves `.logic.ts` and has
  no renderer, so the new card's logic — which word and which tone each origin
  gets, which legend entries appear, what the declaration sentence says — is
  pinned by tests, while the JSX that maps a row's standing onto a `Badge` is
  pinned by a source-text assertion and by the identical pattern elsewhere on the
  page. Same limit as the search card 0.29.0 recorded, same reason, and it will
  keep recurring until that suite can render.

## 0.29.0 - 2026-08-08

0.28.0 left two defects standing under **Known**, and this release closes both.
One was on the screen: the console's SEARCH results gave the wrong reason a page
has no evidence number, and gave it in text only a screen reader would ever
reach. The other was in the product: the list of revision markers that make a
page a reference target was one deployment's private migration tag, hardcoded in
a repository that ships to installations which never ran that import.

Nothing about how evidence is measured changed, and no page's counts move.
What changed is who gets to say which pages the measurement does not apply to,
and what the console says about a page when it does not.

### Fixed

- **The console's search screen no longer gives the wrong reason for the em
  dash.** A `kind: 'concept'` hit on a reference target drew the dash correctly
  (0.28.0), but the sentence behind it read _"This list came back without
  evidence counts, so how well this page is backed is not known here."_ That is
  the sentence for a tab that outlived a rolling upgrade and is talking to a
  build which predates the counts — and it was false in the situation that
  actually put it on screen: a search whose other hits carry counts came from a
  server that measures, so a bare hit beside them is one the server **declined**
  to measure, which is a fact about that page and not about the response. It
  also said "list" on a screen that is not one.

  It was hidden text — `sr-only`, no tooltip — so the reader most likely ever to
  meet that sentence was the one using a screen reader, which is the wrong way
  round for a defect to land. The operator with a pointer, looking at a column
  of blanks and wondering why, had nowhere to ask at all.

  **What tells the two reasons apart is the rest of the response**, and it needs
  no new API field, because the response already settles it. If some concept hit
  in it carries counts, this build measures, and a bare concept hit beside it is
  a reference target. If not one concept hit carries them, it is the old build,
  and no hit in that response may be called a reference target — a console must
  not describe a page as furniture on the strength of a response that never
  measured anything. Three properties of that rule are deliberate:

  - It runs the **same predicate as the pages index** (`listMeasuresEvidence`,
    `page.logic.ts`), so the two screens cannot disagree about what proves a
    build measures — including that a self-contradicting row vouches for
    nothing.
  - **Only concept hits vouch.** Claim hits and source-evidence hits carry no
    `evidence` by design, so counting them could only drag the answer toward
    "old build": a search filtered to `kind=claim` would otherwise look like a
    rolling upgrade to every reader on it.
  - **The case it cannot separate falls to the weaker sentence.** In a response
    whose every concept hit is a reference target nothing measures, so all of
    them keep the vaguer reading — still true of such a response, merely less
    specific, where the reference-target sentence asserted about an old build
    would be false about every page on the screen. Same direction the pages
    index chose.

  The dash itself is now reachable by pointer and keyboard as a tooltip trigger,
  the way the pages list's Evidence cell already was: a sentence that is not
  otherwise on screen may not be carried by a `title` attribute (invisible on
  touch, unreachable by keyboard). The `sr-only` sentence stays **as well as**
  the tooltip — a tooltip nobody opens says nothing, and a linear screen-reader
  pass would otherwise hit an `aria-hidden` glyph and hear a line that reads
  "Evidence:" and stops.

  And the fallback sentence no longer says "list" either, on any surface. The
  discriminator above moves most reference-target hits off that sentence, but it
  stays reachable on the search screen — a response whose every concept hit is a
  reference target, or a genuinely old build — and there it was still telling
  the reader about a list they are not looking at. It now reads _"The evidence
  counts did not arrive with this result…"_, which is true of a table row and of
  a search card, and `pageEvidence` answers for both.

### Changed

- **Which revision kinds mark a reference target is now the installation's to
  declare (`WIKIKIT_SCAFFOLDING_KINDS`).** Carried under **Known** since 0.26.1
  and growing a caller per release, the list was a hardcoded pair naming a
  revision kind that exists because one particular installation ran one
  particular import. This repository states the argument against that itself, in
  `scripts/deploy/smoke.sh`: the deploy URL comes from the environment and never
  from a committed file, because WikiKit knows nothing about where it runs, and
  a hostname committed here would be both wrong for every other installation and
  a fact about somebody's infrastructure sitting in a public repo. A revision
  marker from somebody's import history is the same kind of fact, and by 0.28.0
  it was load-bearing in a way a hostname in a smoke test never is: it decided a
  response field. An installation that never ran that import got neither the
  index's silence nor the linter's.

  So the set now comes from the environment, comma-separated in the same shape
  as `WIKIKIT_OAUTH_ALLOWED_SCOPES`. WikiKit's own `structural-reference` is
  prepended unconditionally — the product writes that revision and reads it
  back, so it is not a deployment fact and cannot be configured away — and what
  an operator sets **replaces** the rest rather than adding to it. Replacement is
  the point: a value that could only be appended to would make the historical
  marker permanent and unremovable by configuration, which is the exact property
  that made it a defect.

  **And the default still carries that tag.** This is worth saying plainly
  rather than burying: 49 pages across five wikis report their evidence as
  absent only because that marker is recognised, and an upgrade shipping an
  empty deployment-specific default would silently turn those 49 absences back
  into `{claims: 0, uncited_claims: 0, sources: 0}` — the sentence "this page
  rests on nothing", said about pages that hold nothing by design, which is
  precisely the defect 0.28.0 shipped to fix. A default that breaks a running
  deployment is not a win for cleanliness. The honest long-term state is that
  every installation declares its own markers and the fallback becomes dead
  weight that can be deleted without asking anybody; that state has **not**
  arrived, and this release only makes it reachable.

  That default is pinned end to end by one integration test, and it is the only
  test in the tree that can fail when this particular thing breaks. Every other
  assertion about this variable is about SHAPE — how many markers the default
  holds, which one is WikiKit's, whether configuration replaces or accumulates —
  and a changed VALUE leaves all of them intact: retyping the literal in
  `src/config.ts` kept the entire suite green while breaking all 49 pages. So
  the test boots `loadConfig()` with the variable deleted, seeds a page carrying
  the marker, and asserts the real SQL reports it as absent and the linter files
  no fault against it. It has to write the marker out a second time to do that,
  which is the one place in the tree besides `src/config.ts` that names it — a
  guarantee about a value needs a second copy of the value. Both are deleted in
  one commit the day the fallback goes.

  The literal moved rather than being copied: it is now in `src/config.ts` and
  no longer in `src/domain/concepts.ts`, where `SCAFFOLDING_KINDS` became
  `notScaffolding(kinds)`. Configuration reaches the read model as an optional
  trailing options bag filled in at the composition boundaries that already hold
  `deps.config` — the concept list, `/search`, `/lint`, `/query`, and the
  `wikikit_search` and `wikikit_lint` tools. Two costs came with it. `/query`
  retrieves through search, so `answerQuestion` grew a deps field it only
  forwards; leaving it out would have let `/query` and `/search` disagree about
  which pages are reference targets on one installation, which is worse than an
  extra hop. And the three page-level lint rules each take one more parameter,
  real churn in a file whose diff would otherwise have been four lines.

  One hardening: the kinds are interpolated into a SQL literal (a small closed
  set the planner benefits from seeing literally) and now arrive from an
  operator's environment rather than a frozen constant, so the builder doubles
  single quotes and `loadConfig` refuses a malformed marker at boot with the
  operator's own value in the message. An empty marker set evaluates to `true`
  rather than emitting `NOT IN ()`.

### Known

0.28.0 carried four bullets here. The two defects are closed above. The second —
that 0.27.0's remaining silence was answered by the index declining to speak
rather than by a new lint rule — was a record of a closure, not an open
question, and it stays closed: nothing was added to the linter here either. The
third survives verbatim and is carried forward, wider than it was.

- **A scaffolding-marked page that does hold claims is absent too.** Unchanged
  from 0.28.0: the marker decides, not the counts, so such a row reports no
  evidence summary even though its claims are real and the page read still shows
  them. This release makes it slightly broader rather than narrower — the set of
  markers is now an operator's to write, so an operator can now withhold a real
  measurement from their own index by declaring a marker that pages with claims
  carry. That follows from wanting a rule readable off a single row, and from
  the marker being the deployment's statement about the row. No such page exists
  on the installation measured here.

- **The default still names one deployment's private migration tag, and the
  documentation cannot say which.** The defect closed above is closed as an
  architecture matter: the list is configuration, and an installation that
  declares its own markers never sees the fallback. What is left is the fallback
  itself, in `src/config.ts` for the continuity reason stated above. It also
  makes `docs/CONFIGURATION.md` slightly worse than the page wanted to be: the
  guard that keeps production references out of `docs/` also keeps that value
  out, so an operator reads "a single legacy import marker" and must open
  `src/config.ts` to learn what it is. Both of these end the day the fallback is
  deleted.

- **A call site that forgets the configuration is caught by a test, not by the
  compiler.** `scaffoldingKinds` is an optional trailing option, so a new caller
  of the concept list, the linter or search that omits
  `deps.config.scaffoldingKinds` still compiles and still runs — and would
  quietly answer with the built-in marker only, which on the installation above
  reverts those 49 pages to a measured zero. Making the parameter required does
  not actually close that: `{}` satisfies a required options bag exactly as well
  as omitting an optional one, so the compiler would only be enforcing that
  somebody typed two characters, and it cannot reach `search` or
  `answerQuestion` at all, whose deps bags are legitimately optional for `llm`
  and `vector`. The rule is enforced instead by a source scan over the four
  modules that hold the configuration (`test/unit/domain-concepts.test.ts`),
  which fails on a call in any of them that neither names `scaffoldingKinds` nor
  hands over a bag that carries it. That catches the realistic failure — next
  release's handler — but it is a list of four files, and a fifth composition
  boundary must be added to it by hand.

- **One branch of the search card is argued for rather than tested.** The logic
  that decides which of the two sentences a hit gets is pinned by tests, and
  every mutation of it turns one red. The JSX that chooses between the dash and
  the counts is not: `test/unit/cockpit-pages/` proves `.logic.ts` and has no
  renderer, so swapping the shared `rendersAsDash` predicate there for a
  narrower equality test passes the suite. It rests on the comment at that
  branch and on the identical pattern in the pages list, which is thinner than
  the rest of this fix.

## 0.28.0 - 2026-08-08

The entry for 0.27.0 makes three statements about a kind of page in this
product and all three are false. That entry is released and is not rewritten —
a changelog that quietly edits its own history is worth less than one that
carries its corrections in the open — so the correction comes first here,
ahead of the fix, because a reader who believed those sentences has been
misled about what is in their wiki and deserves to hit that before anything
else.

### Corrections to the record

- **0.27.0 described these pages wrongly, and claimed a closure it did not
  make.** It called them "blank", said they carry "no relations at all", and
  said the release closed the index/linter disagreement 0.26.1 recorded under
  **Known**. None of the three is true.

  The pages carry roughly **240 characters of prose** and between **one and
  seventeen ACTIVE relations** each. They are therefore blank in none of the
  three senses `stub-concepts` tests, which is why that rule does not report
  them — not because it excludes them, but because it looks for an empty page
  and these are not empty. And the disagreement was still open when 0.27.0
  shipped, for exactly the reason 0.26.1 wrote it down: the index reported
  zeros about these pages and the linter said nothing about them. **This
  release is what closes it**, by fixing the surface that was wrong.

  How the three got written: we described these pages from a throwaway probe
  we wrote ourselves, which asked the API for fields by names the API does not
  serve, and we read the undefineds it came back with as zeros. The probe was
  not wrong about anything — it was never told to look at the right fields. We
  did not open one of these pages and see it was blank, and we did not check
  the numbers against the page before writing an entry around them, which is
  the part that turned a bad measurement into a false record. Every number in
  this entry was read off a real installation against the fields the API
  actually serves, and against the page itself.

- **What these pages actually are.** Each is a heading and one short
  paragraph, and the paragraph is about the page itself: it says the page
  preserves the target of reviewed relations created during an allowlisted
  import migration, and that the detailed, source-grounded knowledge remains
  on the related concept pages and in their archived sources. That is the
  entire body. It is a page that says on its own face that it is not where the
  knowledge is — a landing place built so that relations somebody reviewed had
  somewhere to point, carrying no claims and no citations because it was never
  meant to carry any.

  There are **49 of them across five wikis** — 25 of 67 pages in one, 11 of 20
  in another.

### Fixed

- **The page index no longer reports three zeros for a page it cannot
  measure.** `GET /v1/spaces/{space}/concepts` served
  `evidence: {claims: 0, uncited_claims: 0, sources: 0}` for one of those
  reference-target pages. Those are the same three numbers the index shows for
  a knowledge page that genuinely rests on nothing — which is the row an
  operator is supposed to act on. In the wiki where 11 of 20 pages are targets,
  **more than half the index carried a zero that meant nothing**, and an
  operator reading it followed the wall of zeros to the linter to find out what
  to do and was told nothing was wrong.

  **The linter was right the whole time.** It excludes these pages from
  `orphan-concepts`, `unsourced-concepts` and `empty-concepts` because they are
  self-describing link targets, and telling somebody to "ingest a source and
  let synthesis quote it" for a page whose own text says the knowledge is
  elsewhere is the wrong instruction. `stub-concepts` (0.27.0) is right too and
  stays exactly as it is: it reports a readable page that is empty in all three
  senses at once, every condition it tests is observably true of the page
  rather than a fact about where the page came from, and it means the same
  thing on every installation. That it finds nothing here is not a defect in
  the rule — it is that this installation has no empty orphaned pages for it to
  find.

  The index was the surface that misled, by reporting a measurement for pages
  the measurement does not apply to. So `evidence` is now **absent** on such a
  row rather than zeroed, on the concept list and on `kind: 'concept'` search
  hits alike. This is not a new principle: `SearchHit.evidence` has been
  optional since it existed, because a page that stopped being readable between
  the ranking and the count must come back absent rather than as a page that
  cites nothing. The same rule now covers a second reason for absence, through
  one filter on one aggregate, so an index row and a search hit can never
  disagree about which pages they decline to measure. **Absent and zero are
  different answers**, and a wiki that reports one as the other does not know
  what it holds.

  Everything else is untouched. Every other page keeps its object; `claims: 0`
  still means "this page cites nothing" and is still the finding this summary
  exists to surface; the arithmetic behind the numbers did not change. The page
  itself is not hidden — it is listed, it is readable, and its body and
  relations are served as before. Only the measurement is withheld, and only
  because there is none to give.

  Absence follows the **current revision's** marker, so a page stops being a
  reference target the moment a revision that does not claim to be furniture
  becomes current, and is measured again from that read on.

  Clients: `evidence` is now optional in `zConceptListResponse` items and in
  `docs/openapi.json`. A client that renders it must render absence as "not
  measured" — the console prints an em dash and refuses to sort it as though it
  were zero — and must **not** collapse absent into zero, which would restore
  the exact defect this release fixes.

- **The Evidence column on the console's PAGES list now says WHY a page has no
  number** — that list only; the search screen is under **Known** below. It
  already printed an em dash for an absent measurement and already refused to
  sort that dash as though it were zero (0.25.0, CUI-SEV-2), but a bare dash
  with no explanation is only marginally better than a wrong zero: the operator
  who wants to know why half a wiki's rows are blank still has to leave the
  list to find out, and the linter — correctly — will tell them nothing is
  wrong. The dash is now a tooltip trigger, reachable by pointer and by
  keyboard on the same rule every other explanation in this console follows,
  and behind it is the sentence that is actually true of the page: it is a
  reference target for relations, not a knowledge page, so evidence is not
  measured for it.

  The two reasons a row can arrive with no counts are told apart rather than
  merged. A response that measured any page came from a build that measures, so
  a bare row in it is one the server declined to measure; a response where no
  row carries counts is an old build talking to a tab that outlived a rolling
  upgrade, and every row in it keeps the older, weaker sentence — a console
  must not describe a page as a reference target on the strength of a response
  that never measured anything.

### Changed

- **`SCAFFOLDING_KINDS` moved from `src/domain/lint.ts` to
  `src/domain/concepts.ts`**, beside the evidence aggregate it now sits next
  to, and the linter imports it from there. Two callers act on one fact — lint
  suppresses fault reports about those pages, the index declines to measure
  them — and both rest on the same thing being true of the row: it is furniture
  rather than knowledge. It moved rather than being copied because the read
  model cannot import from the linter without a cycle, and a second copy of
  that list would be a second answer to which rows are furniture. Every
  existing use in the linter is unchanged.

### Known

- **The scaffolding list still hardcodes one deployment's private migration
  tag.** Carried forward from 0.26.1 and 0.27.0, one file further along and
  **more load-bearing than when it was written down**: `SCAFFOLDING_KINDS`
  names a revision kind that exists because one particular installation ran one
  particular import, in a product that otherwise knows nothing about where it
  runs. 0.27.0 could say the new rule deliberately did not consult it, which
  shrank the blast radius. This release cannot say that. The marker now has two
  callers instead of one, and the second is a response field: the index's
  silence about these pages is as installation-specific as the linter's, and
  an installation that never ran that import gets neither behaviour. What would
  remove it is a marker the product itself defines for "this row is a link
  target, not a page", which is a contract decision this release does not take.

- **0.27.0's second Known item is answered, and not by a rule.** That entry
  left open the page that is marked as scaffolding, has body text, and has no
  citation behind anything it says — reported by none of the four lint rules
  while "the index counts it; the linter does not". That page is precisely the
  one this release is about, and the second half of the complaint is no longer
  true: the index does not count it, because it no longer asks the question of
  it. The two surfaces now agree by both declining to speak about the same
  page, which is the correct agreement — the linter was never wrong to be
  silent. It is worth being explicit that nothing was added to the linter to
  achieve this and nothing should be. 0.26.1 listed three candidate closures
  and 0.27.0 took the second; this takes the third, which was open all along:
  have the index stop presenting their zero as if it were a knowledge page's
  zero, the way a search hit omits evidence rather than reporting it as zero.

- **A scaffolding-marked page that does hold claims is absent too.** The marker
  decides, not the counts: such a row reports no evidence summary even though
  its claims are real and its own page read still shows them. This follows from
  the marker being the deployment's statement about the row, and from wanting a
  rule readable off a single row, but it does mean a real measurement can be
  withheld until somebody approves a revision that is not marked as
  scaffolding. No such page exists on the installation measured here.

- **The console's SEARCH screen still gives the wrong reason for the dash.**
  The bullet above is about the pages list, and only the pages list. A
  `kind: 'concept'` search hit on a reference target now correctly draws the em
  dash instead of "no claims" — that much improved — but the sentence behind it
  reads "This list came back without evidence counts", which is false of a
  search response in which other hits carry counts. The reason is that the
  search card decides per hit and never sees the whole response, so it cannot
  run the discriminator the list runs and deliberately says the weaker thing
  rather than guess. The weaker thing is still wrong here, which the list's
  version never is. It is hidden text (`sr-only` and no tooltip), so the reader
  most likely to meet it is the one using a screen reader — which is the wrong
  way round for a defect to land. Fixing it means threading the response-level
  fact into the search card the way `IndexRow.measured` threads it into the
  list, and this release does not do it.

## 0.27.0 - 2026-08-08

This release closes the disagreement 0.26.1 left open under **Known**: the page
index reported roughly fifty pages with no evidence behind them across sixteen
wikis while the linter reported thirteen, and in one of those wikis the index
showed twenty-four pages at `sources: 0` against a linter that said nothing was
wrong. An operator who follows the index to the linter to find out what to do
has been arriving at a clean report. That is the part that is settled here.

### Added

- **The linter now names the pages that are blank.** The pages the two surfaces
  disagreed about are not invisible furniture. They carry a title, they appear
  in the index, a reader can open them, and what that reader finds is nothing:
  no body text, no claims, and — because the relations they were created to
  receive have since gone — no links either. They were made as landing targets
  for relations imported from elsewhere, and 0.26.1 was right that "never a page
  anybody wrote to be read" describes where they came from rather than what they
  are. Origin is not a state. A page that was furniture and is now an empty page
  in a reader's index is an empty page in a reader's index.

  `stub-concepts` reports every readable page that is empty in all three senses
  at once — no text, no visible claims, no active relation in either direction —
  and the finding says what to do: delete it, or give it content.

  It is a **new rule** rather than the removal of the scaffolding exclusion from
  `unsourced-concepts`, and that is the substantive choice in this release.
  Dropping the exclusion would have swept these pages into a rule whose entire
  finding is "nothing archived stands behind this page" and whose named fix is
  to ingest a source and let synthesis quote it. That is the correct advice for
  a page that says things nothing backs. It is the wrong advice for a page that
  says nothing at all: it sends an operator off to find documents about a title
  somebody left behind, so that a wiki can grow prose it never wanted. A rule
  that names an action the operator should not take is worse than a rule that
  says nothing, because the silent rule at least costs only the search — and the
  three candidates 0.26.1 listed were weighed on exactly that.

  Every condition the rule tests is **observably true of the page**: the body is
  empty, no visible claim hangs off it, no active relation touches it in either
  direction. None of them asks how the page came to exist. Keying off the
  scaffolding marker instead — even inverted, to select those pages rather than
  exclude them — would have made the rule a report about one deployment's
  private migration tag, hardcoded in this repository, rather than a report
  about the knowledge base. It would find nothing at all on an installation that
  never ran that import, while the same blank pages arise anywhere a relation
  target is created and the relation later goes away. The rule therefore means
  the same thing on every installation, which is the property the existing
  exclusion does not have.

  Two consequences worth stating plainly. First, this rule alone neither
  excludes nor requires scaffolding revisions, unlike every other page-level
  rule; a scaffolding page nothing points through any more is just a blank page,
  and the exclusion elsewhere stays correct because those rules describe faults
  (unreachable, unsourced) a structural target is not guilty of. Second, a blank
  page that is not scaffolding trips this rule and `empty-concepts` both,
  deliberately and on the same argument 0.26.0 made for the
  `empty-concepts`/`unsourced-concepts` overlap: `counts` is a census of
  findings, never a headcount of pages. On the scaffolding pages that motivated
  this release it is the only rule that fires at all — the other three still
  skip them — so the overlap is a property of blank pages generally, not of the
  ones being fixed here.

  **This makes the linter louder on any installation carrying such pages**, and
  that is the price of the fix rather than a side effect of it. It is a warning,
  not an error, so no CI turns red on upgrade — but the wiki that showed
  twenty-four zeros in its index and a clean lint will now show warnings, and
  the other fifteen will show whatever they are actually holding. How many of
  the roughly fifty index rows the new rule reaches was not re-measured for this
  release; only the pages that are blank in all three senses are, and a page
  with prose but no evidence is a different finding.

### Known

- **The exclusion list still hardcodes one deployment's private migration tag.**
  Carried forward from 0.26.1 unchanged: `SCAFFOLDING_KINDS` in
  `src/domain/lint.ts` names a revision kind that exists because one particular
  installation ran one particular import, living in a product that otherwise
  knows nothing about where it runs. The new rule deliberately does not consult
  it, which shrinks the blast radius but does not remove the fact.

- **The remaining silence is narrower, and it is a different page.** A page
  marked as scaffolding that does have body text, but no citation behind
  anything it says, is still reported by neither `unsourced-concepts` nor
  `empty-concepts` — both still exclude scaffolding — and not by `stub-concepts`
  either, which requires an empty body. The index counts it; the linter does
  not. This is what is left of the disagreement above, and it is left open for
  the same reason the whole of it was: closing it means deciding whether the
  scaffolding exclusion should exist at all, which changes what every operator's
  linter says about their own wikis.

0.26.1 carried this as a single **Known** entry, and the rest of it is dropped
as closed. The index/linter disagreement is answered: the operator who opens the
linter about those pages is now told what they are and what to do. The
correction to 0.26.0's "roughly a third of published pages carry no claims" —
that the number came from the concept list, which counts every page, and not
from the rule it was written to justify — stands as recorded and is no longer an
open question. And the three candidate closures that entry declined to choose
between are now decided: this release took the second, a rule of their own that
names what is actually wrong with them, rather than reporting them as unsourced
or teaching the index to hide their zero.

## 0.26.1 - 2026-08-08

Nothing in the binary changed. Almost every fix here is in
`scripts/deploy/smoke.sh`, the script that stands between a release and the
claim that the release is good — and they were found by chasing a test that
failed once in ten runs rather than dismissing it as noise.

### Fixed

- **The OpenAPI regeneration instruction produced an unreviewable diff.** The
  command the snapshot test prints when it goes stale wrote the document
  indented. Prettier 3 preserves an object's expansion when the input already
  had a line break inside it, so that formatting survived untouched and turned
  a 1,500-line document into 8,800 — in the one file whose entire justification
  is that its diffs get read in review. Nothing caught it: the tests compare
  parsed JSON, and the re-inflated document is byte-different but semantically
  identical, so it would have passed the gate and landed. The command now
  writes compact JSON and lets `bun run format` do the layout, which makes the
  diff for a one-word change one line.

- **A green tick over a check that was never made.** `/metrics` is
  unauthenticated by design and has to be gated by the reverse proxy, so the
  check asked for it from outside and treated anything other than `200` as
  proof of gating. But `000` is not a status — it is curl reporting that it
  never got an answer at all, and it is equally what a firewall dropping the
  packet and a broken network look like. Only the first of those is the
  deployment being correct, and nothing at that point can tell them apart. The
  run now says so and counts it as skipped. This is the third false green found
  in this file and the same shape as the other two: a check whose passing
  condition was the absence of bad news rather than the presence of good news.

- **An unreachable installation reported none of its checks.** `set -e` killed
  the script inside the first command substitution, so a host that did not
  answer produced one raw curl line and no list — on precisely the deployment
  somebody most needs the list for. A connection failure is now data, like a
  body's, so every check is asked, each says `got 000`, and the summary still
  prints.

- **A restart the script was too impatient for.** It runs seconds after the
  deployer moves a binary into place and restarts the unit, which is exactly
  when a connection refused means "still coming up" rather than "broken" —
  and it believed the first attempt. Connection-level failures are now retried
  (`SMOKE_CONNECT_RETRIES`, default 2), which also removes the flake this
  release started with: an occasional refusal against a loopback fixture under
  load made `bun run gate` non-deterministic, and a gate people re-run instead
  of read has stopped being a gate.

### Known

- **The page list and the linter disagree about the same pages, and 0.26.0's
  reasoning for the new rule was measured on the wrong one of them.** That entry
  motivated `unsourced-concepts` with "roughly a third of published pages carry
  no claims at all". That number came from the concept list, which counts every
  page. The rule counts a smaller set: it excludes revisions marked as import
  scaffolding. Held against a real installation of sixteen wikis, the list
  reports about fifty pages with no evidence and the rule reports thirteen — so
  the sentence is true about the list and misleading about the rule it was
  written to justify.

  The gap is not an error in either query; both do what they say. It is that
  two surfaces answer the same question differently, which is exactly what the
  same entry promised to avoid when it aligned search with the list. An
  operator looking at one wiki sees twenty-four pages reported with `sources: 0`
  in the index, opens the linter to find out what to do about them, and is told
  nothing is wrong.

  The excluded pages are not invisible furniture, either. They carry a title,
  they appear in the index, a reader can open them, and they are blank — their
  summary says they were created as targets for relations imported from
  elsewhere, and they now have no relations at all. Calling them "never a page
  anybody wrote to be read" describes where they came from, not what they are
  now.

  This is left open deliberately rather than settled here, because every way of
  closing it changes what an operator's linter says about their own wikis, and
  the three candidates differ in kind: report them as unsourced like any other
  page; give them their own rule that names what is actually wrong with them
  (leftover import stub — delete it, rather than "ingest a source"); or keep the
  exclusion and have the index stop presenting their zero as if it were a
  knowledge page's zero, the way a search hit omits evidence rather than
  reporting it as zero. Related: the exclusion list in `src/domain/lint.ts`
  hardcodes one installation's private migration tag, which is a fact about a
  particular deployment living in a product that otherwise knows nothing about
  where it runs.

### Added

- **The `/metrics` gate is now actually exercised.** It was the one check a
  loopback fixture skipped, so no test had ever run it — an unexercised check
  in a script whose whole job is to be exercised is the same bet as no check at
  all. `SMOKE_PROXIED=1` forces the judged branch, and all four outcomes
  (skipped on loopback, pass, open endpoint, no response) are now pinned.

## 0.26.0 - 2026-08-08

This release closes both items 0.24.0 left under **Known** — the `contradictions`
lint rule reading only half of a space's predicate declarations, and `/mcp` and
the OAuth plane accepting work from a draining process. Neither reappears below.

### Added

- **The linter now names the pages nothing archived stands behind.** 0.25.0 made
  this countable per page and the first thing it showed on a real installation
  was that roughly a third of published pages carry no claims at all — but the
  linter, which is where an operator goes to find out what needs attention, had
  no way to say so. It had a rule for a page nothing _links to_ and none for a
  page nothing _backs_.

  `unsourced-concepts` reports every readable page across whose visible claims
  there is not one citation, and says which of the two shapes it is: a page that
  makes no claims at all, or a page that makes claims and quotes nothing for any
  of them. Same fix in both cases — ingest a source and let synthesis quote it —
  but a different amount of prose is already at risk, so the count is in the
  line.

  It is a **warning**, deliberately between its neighbours. Not an error: a page
  somebody typed by hand is a legitimate thing to have in a wiki, the three
  error rules all describe states that are simply wrong, and a rule that shouts
  at a legitimate state is a rule an operator turns off — turning CI red on
  every installation the day it upgrades is not a call a lint rule may make on
  an operator's behalf. Not information: `info` is where "noticed, nothing
  expected of you" lives, and this one names an action which is the product's
  entire loop.

  A page with no claims trips both this rule and `empty-concepts`, and that is
  intended rather than an oversight. The information line records a stub; this
  one records that nothing archived stands behind it and says what would fix it.
  Suppressing either would make a page's reported severity depend on which rule
  reached it first, and would hide the actionable line behind the passive one.
  The counts in a lint report are a census of findings, never a headcount of
  pages.

- **Webhook delivery history can be asked for in full.** The deliveries list was
  the only list in this API with no `limit` parameter, so it answered fifty rows
  and there was no way to ask for more — including from its own console page,
  which had to state a ceiling it could not raise. Debugging an endpoint that
  had been failing for a while meant reading the most recent fifty attempts and
  guessing at the rest.

  `GET /v1/spaces/{space}/webhooks/{id}/deliveries` now takes `?limit=`, default
  fifty and up to two hundred, matching every other list here; the console asks
  for the ceiling. It is a bigger window and not pagination — there is still no
  cursor, and the page still says so rather than implying the history it shows
  is all of it.

- **Search results now say how well each page is evidenced.** 0.25.0 gave the
  page index three numbers per row — how many claims a page makes, how many of
  those quote nothing, and how many archived documents stand behind it — so a
  reader could tell, before spending a click, which pages the archive supports.
  Search was the other place that choice gets made, and it was still silent: a
  ranked headline tells you a page matched, never how the wiki knows what it
  says. Same question, same gap, one surface later.

  Every hit of `GET /v1/spaces/{space}/search` with `kind: "concept"` — and the
  same hits through the `wikikit_search` MCP tool — now carries the same
  `evidence` object the list carries, counted by the same aggregate over the
  same visible claims. A page therefore reports identical numbers whether it is
  found by browsing or by searching; two surfaces disagreeing about one page
  would not read as two code paths, it would read as a wiki that does not know
  what it holds.

  Two kinds of hit deliberately carry nothing. A **claim** hit raises a
  different question — "is _this_ claim quoted?" — which none of the three
  numbers answers; lending it the page's totals would put `claims: 12` on a
  single claim and invite `uncited_claims` to be read as a verdict on the
  matched one. A **source-evidence** hit is an archived paragraph nobody has
  reviewed, and its tier label exists to say exactly that: an evidence summary
  there would dress unapproved material in the badge of a curated page, which
  is the worst misreading this field admits. Absence therefore never means
  zero — where the object is served, `claims: 0` is a measured page that cites
  nothing, still the state this feature exists to make visible.

  The cost is one extra statement, issued only when a response actually holds
  concept hits, over at most the 50 slugs a search can return — a quarter of
  what the index already counts in a single statement. A search filtered to
  claims, or one that matches nothing, costs exactly what it cost before.

### Fixed

- **The contradiction warning on a review told some wikis nothing and other
  wikis the wrong thing.** It is the third surface on the review screen that
  answers "will approving this hurt?", and it was the last one still carrying
  its own copy of the rule. That copy read only the older of the two ways a
  space can declare which predicates hold a single value — so a wiki declaring
  them through the typed registry got **no contradiction findings at all**, and
  one declaring them the older way got findings for changes approval would not
  actually dispute. Both failures were silent: a query reading the wrong half of
  a settings object never errors, it just returns nothing.

  It now resolves the declaration through the same helper the proposal diff and
  the space-wide lint already use, which reads both, and it applies the same
  refinements approval itself applies. A frame split by context (`region:eu`
  against `region:us`), two values that are canonically the same thing (`1 GiB`
  against `1024 MiB`), two facts whose validity periods do not overlap, a
  reviewer's explicit "these complement each other", and a change that says
  outright which claim it supersedes are none of them contradictions, and
  approval never treated them as such. The message promises "approval disputes
  both", and that is now true of everything it reports.

- **A console tab left open through a long review signed you out mid-edit.** The
  session cookie renews on a read of the session, and the console only made that
  read when it loaded — so a tab focused all day never renewed anything, and the
  idle window expired underneath somebody who had been working in it the whole
  time. 0.24.0 documented this as the cost of the design; it was not.

  A visible tab now re-reads its session every ten minutes, and a hidden one
  re-reads on return. A hidden tab deliberately does **not** renew itself on the
  timer: the idle window exists so that an unattended session dies on schedule,
  and a minimized tab quietly renewing every ten minutes would convert every
  eight-hour idle window into the twenty-four-hour absolute cap for anybody who
  never closes a tab. The absolute cap is unchanged and still ends the session
  where it stands.

  Turning the renewal on exposed a worse failure that had been latent: the gate
  checked for an error before it looked at the answer it already had, so a
  single failed renewal — one blip, on a session the server never stopped
  honouring — would have replaced the whole console with "Could not reach
  WikiKit" and taken every unsubmitted edit with it. A known answer now outranks
  a failed attempt. A session that genuinely ended still signs the console out
  immediately; that is an answer, not a failure.

- **An identity's email could not be cleared, and the form said nothing.** The
  column is nullable, `''` is not `NULL`, and the update path kept every field
  the body left out — so an operator deleting a stale address closed the dialog
  on a request that changed nothing, with no error to tell it apart from
  success. 0.24.0 fixed exactly this for `display_name` and left this one
  pinned by a test that recorded why: the wire type had no way to say "clear
  it".

  It has one now. On `PUT /v1/identities/{provider}/{subject}`, `email` carries
  three states rather than two: absent keeps the stored address, `null` clears
  it, a string sets it. `null` rather than `''` because `NULL` is already what
  this column means by "no email" — the SSO callback writes it whenever the
  provider asserts no verified address — and a nullable column holding two
  kinds of empty is a distinction every reader downstream would have to carry
  forever. `''` is now refused (`400`) for the same reason. It is not a new
  convention either: this API already reads an explicit `null` as a value and
  an absent key as "leave it alone", on `base_revision_id` in a staged concept.
  `display_name` keeps the opposite spelling, because its column is NOT NULL
  with an empty default, so `''` is already what clears it.

- **The grant dialog announced a grant while the server performed an edit.**
  The console chose its wording from which button was pressed; the server
  decides by whether the row exists. Type the provider and subject of somebody
  who is already admitted into "Grant access" and the two disagreed — the
  dialog promised a new grant, and the request replaced a scope ceiling that
  person already held, which is the one case where the wrong word is dangerous.

  The dialog now reads the list the page has already loaded, so it can tell
  what the server will do without asking it: the title and the button say
  "Change what this person reaches" and "Set ceiling" the moment the typed
  identity matches an admitted row, and a warning names the ceiling that is
  about to be replaced — including the empty one, which reads as the lockout it
  is. It stays a warning and never a refusal: re-granting somebody from the top
  of the page is a legitimate thing to do, and a console that blocked it would
  be wrong in the other direction. A revoked match still points at Restore,
  where the server would answer `409`.

- **A draining process still took new agents and minted new tokens.** `/mcp`
  and the whole OAuth/session plane are mounted raw, ahead of the drain gate,
  so for the entire shutdown window an agent could open a session or a client
  could mint a token on an instance that was seconds from tearing both down —
  while the identical operation over REST got a clean `503 draining` and
  retried against an instance that was staying up. 0.24.0 wrote it down rather
  than fixing it, because the fix is not a reordering: it is deciding what a
  refusal sounds like in a protocol that is not HTTP. That decision is made.

  `/mcp` now refuses on every method, as a 503 carrying a **JSON-RPC error
  frame** rather than WikiKit's HTTP envelope. The status is for the load
  balancer, which reads statuses; the frame is for the client, which reads
  bodies as JSON-RPC messages and would have reported the envelope as a parse
  error — and a client that believes the server is broken does not retry
  somewhere else, which is the one outcome this refusal exists to prevent. The
  shape is the one WikiKit's own transport guards already use for a bad Origin
  and an unsupported protocol version, so no client learns anything new.

  The OAuth/session plane splits, and the line is not browser-versus-machine —
  it is who can act on the refusal. A program that gets a 503 retries, and
  every row its flow depends on is in the Postgres all the instances share, so
  the retry resumes rather than restarts: discovery, registration, the
  identity-assertion exchange, the token mint and its revocation all refuse. A
  human halfway through a redirect chain cannot retry — the login state they
  carry is single-use and already consumed, so a 503 at the callback means
  "sign in again from the start", announced by a blank page to the operator
  most likely to be watching the deploy that caused it. The sign-in funnel and
  the consent screen therefore finish what they started. The two halves compose
  because of that shared database: consent completed on the draining instance
  is exchanged for a token, one refusal and one retry later, against a live one
  reading the same row.

  The console keeps serving throughout, which was never in doubt. It is static,
  it holds no knowledge, and the API calls it makes are ordinary routes that do
  hit the gate — so it degrades to reporting the drain, which is true, instead
  of going blank, which reads as broken at precisely the wrong moment.

  Each raw mount now states its drain policy where it is mounted, and stating
  it is mandatory: there is no default, because a default would be a shutdown
  decision made silently for every mount added later.

- **The metrics label was computed twice and could disagree with itself.** The
  route label a request was counted, logged and billed under was recomputed
  after the response, by re-running the route table against a plain split of
  `req.url` — while the request had been dispatched on a properly resolved URL.
  The two differ for a path with dot segments and for the absolute-form request
  line a proxy may send, so a request served as `/v1/spaces/{space}` could be
  recorded as `(unmatched)`. The label is now written once, by the code that
  made the decision, and only read afterwards.

  What that does not change, deliberately: an unknown path answers `404` while
  draining exactly as it does otherwise, and is counted the same way. Nothing
  was refused — the path does not exist on this build and will not exist on the
  next one — so there is nothing to attribute to the drain. Refusals are
  attributable: they are `status="503"` under the refusing route's own label,
  next to `route="/ready"`. Drain volume is that series, never a delta in the
  404 bucket.

- **The deployment guide told operators a rollback was safe that no longer is.**
  `docs/DEPLOYMENT.md` still carried the release note of a much earlier version:
  it named a specific tag as "this change", and it stated that rolling back to
  v0.4 stayed schema-compatible because one nullable column and one defaulted
  function argument made it so. That was true when it was written and has not
  been for more than twenty migrations — an operator following it during an
  incident would have put a binary that predates most of the schema in front of
  a database that has all of it. The version-specific framing is gone, and the
  rollback guidance now says what actually holds: one release at a time, and
  only where that release's entry here says so.

### Known

- **A console tab left visible on an unattended machine now renews itself until
  the absolute cap.** This is the cost of the session fix above, stated plainly
  rather than buried: the renewal fires while the browser reports the tab as
  visible, and a browser cannot report whether a person is in front of it. Before
  this release such a tab would have been signed out by the idle window; now the
  twenty-four-hour absolute cap is the only bound on it, and that bound does
  still hold — it is stamped from the session's own expiry and no amount of
  renewing moves it.

  The narrower reading was rejected on purpose. A hidden tab does not renew, so
  a closed laptop still dies on the idle schedule; catching the unattended-but-
  visible case would mean inferring presence from input events, which is a
  guess, and a session that ends on a guess ends in the middle of somebody's
  review. Operators who need the shorter bound should shorten the absolute cap,
  which is the control that actually means what it says.

## 0.25.0 - 2026-08-08

### Added

- **The page list now says how well each page is evidenced.** WikiKit's premise
  is that every claim on a page carries a verbatim quote from an archived
  source. Until now the index would not tell you whether a given page honoured
  that. "How does this wiki know this?" — the first question a reader has, and
  the one this product exists to answer — could only be answered by opening the
  page, and then the next one, and then the one after that. The owner of an
  installation asked why the list was silent about the only thing that
  distinguishes a WikiKit page from a paragraph somebody typed. It no longer is.

  Every row of `GET /v1/spaces/{space}/concepts` now carries an `evidence`
  object of three numbers: **`claims`**, how many claims the page makes;
  **`uncited_claims`**, how many of those have no quote behind them; and
  **`sources`**, how many distinct archived documents the page draws on. Only
  visible claims are counted — `verified`, `disputed` and `deprecated` — never a
  `proposed` or `draft` one, because counting staged work would let an
  unreviewed change make a page look evidenced before anybody agreed it was.
  The three answer different questions and none is derivable from the others:
  five claims quoting one document and five quoting five are the same
  `uncited_claims` and very different pages.

  The state this makes visible for the first time is the **page written by hand
  that cites nothing at all** — zero claims, zero sources. It is a legitimate
  thing to have in a wiki, and it was also completely indistinguishable from a
  fully sourced page in every list WikiKit had ever drawn. It now reads as a
  measured `0` and is flagged in the console, which is the point: a reader can
  see, before spending a click, which pages the archive stands behind and which
  are somebody's memory. `0` is an answer here, never a blank — the console
  keeps its em dash for the row whose counts genuinely never arrived.

  The cockpit's page index gains a sortable **Evidence** column built on those
  numbers, placed second so it survives a narrow screen. It costs nothing extra
  to draw: the counts ride along on the list read the console was already
  making, in the same single statement, so a wiki of any size still answers the
  index in the queries it answered it in before.

## 0.24.0 - 2026-08-08

### Fixed

A second adversarial review, this time of the console shipped in 0.22.0 and of
the credential plane underneath it. Nothing here was visible to the gate — the
recurring theme is a surface that states something the server does not do, which
no assertion about the server can catch.

- **A crafted sign-in link ended the attempt on a 500 and burned it.**
  `GET /v1/identity/cockpit-login?return_to=…` rejected CR and LF and nothing
  else, but node's `res.setHeader` throws on any other non-printable code point
  too — and the single-use login state is marked consumed _before_ the redirect
  is built. So a link carrying a NUL, a DEL or a stray `U+2028` answered an
  operator's sign-in with a 500, with the attempt already spent and the page
  explaining nothing. A `return_to` is now printable ASCII or it is not used;
  the console builds it out of an already percent-encoded `location.pathname`,
  so nothing legitimate arrives outside that range. A refusal was never an
  error — the operator still lands signed in, one navigation from where they
  meant to be.

- **Working continuously signed you out after eight hours.** The session row's
  idle deadline slid on every authenticated read, exactly as documented, but the
  cookie's `Max-Age` was written once at sign-in and re-written only by
  login, consent and sign-out. The browser therefore dropped a cookie whose
  session was still alive — eight hours in, typically mid-review.
  `GET /v1/session` now re-stamps the same token with the deadline the renewing
  UPDATE actually returned, so the documented idle window is true on the browser
  side too and the 24-hour absolute cap still cannot be read past: the `Max-Age`
  comes from what `least(absolute_expires_at, …)` wrote, never from a fresh
  clock. It renews when the console loads rather than on a timer, so a single
  tab left open past the cap still needs a reload.

- **The cockpit's sign-in door was the cheapest row in the system to create from
  outside.** It takes no client, no credential and no consent, and every request
  past the already-signed-in check inserted a ten-minute login state while the
  housekeeping sweep only collects hourly. It is now metered per remote address
  like dynamic client registration, at twenty a minute — charged _after_ that
  short-circuit, so an operator moving around their own console never spends a
  slot, and set above the DCR limit because with `WIKIKIT_TRUST_PROXY` off a
  whole office behind one NAT shares a single bucket. The refusal renders as an
  HTML page in the same shell as every other funnel error, and `docs/openapi.json`
  now documents that 429 — along with the one `POST /v1/oauth/register` has been
  answering, undocumented, since it grew a limit.

- **A pending change showed disputes that approving it would not produce.** The
  review diff flagged a claim as colliding whenever any visible claim shared its
  subject and predicate with a different object. Approval disputes far less than
  that: only predicates the wiki has _declared_ functional, only inside the same
  context, only where the normalized values differ, only where the validity
  intervals overlap, and never across an adjudicated complement or an explicit
  supersession. The declared set is empty until somebody declares one, so in most
  wikis every ordinary multi-valued claim wore a `disputed` badge — in the diff
  and in the rendered review Markdown both — and then approval disputed nothing.
  The flag now carries every condition the apply applies, which also settles a
  standing disagreement with the `contradictions_count` the
  `wikikit.proposal.created` event reports about the same change.

- **The Split confirmation promised the wrong number of changes.** It counted one
  new pending change per page, but the server adds one more — a
  `<title> — decisions` child — whenever the change carries decisions or leaves
  relation removals stranded on pages it is not splitting out. The dialog and the
  toast that followed it described different events. The dialog now counts that
  child under the same rule the server uses, and names it.

- **A change's claim review advertised a "retired" state that could not occur.**
  Every group it renders is derived from the same staged set, so the branch was
  unreachable; the field and its documentation are gone rather than left as a
  promise.

- **Emptying an identity's display name did nothing.** The console omitted the
  field when it was blank and the server reads an omitted field as "keep what is
  stored", so an operator could clear the box, save, and watch the old name come
  back. Editing a grant now sends the empty string, which the column takes;
  creating one still omits it, because there is nothing to clear on a row that
  does not exist. Clearing an **email** is still a no-op and cannot be fixed from
  the console — the request type has no way to say "make this null" — so the
  current behaviour is pinned by a test until the contract grows one.

- **Re-submitting a page after somebody else changed it returned the stale
  change.** The console dedups a submission by hashing what it is submitting, and
  the base revision was not in the hash — so identical text staged against a page
  that had moved underneath handed back the earlier proposal, written against the
  old base, instead of staging a new one. The base is part of the anchor now. One
  consequence: a change staged by an older console and still pending across this
  upgrade will not dedup the first time it is resubmitted.

- **Three console lists claimed to show everything while showing a page.** The
  webhook delivery log said "every attempt WikiKit has made" over the fifty
  newest — the exact sentence that misleads the operator arriving with "our
  webhooks stopped last Tuesday". Connector streams took the server's default of
  fifty when two hundred were available, with Forget living in the row, so a
  stream past the ceiling could be neither seen nor forgotten. Search reported a
  per-tier count that read as a total. Streams now ask for the full two hundred,
  and all three state the ceiling when the answer comes back full and stay quiet
  when it does not. The delivery endpoint is the only list in this API with no
  `limit` parameter at all, so fifty stands there until it grows one.

- **The sidebar forgot it was collapsed.** The vendored component wrote a
  `sidebar_state` cookie nothing in this console ever read — upstream expects a
  server to read it back — so the sidebar sprang open on every reload while a
  dead cookie rode every `/v1/*` and `/mcp` request. The preference is kept in
  `localStorage` now, read before first paint so there is no flash, and sent
  nowhere.

- **The post-deploy smoke test would have passed a policy that allows inline
  script.** `scripts/deploy/smoke.sh` looked for `unsafe-inline` immediately
  after `script-src`, but the served directive is `script-src 'self' 'sha256-…'`
  — so the regression the check exists to catch, a source _appended_ to it,
  matched neither pattern and got a green tick. The hash check had the mirror
  flaw and would have failed a correct deployment with anything inserted before
  the hash. Both now extract the directive that actually governs `<script>`,
  fall back to `default-src` when the policy names no `script-src`, and fail when
  the policy constrains scripts with neither.

- **The System page was permanently red in the dev loop.** `vite` did not proxy
  `/.well-known`, where the service descriptor lives, so the page failed in
  development and worked in production. The proxy list is now a module a test
  holds against the navigation table, which is what will catch the next one.

- **Four comments described mechanisms their files do not have** — the HTTP
  header's account of the request pipeline (it now states the order `dispatch`
  really runs, and names what bypasses the drain gate), and the cockpit mount's
  claim that on-disk assets let a developer see a rebuild without restarting
  (they do not; the first `index.html` is pinned for the process lifetime).

### Known

- **The `contradictions` lint rule still overstates a change's consequences,
  for the same reason the diff did.** It is a third surface on the same review
  screen, with its own copy of the rule and its own "approval disputes both"
  message, and its copy reads only the legacy `functional_predicates` array —
  so a wiki that declares functional predicates through the typed registry gets
  no contradiction findings at all, and a wiki using the array gets the coarse
  over-reporting the diff has just stopped doing. Space lint next to it already
  reads both. The change is contained and the correct helper is in the same
  file; it is called out here rather than made on the way past, because it
  changes what a lint report says and deserves its own tests.

- **`/mcp` and the whole OAuth/session plane keep accepting work while the
  process is draining.** They are mounted raw, ahead of the drain gate, so an
  agent can open a session or mint a token seconds before `close()` tears it
  down, where the same operation over REST gets a clean `503 draining` and
  retries against an instance that is staying up. Correcting it means deciding
  how a JSON-RPC transport reports refusal, which is a behavioural decision and
  not a reordering; it is written down in `src/http/server.ts` rather than left
  to be rediscovered.

## 0.23.0 - 2026-08-08

### Changed

- **An SSO identity may now hold `admin`, and only ever by being written down.**
  Identities were capped at the knowledge scopes on the reasoning that an
  identity provider should not be a path to administration. That cost nothing
  while WikiKit had no console — administration was curl with a key either way.
  0.22.0 changed it: an operator signing in through SSO met a cockpit whose
  entire Installation block was absent, on the installation they own. A product
  whose own interface is mostly forbidden to the person who signed into it is
  not secure, it is broken.

  Three rules hold the trade in place, and each is the point of the other two:

  - **No default ever carries `admin`.** The global fallback stays
    `knowledge:read,knowledge:propose`, and a provider that declares no ceiling
    inherits exactly that. The parser refuses `admin` arriving from a fallback
    rather than from something an operator typed, so a future edit that widened
    a default cannot grant administrative SSO to every deployment on upgrade.
  - **`*` is refused outright**, and the distinction from `admin` is not
    squeamishness: `admin` is an authority you can enumerate, and what it
    reaches today it reaches tomorrow. `*` is "everything, including whatever is
    added later" — a grant whose contents are written nowhere and grow with the
    product. That belongs to a key somebody minted on the host with a shell,
    where the act itself is the record.
  - **A remote MCP client still cannot hold `admin`.** `OAUTH_SCOPES` does not
    contain it, so a client cannot request it and consent cannot offer it. An
    `admin` ceiling reaches the browser operator session and an SSO-minted API
    key, and stops there.

  Naming `admin` is a deliberate trade: an account takeover at the identity
  provider then reaches credential and identity management, with no second
  factor anywhere in WikiKit's own chain. Defensible when the provider enforces
  MFA and the allowlist is short — the shape a self-hosted installation usually
  has — and indefensible otherwise. WikiKit cannot tell which one it is in, so
  it takes the operator's word rather than deciding for them.

  Nothing changes for an existing deployment until it says so: no stored
  ceiling gains a scope, and `PUT /v1/identities/{provider}/{subject}` now
  accepts `admin` in its explicit `scopes` array — never through a role
  shortcut, which `knowledge:approve` has never had either.

## 0.22.0 - 2026-08-08

### Added

- **The cockpit** — WikiKit's first human interface, served by the same binary
  at `/cockpit`, on the same origin and at the same version as the API it talks
  to. It presents the product as what it is: a **wiki**. A space is a wiki, a
  concept is a Markdown page, sources are the evidence behind it, and editing a
  page submits a **change**. The button says "Submit change" and not "Save",
  because nothing a human writes becomes knowledge until somebody with
  `knowledge:approve` decides it does — and an interface that said Save would be
  promising something the server does not do.

  Reviewing is the surface the rest exists for: a change renders as a line diff
  per page, with its claims and their verbatim citations, its lint result (which
  never blocks the diff), and approve / reject / request-changes / defer each
  behind a confirmation that restates the exact effect. The public
  `/review/{id}` page is unchanged and still the URL an agent hands a human; the
  cockpit shows that address rather than replacing it.

  Twelve surfaces in three sidebar blocks — where you are, the wiki, and the
  installation folded away. Every write control gates on the scope the server
  will actually demand, and states its reason when it cannot act, rather than
  disappearing.

- **A credential plane for browsers.** `GET /v1/session` answers
  `{"session": null}` for an anonymous tab and **never** 401s — "nobody is
  signed in" is an answer a console renders, not a failure it recovers from.
  `GET /v1/identity/cockpit-login?return_to=…` enters the same provider chooser
  every other sign-in uses, and `DELETE /v1/session` signs out.

  The console is deliberately **not** an OAuth client. Consent exists so a third
  party can be told what it is about to be granted; an installation's own
  console is not a third party, and a consent screen for it is a screen that
  teaches people to click through consent screens. Migration `0032` gives a
  login state a `purpose`, with a CHECK constraint making the cockpit and
  authorization shapes mutually exclusive — a cockpit state with a
  `redirect_uri` would be an unvalidated authorization request, which is exactly
  the row an open redirect needs.

  The resulting operator cookie is a **fallback** REST credential: consulted
  only when a request carries neither `Authorization` nor `X-API-Key`, with a
  same-origin `Origin` required on every unsafe method. A header credential
  always wins, so no API-key client's 401 or 403 changes shape. A CSRF token was
  the alternative and was rejected: it has to reach JavaScript to be sent, which
  is the one property an HttpOnly cookie was chosen to avoid.

- **`contract/cockpit-ui.css` and `contract/COCKPIT-UI.md`** — the design
  contract the console implements, carried as text and identified by the sha256
  of the token bytes rather than by a version number a person types. The three
  sentinel regions in `apps/cockpit/src/index.css` are byte-identical to it,
  `lib/tokens.ts` restates the same table as data because an SVG stroke cannot
  read a Tailwind class, and a test compares all three. The built `index.html`
  announces the digest in a `<meta>` tag, derived at build time.

- **`scripts/deploy/smoke.sh`** and **`scripts/deploy/verify-cockpit-prod.md`** —
  post-deploy verification, driven entirely by `$WIKIKIT_DEPLOY_URL`. The first
  is read-only curl: the shell served `no-cache` under a hash-based CSP, a deep
  client route falling back to it, `/metrics` refused from outside, the chooser
  asking for no credential on step one. The second is the browser checklist for
  what curl cannot see — the sign-in round trip with a deep return address, the
  theme surviving sign-out and reaching the funnel, and the loop itself.

  Both were pointed at a deployment WITHOUT a cockpit before being trusted, and
  two checks passed that should not have: "no `unsafe-inline` in `script-src`"
  was satisfied by there being no policy at all, and "step one asks for no
  credential" by there being no chooser to ask. Absence now fails both, which
  is the entire difference between a smoke test and a green light.

- **`scripts/check-cockpit-browser.ts`** — the layout check no unit test can
  make: every navigable route at 390×844 and 1280×800, asserting the document
  itself does not scroll sideways, that every table scrolls inside its own
  container, and that no cell clips its own text. It signs in through the real
  funnel rather than forging a cookie, so a misconfigured `WIKIKIT_PUBLIC_URL`
  fails it instead of being routed around, and it reports how many
  route/viewport pairs it actually checked — a run that saw nothing says so.

- **`test/unit/cockpit-page-api.test.ts`** — closes the other half of CUI-NAV-2.
  The navigation test proved every DECLARED path exists; nothing proved a page
  reaches only what it declares, which is the drift the rule is about. This
  parses the `wk.*` facade and every page module and compares both directions,
  counting a download link as a reach — an export is a navigation the browser
  owns, not a fetch.

### Fixed

Everything below was found by an adversarial review of the change before it
shipped, or by walking the console in a browser. None of it was visible to the
gate, which is the point worth recording: a green suite is evidence about what
was asked, not about what was built.

- **Navigating the console silently changed which wiki you were reading.** A
  `<Link>` with no `search` prop does not inherit the query string, so clicking
  Pages while reading `?space=team-b` landed on `/cockpit/pages` with no space
  at all — and the resolver fell through to the first wiki the credential could
  see. Sidebar, page body and every subsequent request moved to a different
  wiki with nothing on screen saying so. Three pages had remembered to pass the
  search through and fourteen link sites had not, which is how a per-call-site
  convention fails. `retainSearchParams(['space'])` on the root route makes it
  one decision instead of eighteen.

- **`GET /cockpit/constructor` was an unauthenticated 500 with a stack trace.**
  The embedded-bundle lookup used a truthiness check on a plain object, so a
  path naming an `Object.prototype` member resolved an inherited function and
  `Buffer.from` threw — before the miss was cached, so it repeated forever and
  any anonymous caller could drive the 5xx rate and the error log.

- **Unknown cockpit paths were unbounded memory.** Caching misses looked like
  the obvious symmetry and was not: this mount runs before auth, so every
  distinct `/cockpit/<random>` added a permanent map entry nothing evicts. Only
  hits are cached now; a miss costs the stat it was avoiding.

- **A malformed `wk-cockpit-theme` cookie took the whole sign-in funnel down.**
  `decodeURIComponent('%')` throws, and the cookie parser was unguarded, so one
  bad cookie 500'd every HTML response in the funnel — the console's sign-in
  _and_ every MCP client's. The cookie is deliberately script-writable, so any
  page on the same registrable domain could set it. The comment claiming the
  worst it could achieve was a dark login page has been corrected along with
  the code.

- **A rollback's leftovers were servable.** The traversal guard compared
  against the bundle directory without a separator, so `assets/cockpit-old`
  satisfied `startsWith(assets/cockpit)`. Unreachable in a compiled binary,
  which has no `assets/` on disk — and fired on precisely what a rollback
  leaves behind.

- **The review queue truncated at 50 and then said it had not.** The read sent
  no limit, so it took the server's default, while the footer — which grades a
  whole-list read — announced "across all 50 changes, not just this page". In a
  wiki with more, the 51st-oldest pending change was unreachable from the
  surface the product exists for.

- **Reading the console counted as API demand.** `/cockpit` was not in the
  usage ledger's internal-route list, so every navigation and every
  fingerprinted chunk wrote an `organic` row — and the System page reported the
  operator's own browsing back to them as traffic.

- **The cockpit rendered "No wikis yet" on an installation with wikis.**
  `app/root.tsx` read `data.spaces`; every list read in this API answers
  `{items: [...]}`. The exact shape of failure an optional chain hides: no
  error, no empty response, a page quietly claiming nothing exists. Found by
  walking the console in a browser, not by a test.

- **The sign-in funnel described an authorization request to operators who were
  not making one.** The same three screens serve an MCP client asking to be
  authorized and an operator opening their own console; they now say which. A
  sign-in page that describes something the reader is not doing teaches them to
  stop reading sign-in pages.

- **`build-binary.sh` will not ship a binary with an empty console.** An empty
  embed compiles, boots, passes every test, and serves a 503 where the cockpit
  should be — the one failure the whole pipeline exists to prevent, and the one
  no unit test can see, because it is a property of the artifact.

### Changed

- **WikiKit is no longer "no web UI".** It is still headless for agents — no CLI,
  no console API, and every route the cockpit calls is one an agent could call.
  What changed is that humans now have one place to do the work instead of
  composing curl. README and `docs/ARCHITECTURE.md` say so; `docs/COCKPIT.md` is
  the operator's account of how it is served, signed into and verified.

- **The sign-in funnel follows the console's colour scheme.** The `.scheme-light`
  and `.scheme-dark` classes the shared token block has always carried are now
  set, from a non-HttpOnly `wk-cockpit-theme` cookie the console mirrors its
  choice into. The funnel stays script-free, so it could not have read the
  preference itself, and `vary: cookie` keeps two operators behind one proxy from
  being served each other's scheme. The pinned token bytes are untouched — the
  class goes on the document element, outside the sentinels.

- **`bun run gate` and CI build the console.** `assets/cockpit` and
  `src/cockpit-embedded.ts` are generated, committed and served — the compiled
  binary reads the embed — so a stale one ships last week's console against this
  week's API with nothing at runtime noticing. `check:cockpit-drift` rebuilds and
  fails on any diff, and `build-binary.sh` rebuilds rather than trusting the
  checkout.

## 0.21.0 - 2026-08-06

### Changed

- **The sign-in and consent pages follow the reader's colour scheme.** The shared
  funnel was `color-scheme: light` and nothing else, so anyone working in dark met
  a white page. It now declares both schemes and switches on
  `prefers-color-scheme`. WikiKit ships no console, so there is no explicit
  preference to honour — the media query is the whole answer here, and the
  optional `.scheme-light` / `.scheme-dark` classes the shared block carries are
  never set. No server change was needed, which is what that optionality is for.

  The block also moves to the family's cockpit token vocabulary, which fixes two
  defects the old one carried: `.deny:hover` was about to become invisible, and
  the page had no focus styling at all — it relied on the browser's default
  outline, which is invisible on a dark card.

- **The auth UI contract loses its version number.** `mcp-auth-v2` is now
  `mcp-auth`. The number existed so that a product which had NOT taken a change
  would fail loudly rather than render unstyled — but a change to this block
  lands in every product in one wave, so that product does not exist. What the
  number actually bought was a second thing to keep in step, hand-typed, which is
  exactly the failure it was meant to prevent: four repositories all asserted
  `content="2"` while nothing compared the bytes.

  `<meta name="mcp-auth-ui-contract">` now carries a digest computed from the
  stylesheet at module load. Two products serving different bytes announce
  different strings, in the DOM. Verified identical across watchkit, contentkit,
  wikikit and subkit: 3866 bytes, sha256 `ebdaece1`.

## 0.20.3 - 2026-08-05

### Added

- **`GET /.well-known/service-descriptor.json`** — version plus a sha256 per
  self-description artifact (`llms.txt`, `llms-full.txt`, `agent-guide.md`,
  `openapi.json`), in one small response. A monitor asking "has anything
  changed" otherwise downloads all of them on every poll — `llms-full.txt`
  alone is ~50 KB, every round, almost always to discover nothing changed. This
  is what makes a thirty-second drift check affordable instead of an hourly one.

  Hashes are of the bytes actually served and are computed per request rather
  than cached: the documents are embedded at build time and cannot change while
  the process lives, and a cached hash that went stale would make this endpoint
  lie in exactly the situation it exists to report. Only artifacts this build
  actually serves are listed — an entry for a document that answers 404 would
  send a watcher to fetch it and then report the miss as drift.

## 0.20.2 - 2026-08-05

### Fixed

- **Build**: `NODE_ENV` is no longer frozen at compile time. `bun build --compile`
  substitutes the exact expression `process.env.NODE_ENV` with the build runner's
  value, so the shipped binary never read the variable and a process started by
  systemd with `NODE_ENV=production` still took every development branch: the
  mandatory-configuration check was skipped, `.env.defaults` was read in
  production, `WIKIKIT_WEBHOOK_ALLOW_PRIVATE` fell back to permitting delivery to
  private addresses, and a `*`-scope bootstrap key would be minted and printed in
  plaintext on a first boot with no keys. Verified against this repository's own
  binary before and after.

  Two guards, because neither alone finds it: `build-binary.sh` carries the
  identity define `--define process.env.NODE_ENV=process.env.NODE_ENV` and a drift
  test fails the build if any compile invocation loses it; the same script then
  RUNS the artifact under `NODE_ENV=production` and requires it to refuse to boot.
  The source is correct either way — only the compiled binary knows whether it
  still reads the variable.

## 0.20.1 - 2026-07-25

### Changed

- **Docs**: document the per-space Charter for end users across the self-describing
  surfaces — a "Space charter" section in the built-in agent guide (served by
  `wikikit_guide` and `/agent-guide.md`), a Features entry in the README, an
  architecture subsection on how the charter steers synthesis, and the charter
  REST endpoints + MCP tools in the CONTRACTS reference tables. No behaviour change.

## 0.20.0 - 2026-07-24

### Added

- **Per-space Charter** — a versioned, human-owned "virtual document" per space
  (the llm-wiki `CLAUDE.md` equivalent): free markdown that steers synthesis and
  classification, rendered together with a KB-derived overview (concept index +
  counts). Stored in the new `wk_charter_revisions` table (migration
  `0031_wk_charter_revisions`), auto-versioned like a document — every write is a
  new `latest` revision with full history retained.
  - REST: `GET/PUT/DELETE /v1/spaces/{space}/charter` (GET negotiates
    `text/markdown`; `?rev=N` reads a version) and
    `GET /v1/spaces/{space}/charter/versions`.
  - MCP: `wikikit_charter` and `wikikit_charter_history` (read, `knowledge:read`),
    `wikikit_charter_set` and `wikikit_charter_delete` (write, `admin`).
  - Bidirectional: the authored text versions directly (human-owned config, no
    review gate); an edited overview block is routed through the review gate as a
    ChangeProposal, so knowledge changes still pass human approval.
  - Steering: the latest charter flows into `synthesize.v2` and `classify.v2`
    (new prompt versions) via the rendered user prompt, never the cached system
    block.

## 0.19.0 - 2026-07-24

### Changed

- **BREAKING**: `wk_oauth_identities.allowed_scopes` is now `NOT NULL`
  (migration `0030_wk_identity_ceiling_not_null`) — the stored array IS the
  identity's scope ceiling, full stop. The transitional pre-0028 NULL-ceiling
  inheritance is retired: a `grant_source='bootstrap'` row with
  `allowed_scopes=NULL` no longer inherits the provider's `allowed_scopes`
  at runtime (`oidcIdentityScopeCeiling` is removed; the grant lookups read
  the stored ceiling directly). Production carries no NULL rows (verified
  2026-07-24; the allowlist bootstrap path has written explicit ceilings
  since 0.18.0) — the migration still defensively backfills any stray NULL
  row with the minimal `{knowledge:read}` ceiling, deliberately NOT the
  provider set, which lives in runtime ENV config and is not available to
  SQL. An operator raises a backfilled row over
  `PUT /v1/identities/{provider}/{subject}`.
- `allowed_scopes` in the `/v1/identities` responses is now non-nullable
  (`string[]`), and the 0.18.1 `PUT` lockout guard simplifies accordingly:
  it now refuses (`422 unprocessable`) a metadata-only update onto a grant
  whose stored ceiling is an EMPTY array — an empty ceiling denies every
  login and there is no allowlist inheritance left to fall back on.

## 0.18.1 - 2026-07-24

### Security

- Closed the SSO API-key loophole (migration
  `0029_wk_identity_bound_api_keys`): `POST /v1/identity/sessions` used to
  mint an unbounded `wk_api_keys` snapshot of the identity's ceiling that
  identity revocation could not reach. Session keys are now BOUND to their
  `wk_oauth_identities` grant via the new nullable
  `identity_provider`/`identity_subject` columns:
  - `DELETE /v1/identities/{provider}/{subject}` additionally revokes the
    identity's bound API keys (idempotent, alongside the existing OAuth
    token/code kill), and a later `restore:true` never resurrects them — a
    fresh login mints a fresh key.
  - Authentication rechecks the grant row LIVE on every request, exactly
    like the OAuth-token path: a revoked or deleted grant answers `401`, and
    a downgraded ceiling cuts the key's stored scope snapshot immediately
    (honoring the approve→review implication). Plain operator keys
    (`identity_provider IS NULL`) are untouched.
  - The API-key login funnel applies the same rule: an SSO-minted key used
    as an operator credential inherits the grant's current ceiling and dies
    with the grant.
- The same migration drops the legacy vendor-named `provider` column default
  that pre-0005 deployments still carried on `wk_oauth_identities` — every
  writer names the provider explicitly, so a column default only invites
  silently mislabeled rows.

### Fixed

- `PUT /v1/identities/{provider}/{subject}` now refuses (`422 unprocessable`)
  a metadata-only update that would strip a grant to `allowed_scopes=NULL`
  under `grant_source≠'bootstrap'` — previously the `COALESCE` kept the NULL
  while stamping `'admin'`, silently locking the identity out because only
  `'bootstrap'` rows inherit the provider allowlist ceiling.
- The consent offer now honors the approve→review implication the
  enforcement side (`requireScope`) has always applied: an identity with a
  `knowledge:approve` ceiling is offered the `knowledge:review` checkbox
  instead of having it silently filtered from the consent page.

## 0.18.0 - 2026-07-23

### Added

- Admin REST for SSO identity grants (migration
  `0028_wk_identity_grants_admin`, scope `admin`):
  - `GET /v1/identities` lists every grant (provider, subject, email,
    display_name, `allowed_scopes` ceiling, `grant_source`, revocation and
    seen timestamps) — never tokens or hashes.
  - `PUT /v1/identities/{provider}/{subject}` idempotently creates/updates a
    grant. `role` XOR `scopes`: the named roles `reader`/`contributor`/
    `reviewer` are server-side shortcuts expanded into scope sets and never
    stored; `knowledge:approve` deliberately has NO shortcut and must be
    granted as an explicit scopes array. Sending both (or neither on a new
    grant, or an unconfigured provider id) is `422 unprocessable`. A PUT on a
    revoked grant without `restore:true` is `409 identity_revoked` —
    `restore:true` is the only way to clear a revocation.
  - `DELETE /v1/identities/{provider}/{subject}` revokes the grant and
    additionally kills the identity's live OAuth access/refresh tokens and
    pending authorization codes (idempotent).
- `wk_oauth_identities` grows `display_name` and `grant_source`
  (`admin`/`seed`/`signup`/`bootstrap`); pre-existing self-signup rows are
  backfilled as `signup`, allowlist rows as `bootstrap`. The deploy seeder
  manages only rows with `grant_source='seed'`; a manual PUT (stamped
  `admin`) takes the row out of the seeder's hands permanently.

### Changed

- The `wk_oauth_identities` row is now the SINGLE AuthZ truth, effective
  immediately (the auth path reads the row per request/token issue, no
  restart): a stored `allowed_scopes` ceiling wins over the ENV allowlist,
  and an allowlisted login mirrors the provider's `allowed_scopes` into the
  row (`grant_source='bootstrap'`) instead of resetting the per-row ceiling
  to NULL. Rows with `grant_source` `admin`/`seed`/`signup` are never
  overwritten by the allowlist path. The ENV allowlist is bootstrap-only;
  WikiKit warns at boot when it exceeds two entries.
- `POST /v1/identity/sessions` admits identities through the same DB-grant
  contract as the browser SSO callback: operator-granted identities work
  without an ENV allowlist entry, and the issued identity API key carries the
  stored ceiling (an unknown identity is now `403 access_denied` instead of
  `401 invalid_token`).

### Security

- `revoked_at` always wins: a revoked identity is denied even while its
  subject/email still stands in the ENV allowlist, and no login path
  un-revokes a row (previously an allowlisted login reset `revoked_at` to
  NULL, silently re-admitting revoked identities). Revocation also kills the
  identity's live OAuth tokens; re-admission is exclusively the explicit
  admin-REST restore.

## 0.17.0 - 2026-07-23

### Added

- URL-mode elicitation fallback for `wikikit_review_proposal` (MCP
  2025-11-25): the native in-client form stays the primary review channel —
  in a terminal client the in-terminal review dialog — and only when the
  client has no `elicitation.form`, or advertises one and provably never
  renders it, does the tool fall back to `elicitation.url`. The human
  consents to open the embedded review page
  (`GET /review/{id}?via=elicitation`), the tool returns
  `outcome: "url_review_started"` without blocking, the decision lands on the
  page with the reviewer's own key, and the server sends
  `notifications/elicitation/complete` to exactly the originating session
  (best-effort; `wikikit_proposals` polling stays the durable path).
- New audited review channel `url_elicitation` (migration
  `0027_wk_url_elicitation_channel`): the review page reports elicitation
  provenance via an optional `via` body field on the REST review endpoints —
  informational only, no auth effect.

### Fixed

- A form-mode cancel arriving faster than any human could read the form (a
  client that advertises `elicitation.form` but auto-cancels without
  rendering it) is no longer reported as a human cancel: the review degrades
  to the URL consent or the `human_review_required` hand-off, so the agent
  gets actionable instructions instead of repeated silent cancels.
- Elicitation capability detection now follows the spec's backwards
  compatibility rule: an empty `elicitation: {}` client capability counts as
  form support.

## 0.16.1 - 2026-07-23

### Fixed

- Coverage-gap lexeme capture now resolves the space's text-search config
  through the db.call whitelist instead of inlining the SQL function —
  db.query's identifier guard (correctly) rejected the inlined call, so
  opt-in gap topics silently recorded nothing.

## 0.16.0 - 2026-07-23

### Added

- Coverage insights endpoint `GET /v1/spaces/{space}/stats/coverage`
  (migration `0026_wk_coverage_stats`, schema `wikikit.coverage-stats.v1`):
  open disputed claims with the age of the oldest one, review latency and
  approve/reject counts for a window, concept freshness (share not updated
  for 90+ days), the most-read concepts (per-day aggregate read counters for
  explicit REST/MCP concept reads — actor-free by design), the most-linked
  concepts (inbound active relations), and — opt-in via
  `WIKIKIT_COVERAGE_GAP_TOPICS_ENABLED` (default `false`) — the stemmed
  lexemes of questions the base could not answer (never the question text;
  rows expire with the usage retention window).

## 0.15.0 - 2026-07-23

### Added

- Demand-vs-coverage telemetry (migration `0025_wk_usage_no_answer`): when a
  query call answers honestly that the knowledge base does not cover the
  question, the knowledge-surface usage row records the new outcome
  `no_answer` instead of `success` (transport rows keep their status
  semantics — a 200 stays a 200). Usage stats gain `no_answer` and
  `no_answer_ratio` metrics, measuring demand the curated base does not yet
  cover. Failed requests are never counted as `no_answer`.

## 0.15.1 - 2026-07-23

### Fixed

- The `/mcp` 401 `WWW-Authenticate` challenge now advertises the complete
  knowledge permission set from `scopes_supported`
  (`knowledge:read knowledge:propose knowledge:review knowledge:approve`)
  instead of only read/propose, so MCP clients offer review/approve on their
  consent surface too. `offline_access` is a token-mechanics scope and stays
  out of the challenge. Actual grants are still clamped to the identity's
  ceiling by the unchanged consent logic.

## 0.14.0 - 2026-07-23

### Added

- Self-signup for OIDC identities (`WIKIKIT_OAUTH_ENABLE_SIGNUP`, default
  `false`; migration `0024_wk_oauth_identity_signup`): when enabled, an
  unknown OIDC identity that authenticates at the SSO callback is
  auto-admitted and registered in `wk_oauth_identities` with its own
  per-identity permission ceiling of `knowledge:read` — never the provider's
  full `allowed_scopes` set. Disabled (the default) keeps today's behavior:
  unknown identities are rejected with the styled not-authorized page and the
  RFC 6749 `access_denied` client redirect. The switch governs only unknown
  identities — allowlist entries (`allowed_subjects`/`allowed_emails`) and
  already-registered identities keep working unchanged, allowlist removal
  still revokes access, and operator revocation (`revoked_at`) always wins
  over signup.

## 0.13.1 - 2026-07-23

### Fixed

- Browser GET failures in the OAuth login funnel (denied identity policy,
  unknown/expired/consumed login state, code-exchange errors) now answer
  humans with a "Sign-in failed" page in the shared auth shell instead of a
  raw JSON body; when the waiting OAuth client is known, the page's
  "Sign in again" action carries the RFC 6749 `error=access_denied` redirect
  so MCP connectors never hang. JSON stays the contract for
  token/register/API and `Accept: application/json`.

- Every "Continue with SSO" click now inserts its own login state with its
  own nonce and PKCE verifier instead of rewriting the pending row; earlier
  states stay valid until TTL, keeping the Back button safe.

## 0.13.0 - 2026-07-23

### Added

- Role presets for API keys (no migration): `POST /v1/api-keys` accepts
  `role: reader | contributor | reviewer` as an alternative to explicit
  scopes — three understandable bundles instead of a least-privilege maze.
  Roles expand to scopes at creation time and are never stored; scopes stay
  the only ground truth. Deliberately no `approver` preset:
  `knowledge:approve` remains an explicit, spelled-out grant.

- Cross-space federation (migration `0023_wk_space_refs`): relations can now
  point at concepts in OTHER spaces via qualified `other-space:slug` targets
  — allowed only when the target space is declared in the source space's
  `settings.imports` and the key can see both spaces (space-scoped keys get
  a deterministic 403), and only for targets that already exist as readable
  concepts (no cross-space writes, ever; citations stay strictly
  intra-space). Reads carry provenance (`relations[].space`; foreign targets
  are elided for space-scoped keys), search gains
  `include_imports=true` (fan-out over declared imports, every hit tagged
  with its origin `space` plus `searched_spaces`), briefings qualify
  concepts as `space:slug` and the context selector may add import-declared
  spaces at lower priority. A new `broken-cross-space-links` lint rule
  (warn) flags dangling `[[space:slug]]` markdown links. Knowledge is never
  copied between spaces.

- Richer claim semantics (migrations `0021_wk_claim_semantics` +
  `0022_wk_apply_claim_semantics`): claims can carry explicit temporal validity
  (`valid_from`/`valid_until` — written only when the source states them),
  a `context` partition of the frame (`region:eu`, `v2.x`), server-computed
  normalized objects (typed predicate registry
  `settings.predicate_defs` with explicit unit-conversion factors — no
  built-in ontology) and a staged, reviewer-visible `supersedes_claim_id`.
  The contradiction rule is now interval-, context- and normalization-aware
  everywhere it lives (pre-review matcher, staged-content lint, space lint,
  approval flip): disjoint validity is succession, not contradiction;
  `1 GiB` no longer contradicts `1024 MiB`; different regions coexist.
  Approval executes supersession deterministically (deprecate the target +
  `supersedes` relation; `claims_deprecated` in the result). Subject aliases
  (`settings.aliases`) resolve once at staging — stored claims are always
  canonical. The previously unwired `adjudicate.v1` prompt is now live: the
  pipeline classifies persisted-side frame collisions (capped per job,
  fail-open to the dispute path) — `complementary` verdicts exempt the claim
  from the dispute flip, `temporal` verdicts stage the supersession, and the
  proposal summary reports supersessions separately from contradictions.
  The synthesize prompt is evolved in place (temporal/context extraction,
  typed vocabulary rendering) — golden snapshots carry the reviewed diff.

- Review operations (migration `0020_wk_review_operations`): pending
  proposals can be **split** — fully (one pending child per concept plus one
  for decisions, parent → new terminal status `split`) or partially
  (**defer**: named concepts move to one child while the parent keeps its id
  and remainder) — via `POST /v1/proposals/{id}/split` (`knowledge:review`),
  atomically re-pointing every staged row including relation-removal
  markers. **Request-changes** (`POST /v1/proposals/{id}/request-changes`,
  note mandatory) rejects terminally with a machine-readable
  `changes_requested` flag — agents read the note as the revision brief for
  a fresh proposal. New `GET /v1/proposals/{id}/lint` checks STAGED content
  (uncited claims, frame collisions, stale base, dangling relation targets).
  The proposal wire gains `changes_requested`, `parent_proposal_id`,
  resolved `sources`, per-concept `stale` and full `claims` with citation
  quotes; new webhook events `wikikit.proposal.split` and
  `wikikit.proposal.changes_requested`.
- The human review page grew into a thin knowledge-ops surface: real line
  diffs (dependency-free LCS, CSP unchanged — zero external bytes), claims
  tables with expandable citation quotes and collision highlighting, a
  stale-base banner naming the moved concepts and the re-ingest remedy,
  staged-content lint, resolved sources, per-concept defer buttons and a
  request-changes action. Review-only keys (`knowledge:review`) can inspect,
  defer and request changes; approve/reject stay `knowledge:approve`.

- Versioned source-sync contract for external connectors (migration
  `0019_wk_source_sync`): ingest accepts `external_source_id`,
  `source_version`, `observed_at` and `effective_at`; every external
  document gets a `wk_source_streams` row (mutable head pointer + latest
  version + tombstone) while `wk_sources` stays a fully immutable
  append-only archive with write-once `supersedes_source_id` chains.
  Idempotent re-sync semantics: known content answers
  `200 {status:'unchanged'}` (head advance, no LLM) instead of 409 —
  connectors retry blindly; re-using a version marker for different content
  is a loud `409 sync_version_conflict`; content reverts move the head back
  without new rows. New endpoints `GET /v1/spaces/{space}/source-streams`
  and idempotent `DELETE /v1/spaces/{space}/source-streams/{external_source_id}`
  (tombstone; emits `wikikit.source.tombstoned`, resurrected by a later
  push). Tombstones never touch claims automatically — the new
  `tombstoned-sources` lint rule (warn) surfaces visible claims citing
  upstream-deleted documents for human review. Ingests without an external
  id keep today's semantics byte-for-byte.

- Optional hybrid retrieval (migration `0018_wk_embeddings`): with pgvector
  installed and `WIKIKIT_EMBEDDING_PROVIDER=openai|google` configured
  (Anthropic has no embeddings API), a background embedder fills a
  `wk_embeddings` side table for current revisions, visible claims and
  source chunks, and searches fuse the lexical and cosine arms via
  Reciprocal Rank Fusion (k=60) — deterministic, explainable
  (`matched_via: lexical|vector|both` on every hit), with visibility
  restated in the vector arm so proposed content stays invisible by
  construction. Everything degrades to pure lexical retrieval without
  pgvector, without a provider, or on any embedding failure — search never
  returns 503 because of embeddings. Local/CI Postgres image moves to
  `pgvector/pgvector:pg18` (plain-postgres deployments keep working: all
  vector DDL is guarded).

- Two retrieval tiers (migration `0017_wk_source_chunks`): archived sources
  are now chunked into a persisted, per-source-language retrieval index
  (`wk_source_chunks`, written at archive time and healed for existing
  sources by a background scan worker). Search and `/query` accept
  `mode: approved_only | approved_then_sources` — the default stays
  byte-identical to today; the opt-in mode appends archived source chunks as
  a separate `tier: 'source_evidence'` after every approved hit, never
  interleaved. Query answers (answer prompt evolved in place) must label statements
  grounded only in source evidence as uncurated and cite them as
  `[source:<id>]`; the wire gains `source_citations`. A found chunk feeds
  straight back into curation: proposal citations now accept `{ chunk_id }`,
  resolved server-side to the canonical `{source_id, verbatim quote}`.
  Ingest accepts an optional per-source `language` override.

- Multilingual search (migration `0016_wk_search_multilingual`): the space
  setting `settings.language` (`en` | `de` | `simple`, default `en`) now
  selects the PostgreSQL text search configuration per space — the v0.2
  landing zone named in migration 0001 becoming real. New configurations
  `wk_english`/`wk_german` install `unaccent` as a filtering dictionary, so
  indexing, `websearch` query parsing and headlines are accent-insensitive
  symmetrically; a query-side repair strips the German stopwords that
  survive unaccenting (`für` → `fur` etc.) from parsed queries. `pg_trgm`
  adds a deterministic typo-tolerance arm on concept slugs and titles with
  fixed, documented rank constants. Sources gain a nullable `language`
  column for per-source overrides. Changing a space's language recomputes
  its search vectors via the new whitelisted `wk_reindex_space` function.
  The migration re-vectorizes every existing revision and claim once — on
  large deployments expect the migration to hold locks noticeably longer
  than previous ones.
- German retrieval-quality benchmark: a seeded corpus and 30 golden queries
  with reviewed gating thresholds
  (`test/fixtures/retrieval/{corpus,golden}.de.json`), a CI gate
  (`test/integration/retrieval-eval.test.ts`, RUN_INTEGRATION=1) and a
  verbose tuning table (`bun scripts/retrieval-eval.ts`). Measured effect of
  the multilingual migration on the German set: recall@10 and MRR moved from
  0.467 (english stemming) to 0.967.

## 0.12.2 - 2026-07-23

### Changed

- Remove concrete production-domain and sibling-product references from the
  public documentation and enforce that boundary with a repository guard test.

## 0.12.1 - 2026-07-23

### Fixed

- Express the capture hook's transcript readability guard as an explicit
  conditional so the shipped shell hook passes the same ShellCheck gate used
  by CI.

## 0.12.0 - 2026-07-23

### Added

- Ship the missing UserPromptSubmit example hook (`wikikit-context.sh`) —
  per-prompt space selection via `POST /v1/agent/context`, reading the
  optional `.wikikit/agent.json` manifest — plus PowerShell 5.1 counterparts
  of all three lifecycle hooks (`wikikit-briefing.ps1`, `wikikit-context.ps1`,
  `wikikit-capture.ps1`) so native Windows needs no Git Bash, jq or Node.
- Serve an embedded agent hooks installer from every WikiKit server:
  `GET /install.sh` (strict POSIX, rustup-style, curl→wget fallback) and
  `GET /install.ps1` (PowerShell 5.1, TLS 1.2), with the six hook scripts
  individually downloadable at `GET /install/hooks/{script}`. The installer
  detects Claude Code, Codex and Cursor, merges hook entries without ever
  clobbering existing configuration, is idempotent on re-run, supports
  `--uninstall`, and keeps secrets in `~/.wikikit/env` (chmod 600) instead of
  harness configs.
- Document Cursor as a lifecycle-capable harness (hooks.json `version: 1`,
  `sessionStart`/`beforeSubmitPrompt`/`stop`) alongside Claude Code and Codex
  in the coding-agent integration guide and both LLM documents.

### Changed

- All example hooks source `~/.wikikit/env` (environment variables still win),
  so harness configs stay bare script paths with no inline secrets.
- Make OIDC identity subject-first: `sub` is mandatory, while email is optional
  and used only with `email_verified=true`. Each provider must still explicitly
  allow the exact subject, a verified email, or both.

## 0.11.0 - 2026-07-22

### Changed

- Make API-key and direct OIDC the complete WikiKit-owned MCP authentication
  model. WikiKit owns its OIDC client, callback, policy, sessions and secrets;
  no shared or externally hosted cross-product auth component is supported.
- Keep the family-wide SSO-first UI and public provider-neutral contract while
  implementing and configuring every auth operation inside WikiKit itself.
- Update README, contracts, configuration, OpenAPI and both LLM documents to
  the corrected independent-product architecture.

### Removed

- Remove the hosted assertion-adapter protocol and its POST callback surface.

## 0.10.0 - 2026-07-22

### Added

- Publish the complete common MCP-auth OpenAPI contract, including safe
  provider discovery and provider-neutral assertion exchange at
  `POST /v1/identity/sessions` with the shared
  `{api_key,principal_id,context_id,email}` response.
- Verify OIDC identity assertions through issuer discovery, pinned audience,
  cached remote keys, verified email and WikiKit's explicit identity policy.

### Changed

- Upgrade every WikiKit login and consent page to `mcp-auth-v2`, byte-identical
  shared styles, an opaque `login_state` handoff, and the fixed user actions
  `Continue with SSO` then `Continue with API key`.
- Keep configured provider labels and products out of the UI and public route
  model while preserving WikiKit-owned scopes, spaces, data and deployment.
- Update README, contracts, configuration, OpenAPI and both LLM documents to
  the exact common auth operation and schema contract.

### Removed

- Retain no provider-named routes, response aliases or compatibility parsing.

## 0.9.3 - 2026-07-22

### Changed

- Make all browser-auth examples and historical auth descriptions use only
  provider-neutral protocols, ids and endpoints.
- Extend the architecture contract to reject concrete provider products in
  both the auth runtime and its operator documentation.

## 0.9.2 - 2026-07-22

### Changed

- Replace the remaining provider-specific bootstrap migrations with a
  provider-neutral external-identity baseline and structural provider metadata.
- Extend the architecture contract to scan embedded migration sources so a
  clean installation cannot pass through a retired provider-specific schema.

### Migration

- Existing installations rename the two historical migration journal tags
  once before the binary cutover. The already-neutral production schema and
  all knowledge data remain unchanged; WikiKit backfills only the new hashes.

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
  key plus multiple named direct OIDC adapters concurrently;
  provider products are configuration values rather than WikiKit modes.
- Apply verified-email and explicit allow-list policy to direct OIDC adapters
  without adding provider-specific branches.
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
  consistently: product-local API-key and direct OIDC providers,
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
- Remote MCP OAuth supports standard OIDC Authorization Code + PKCE providers
  and a provider-neutral chooser.
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

- OIDC-authenticated MCP consent preserves the original PKCE challenge across
  browser login, allowing the authorization-code exchange to complete.

## 0.1.11

### Changed

- Remote MCP OAuth can use direct OIDC. WikiKit verifies the identity and an
  explicit email allow-list before showing OAuth consent, so ChatGPT need not
  receive a WikiKit operator API key.

### Security

- OIDC login states are opaque, single-use and server-stored. OAuth grants
  remain scoped, refresh rotation remains intact, and an inactive external
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
