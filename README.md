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

```bash
git clone https://github.com/MikeBild/wikikit.git
cd wikikit
bun install
bun run dev
```

Zero-config: the first start provisions a dedicated Docker PostgreSQL,
migrates itself, creates a `default` space and prints a bootstrap API key
**once**. (A downloaded release binary does the same: just run `./wikikit`.)
Then run the loop:

```bash
export WK="http://127.0.0.1:4060" KEY="wk_..."   # the printed bootstrap key

# 1. Ingest a note — async: 202 + a Location header to poll
curl -s -X POST "$WK/v1/spaces/default/ingest" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"markdown":"# OKF\nOKF is a draft spec for knowledge bundles.","title":"OKF note"}'

# 2. Poll until done → carries a proposal_id
curl -s "$WK/v1/ingests/<ingest_id>" -H "Authorization: Bearer $KEY"

# 3. Review the structured diff (also human-readable via Accept: text/markdown)
curl -s "$WK/v1/proposals/<proposal_id>" -H "Accept: text/markdown" -H "Authorization: Bearer $KEY"

# 4. Approve — the deliberate human act; now (and only now) it is knowledge
curl -s -X POST "$WK/v1/proposals/<proposal_id>/approve" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"note":"looks right"}'

# 5. Use it: LLM-free search, or cited Q&A
curl -s "$WK/v1/spaces/default/search?q=okf" -H "Authorization: Bearer $KEY"
curl -s -X POST "$WK/v1/spaces/default/query" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"question":"Is OKF production ready?"}'
```

Ingest and query need `ANTHROPIC_API_KEY` (the only setting without a
default); **everything LLM-free — search, read, history, lint, export,
import, review — works without it.** Example sources to ingest are in
[`examples/`](examples/README.md).

## Connect an agent (MCP)

Register WikiKit in Claude Code / claude.ai as a Streamable-HTTP MCP server:
URL `http://127.0.0.1:4060/mcp`, header `Authorization: Bearer wk_...` (a key
with `knowledge:read,knowledge:propose`). The agent gets `wikikit_search`,
`wikikit_read`, `wikikit_sources`, `wikikit_history`, `wikikit_lint`,
`wikikit_ingest`, `wikikit_ingest_status` and `wikikit_propose` — and
deliberately **no approve tool**: agents write into the staging area,
promotion stays a human act over REST. Ask your agent to "take this article
into the wiki and check whether it changes our assessment" — it ingests,
polls, and reports the proposal with any detected contradictions; you approve
with one curl.

## Features

- **Claims, not prose blobs:** every statement is `subject / predicate /
object` with a confidence, citations (verbatim quote + locator) and a
  lifecycle (`proposed → verified → disputed → deprecated`).
- **Contradiction detection:** same subject+predicate, different object →
  both claims become `disputed`, linked by a `contradicts` relation; `/query`
  reports the dispute with sources instead of picking a winner.
- **Review gate:** all writes — LLM ingest, agent proposals, bundle imports —
  stage as ChangeProposals; approval is an atomic SQL flip with stale-base
  protection and a full audit trail (reviewer, note, timestamp).
- **Provenance everywhere:** revision history answers "which model, which
  prompt version, which sources, who approved" — decisions survive chat
  sessions and model swaps.
- **Decisions as first-class records:** meeting sources are mined for
  decisions (context, rationale, alternatives) — the decision-log pattern.
- **LLM-free core:** full-text search, lint (contradictions, missing
  citations, stale claims — CI-friendly), export/import all work without any
  LLM configured.
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

## Development

```bash
bun run lint
bun run typecheck
bun test                    # unit + contract
bun run test:integration    # real Docker PostgreSQL
bun run build:binary        # → dist/wikikit
```

An optional `.env` overrides the committed development defaults
(`.env.defaults`, never loaded in production). If you change the HTTP API,
regenerate the OpenAPI snapshot with `bun scripts/gen-openapi-doc.ts`; if you
add a migration, run `bun run gen:migrations` — drift tests enforce both. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Deployment

Production is one self-contained binary behind a reverse proxy; it migrates
its own database under an advisory lock at boot. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the checklist, systemd unit,
probes and the release pipeline, and [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
for every environment variable. Before exposing WikiKit, read
[SECURITY.md](SECURITY.md).

## Versioning and license

WikiKit follows [Semantic Versioning](https://semver.org). Changes are
documented in the [CHANGELOG](CHANGELOG.md).

[MIT](LICENSE) © Mike Bild
