# WikiKit

[![CI](https://github.com/MikeBild/wikikit/actions/workflows/ci.yml/badge.svg)](https://github.com/MikeBild/wikikit/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/MikeBild/wikikit)](https://github.com/MikeBild/wikikit/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A headless, AI-native knowledge system for humans and agents.**
Markdown-first knowledge in, structured and agent-ready knowledge out.

WikiKit implements the LLM-wiki loop Andrej Karpathy sketched: you (or your
agents) feed in raw material — notes, articles, meeting minutes, incident
reports — and an LLM maintains a curated wiki from it. Sources are archived
verbatim, the model synthesizes concept pages with **verifiable claims and
citations**, contradictions are detected instead of papered over, and every
change lands as a **ChangeProposal in a human review gate**. Nothing becomes
knowledge without approval; everything that does carries its provenance
(source, model, prompt version) forever.

The point is **curation over collection** — not hoarding, but finding. A
knowledge base you never prune or verify is a write-only archive; WikiKit
keeps the wiki small, cited, disputed-where-disputed, and therefore usable as
trusted context for the next agent.

It is deliberately headless: **no CLI, no web UI** — the interfaces are an
HTTP/REST API ([OpenAPI 3.1](docs/openapi.json)) and an
[MCP server](https://modelcontextprotocol.io) (Streamable HTTP at `/mcp`), so
humans work through curl/clients and agents work through tools. Knowledge is
portable: export/import as an Obsidian-friendly Markdown tree or as an
[OKF](docs/okf-v0.1.md) (Open Knowledge Format) bundle. Production is a single
self-contained binary.

## Quickstart

Requirements: [Bun](https://bun.sh) 1.1+ and Docker Desktop (dev database).
Prefer a binary? Grab one from [Releases](https://github.com/MikeBild/wikikit/releases)
and run `./wikikit` — it does everything `bun run dev` does below.

**1. Configure.** Only two things are worth setting before the first start:

```bash
git clone https://github.com/MikeBild/wikikit.git
cd wikikit
bun install

cat > .env <<'EOF'
# Turning raw sources into concepts is an LLM job. Without a key, ingest and
# query answer 503 — every other feature still works. Using openai or google
# instead? Set WIKIKIT_LLM_PROVIDER and that provider's key. See docs/CONFIGURATION.md.
ANTHROPIC_API_KEY=sk-ant-...
# Pin the admin key instead of hunting for the generated one in the log.
WIKIKIT_BOOTSTRAP_API_KEY=wk_local_dev_key
EOF
```

**2. Start.** Zero-config: the first start provisions a dedicated Docker
PostgreSQL, migrates itself and creates a `default` space.

```bash
bun run dev
```

**3. Run the loop.** Every step is a plain curl:

```bash
export WK="http://127.0.0.1:4060" KEY="wk_local_dev_key"

# 1. Ingest a note — async: 202 + a Location header. Keep the ingest_id.
ING=$(curl -s -X POST "$WK/v1/spaces/default/ingest" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"markdown":"# OKF\nOKF is a draft spec for knowledge bundles.","title":"OKF note"}' \
  | jq -r .ingest_id)

# 2. Poll until done (or failed). Done always carries source_id; proposal_id is
#    nullable when classification finds no affected/new knowledge to review.
#    → {"ingest_id":"...","status":"done","proposal_id":null,"source_id":"...","error":null}
PROP=$(curl -s "$WK/v1/ingests/$ING" -H "Authorization: Bearer $KEY" | jq -r .proposal_id)

# 3. Review the structured diff (also human-readable via Accept: text/markdown)
curl -s "$WK/v1/proposals/$PROP" -H "Accept: text/markdown" -H "Authorization: Bearer $KEY"

# 4. Approve — the deliberate human act; now (and only now) it is knowledge
curl -s -X POST "$WK/v1/proposals/$PROP/approve" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"note":"looks right"}'

# 5. Use it: LLM-free search, or cited Q&A
curl -s "$WK/v1/spaces/default/search?q=okf" -H "Authorization: Bearer $KEY"
curl -s -X POST "$WK/v1/spaces/default/query" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"question":"Is OKF production ready?"}'
```

Have a PDF, DOCX or XLSX instead? Send it as the raw body — the extension
picks the extractor, the rest of the loop is identical:

```bash
curl -s -X POST "$WK/v1/spaces/default/ingest/document?filename=report.pdf" \
  -H "Authorization: Bearer $KEY" --data-binary @report.pdf
```

Example sources to ingest are in [`examples/`](examples/README.md).

Product analytics are available at `/v1/spaces/{space}/stats/*`. Existing
resources cover ingest, graph growth, LLM and webhook operations; opt-in usage
resources add actual HTTP, search/read/query/proposal and review behavior.
Global MCP sessions/protocol/tool usage is available to admins at
`GET /v1/stats/mcp`. All readers query WikiKit's own PostgreSQL data and return
bounded aggregates only. Content, prompts, search/question text, MCP
arguments/results, raw paths/query strings, network identifiers, credentials
and dynamic resource ids are never captured.

Enable the usage ledger explicitly with
`WIKIKIT_USAGE_TELEMETRY_ENABLED=true` and an independent
`WIKIKIT_USAGE_HMAC_SECRET`; it is off by default. Actor/session ids are
product-local HMACs, anonymous HTTP is never fingerprinted, raw events expire
after `WIKIKIT_USAGE_RETENTION_DAYS` (default 90), and the collector can mark
authenticated canaries with `X-WikiKit-Traffic-Class: synthetic`. See
[Configuration](docs/CONFIGURATION.md) for the privacy and query contract.
`GET /v1/spaces/{space}/lint` remains the current data-quality surface.

### Troubleshooting

| Symptom                                  | Cause and fix                                                                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `503 llm_not_configured` on ingest/query | No API key for the selected provider. The error names the variable to set (`ANTHROPIC_API_KEY` by default); restart afterwards. LLM-free features are unaffected.                                     |
| Lost the bootstrap key                   | It is printed **once** and never again while a key exists. Set `WIKIKIT_BOOTSTRAP_API_KEY` in `.env` and restart, or wipe local state with `bun scripts/reset-local.ts` (**deletes all local data**). |
| Boot fails on the database               | Docker Desktop is not running — WikiKit provisions its Postgres container (port `55442`) at first start. Start Docker, then retry.                                                                    |
| `409 already_ingested`                   | The identical content is already a source (sha256 dedup). Nothing to do — read the affected concepts instead.                                                                                         |
| `401` / `403`                            | Key missing, or missing a scope. Bootstrap keys hold `*`; minted keys hold only what you asked for (see [Connect an agent](#connect-an-agent-mcp)).                                                   |

### Glossary

- **Space** — an isolated knowledge base with its own concepts, sources and
  keys. `default` is created at first start; it is the `{space}` in every path.
- **Source** — raw material you fed in (note, article, PDF, URL), archived
  verbatim and never rewritten. Everything else cites it.
- **Concept** — a maintained wiki page about one thing, synthesized from
  sources. What you read and search.
- **Claim** — one `subject / predicate / object` statement on a concept, with
  confidence and a verbatim quote from a source.
- **ChangeProposal** — staged changes awaiting review. Invisible to readers
  until approved; the only way anything becomes knowledge.
- **Revision** — one approved version of a concept. The history carries which
  model, prompt version and sources produced it.
- **OKF** — [Open Knowledge Format](docs/okf-v0.1.md), the portable bundle
  format for export/import.

## Connect an agent (MCP)

The built-in **[agent guide](docs/agent-guide.md)** explains setup by MCP
capability instead of by client brand. For the optional session lifecycle, see
**[coding-agent integration](docs/coding-agent-integration.md)**.

First mint a key for the agent. Don't hand it your bootstrap key — scopes are
how you keep approval a human act:

```bash
curl -s -X POST "$WK/v1/api-keys" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"agent","scopes":["knowledge:read","knowledge:propose"],"space":"default"}'
# → {"id":"...","key":"wk_...","scopes":[...],"space":"default"}   ← shown once

# Inventory never exposes plaintext keys or hashes; revocation is idempotent.
curl -s "$WK/v1/api-keys" -H "Authorization: Bearer $KEY"
curl -s -X DELETE "$WK/v1/api-keys/$KEY_ID" -H "Authorization: Bearer $KEY"
```

Then register WikiKit as a Streamable-HTTP MCP server. For a JSON-based MCP
configuration:

```json
{
  "mcpServers": {
    "wikikit": {
      "type": "http",
      "url": "http://127.0.0.1:4060/mcp",
      "headers": { "Authorization": "Bearer wk_..." }
    }
  }
}
```

### Remote interactive clients

Remote interactive clients should use OAuth 2.1 instead of receiving a
long-lived `wk_` key. WikiKit implements protected-resource discovery, dynamic
client registration, PKCE (`S256`), consent, rotating refresh tokens and
revocation at the same `/mcp` endpoint. Enter:

```text
https://wikikit.mikebild.dev/mcp
```

Choose OAuth. The single `WIKIKIT_OAUTH_PROVIDERS` JSON list can offer one
browser API-key adapter and any number of named `token_bridge` and `oidc`
adapters in the common WikiKit-branded auth card. Provider products are
configuration values, not WikiKit modes. JWT bridges can map safe dotted
subject, email and verification claim paths; OIDC adapters use discovery and
Authorization Code + PKCE.
The method chooser is the family-wide `mcp-auth-v2` contract: SSO is always
first as **Continue with SSO**, API-key fallback is always second as
**Continue with API key**, and configured provider labels never alter those
two actions. The same public surface is implemented independently by WikiKit,
ContentKit and SubKit: provider discovery, assertion exchange, generic
start/callback/logout, OAuth discovery, DCR, authorize/consent, token and
revocation. There are no provider-named routes or compatibility aliases.
WikiKit verifies the selected provider and admits
only the explicit provider/email allow-list. The operator session is
revocable, has an eight-hour idle/24-hour absolute limit, and the consent page
can switch accounts. The client receives only a scoped, short-lived token;
unrequested scopes are never displayed or granted and `knowledge:read` is a
mandatory requested baseline. `WIKIKIT_PUBLIC_URL` must
be the canonical HTTPS base URL in production because it is the OAuth issuer
and audience.

Non-browser clients discover the same configured methods with
`GET /v1/identity/providers`. A configured SSO assertion is exchanged only at
`POST /v1/identity/sessions` using
`{"provider_id":"<id>","identity_token":"<assertion>"}`. The response shape
is always `{api_key,principal_id,context_id,email}`; WikiKit returns a null
`context_id` because space access remains encoded in the issued key's scopes.

For a review-capable connector, select the discovered standard scopes
`knowledge:read`, `knowledge:propose`, `knowledge:review`,
`knowledge:approve` and `offline_access`; production must also allow
`knowledge:approve` through
`WIKIKIT_OAUTH_ALLOWED_SCOPES` (or that provider's `allowed_scopes`).
`wikikit_review_proposal` accepts only a proposal id and then opens a native
MCP form. The human — not the agent — selects approve or reject and enters the
optional audit note. The tool remains marked as destructive because accepting
the form performs the irreversible review write. Decline, cancel, timeout,
invalid response or a client without `elicitation.form` leaves the proposal
unchanged. MCP hosts may cache the scanned tool and scope contract: after this
tool change or a scope change, rescan or reconnect. Existing OAuth tokens
retain their original, narrower scopes.

The agent gets `wikikit_guide`, `wikikit_spaces`, `wikikit_briefing`, `wikikit_context`, `wikikit_search`, `wikikit_read`, `wikikit_sources`,
`wikikit_decisions`, `wikikit_history`, `wikikit_lint`, `wikikit_ingest`,
`wikikit_ingest_status`, `wikikit_propose`, `wikikit_proposals` and
`wikikit_review_proposal`. The two review tools are visible only with
`knowledge:review` (implied by `knowledge:approve`); the final decision is
collected with native form elicitation inside the tool call, while the REST
approve/reject endpoints still require `knowledge:approve` — mint agent keys
with `knowledge:review` so they can never approve over HTTP. Tools are scope-gated, so a read-only key simply does not
see write or review tools. The server also hands the agent its own documentation — usage
instructions on connect, a code-bundled system guide (also available as a tool
for tools-only clients), and `llms.txt` / `llms-full.txt` as MCP resources — so
it does not have to guess the model. Ask your agent to "take this article into
the wiki and check whether it changes our assessment" — it ingests, polls, and
reports the proposal with any detected contradictions; review and approve it
in the same MCP conversation.

For Codex, keep MCP elicitation interactive and routed to the person:

```toml
approval_policy = { granular = { mcp_elicitations = true } }
approvals_reviewer = "user"
```

Claude Code supports form elicitation from 2.1.76. ChatGPT connectors must be
reconnected and capability-checked; if ChatGPT does not advertise form
elicitation, `wikikit_review_proposal` performs no mutation, answers
`human_review_required` with a `review_url`, and leaves the proposal pending.
The human opens that link — WikiKit's embedded review page at
`GET /review/{id}` — and approves or rejects there with their own credential;
the agent reports the outcome from `wikikit_proposals`. Operators who trust a
connector's conversation channel can instead grant its key
`knowledge:approve`: the hand-off then sanctions executing the user's
explicit chat instruction over REST, quoted in the audit note. The REST review endpoints are for that human
operator directly, never for the agent or a connector acting for it.

## Features

- **Claims, not prose blobs:** every statement is `subject / predicate /
object` with a confidence, citations (verbatim quote + locator) and a
  lifecycle (`proposed → verified → disputed → deprecated`).
- **Grounding guard:** a claim survives only if its quote occurs **verbatim**
  in the source the model read. Paraphrased or invented citations are dropped
  before they reach the review gate, not argued about afterwards.
- **Contradiction detection:** for predicates explicitly declared in a space's
  `settings.functional_predicates`, same subject+predicate and a different
  object makes both claims `disputed` and links them with `contradicts`.
  Undeclared predicates are multi-valued, so complementary facts stay verified.
- **Review gate:** all writes — LLM ingest, agent proposals, bundle imports —
  stage as ChangeProposals; approval is an atomic SQL flip with stale-base
  protection and a full audit trail (reviewer, note, channel, timestamp).
- **Provenance everywhere:** revision history answers "which model, which
  prompt version, which sources, who approved" — decisions survive chat
  sessions and model swaps.
- **Decisions as first-class records:** meeting sources are mined for
  decisions (context, rationale, alternatives) — the decision-log pattern.
- **LLM-free core:** full-text search, lint (contradictions, missing
  citations, stale claims — CI-friendly), export/import all work without any
  LLM configured.
- **Any of three LLM providers:** Anthropic, OpenAI or Google — one config
  value (`WIKIKIT_LLM_PROVIDER`), no code change, via the Vercel AI SDK.
- **Feeds on real documents:** Markdown, text, a URL, or a PDF/DOCX/XLSX/CSV
  upload — all extracted to Markdown and archived verbatim.
- **Portable knowledge:** deterministic zip exports as a Markdown tree
  (claims round-trip losslessly via frontmatter, `[[wiki-links]]`,
  Obsidian-friendly) or as an OKF v0.1 bundle; imports pass the review gate.
- **Standard Webhooks:** signed events (`wikikit.proposal.created`, ...)
  from a transactional outbox — the seam for governance workflows.
- **Ops-grade:** scoped `wk_` API keys, per-space isolation, Prometheus
  `/metrics`, `/health` + `/ready` probes, structured logs, self-migrating
  single binary.

## Integration

WikiKit integrates **only over open standards** — no SDK, no shared code, no
direct dependencies:

- **REST / OpenAPI 3.1** (`/openapi.json`) — any client or agent framework can
  drive the full API; the spec is a ready-to-import connector.
- **MCP** (`/mcp`, Streamable HTTP) — agents search, read and propose through
  scope-gated tools.
- **Standard Webhooks** — any system can react to `proposal.created`,
  `proposal.approved`, `concept.updated`, `ingest.failed`.
- **OKF bundles** and the Obsidian-friendly Markdown tree — portable knowledge
  in and out.
- **llms.txt / llms-full.txt** — self-description for agents and crawlers.

Typical seams: a governance layer imports the OpenAPI connector and reacts to
`proposal.created` to run an approval workflow; a publishing pipeline posts an
approved concept out as an article; that published article is re-ingested by
URL and becomes a citable source.

## How it works

```
source ─▶ archive (sha256 dedup) ─▶ classify ─▶ synthesize per concept
       ─▶ detect contradictions ─▶ ONE pending ChangeProposal
       ─▶ human review ─▶ atomic apply ─▶ signed webhooks
```

PostgreSQL is the source of truth; proposal content is staged as real rows
that are structurally invisible to readers until an atomic status flip makes
them current. The OpenAPI document, the docs and the drift tests all derive
from one route registry, so the spec cannot lie. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full model, and
[docs/llms-full.txt](docs/llms-full.txt) for the complete API documentation in
one agent-readable file (served live at `/llms.txt` and `/llms-full.txt`).

## Documentation

| If you want to…                                | Read                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Try it out                                     | The Quickstart above, then [`examples/`](examples/README.md)                                           |
| Connect any AI agent without a WikiKit CLI     | [docs/agent-guide.md](docs/agent-guide.md) (live at `/agent-guide.md`)                                 |
| Add an optional dynamic coding-agent lifecycle | [docs/coding-agent-integration.md](docs/coding-agent-integration.md)                                   |
| Look up an environment variable                | [docs/CONFIGURATION.md](docs/CONFIGURATION.md)                                                         |
| Run it in production                           | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) + [SECURITY.md](SECURITY.md)                                  |
| Drive the API from your own client             | [docs/openapi.json](docs/openapi.json) (live at `/openapi.json`)                                       |
| Point an agent or crawler at the docs          | [docs/llms.txt](docs/llms.txt), [docs/llms-full.txt](docs/llms-full.txt) (live at `/llms.txt`)         |
| Understand how it works inside                 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                           |
| Know exactly what a subsystem must guarantee   | [docs/CONTRACTS.md](docs/CONTRACTS.md)                                                                 |
| Move knowledge in or out portably              | [docs/okf-v0.1.md](docs/okf-v0.1.md), [concept frontmatter](examples/concept-frontmatter-reference.md) |
| Contribute                                     | [CONTRIBUTING.md](CONTRIBUTING.md)                                                                     |
| See what changed                               | [CHANGELOG.md](CHANGELOG.md)                                                                           |

Production is one self-contained binary behind a reverse proxy; it migrates its
own database under an advisory lock at boot.

## Development

```bash
bun run gate            # everything CI runs, in ~60s (needs Docker)
bun run hooks:install   # ...and run it automatically on every git push
```

The gate is lint → typecheck → unit + contract → integration (real Postgres) →
e2e (the real AI SDK against a stub endpoint). Individual tiers, benchmarks and
the rule for which tier a change needs are in
[CONTRIBUTING.md](CONTRIBUTING.md).

An optional `.env` overrides the committed development defaults
(`.env.defaults`, never loaded in production). If you change the HTTP API,
regenerate the OpenAPI snapshot with `bun scripts/gen-openapi-doc.ts`; if you
add a migration, run `bun run gen:migrations` — drift tests enforce both.

## Versioning and license

WikiKit follows [Semantic Versioning](https://semver.org). Changes are
documented in the [CHANGELOG](CHANGELOG.md).

[MIT](LICENSE) © Mike Bild
