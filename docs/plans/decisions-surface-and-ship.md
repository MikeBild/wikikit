# Plan: Decisions read surface (full consistency) + ship to GitHub/PROD

## Context

Decisions are staged (ingest meeting mining, manual proposals) and applied
(`wk_apply_proposal`), and they export to the markdown/OKF tree — but there is
**no read surface**: no REST route, no MCP tool. This closes that gap with full
consistency across ROUTES, handlers, zod schemas, OpenAPI, MCP palette, docs
(llms.txt / llms-full.txt / ARCHITECTURE / CONTRACTS), and tests, then ships:
private GitHub repo, push, tagged release with binaries, PROD deploy + verify.

## Part A — Decisions read surface

Domain already provides `listDecisions(db, spaceId, {limit})` and
`getDecision(db, spaceId, {slug})` (`src/domain/decisions.ts`, tested). Only the
transports + docs are missing.

1. **`src/http/schemas.ts`**: add `zDecisionParams` (space+slug, CONCEPT_SLUG),
   `zDecisionSummary`, `zDecisionListResponse`, `zDecisionResponse`; register the
   three response/param schemas in `SCHEMAS`.
2. **`src/http/routes.ts`**: two ROUTES entries after the sources block —
   `GET /v1/spaces/{space}/decisions` (`listDecisionsHandler`, `zListQuery` →
   `zDecisionListResponse`) and `GET /v1/spaces/{space}/decisions/{slug}`
   (`getDecisionHandler` → `zDecisionResponse`); two handlers; import the domain
   fns. Both `knowledge:read`.
3. **`src/mcp/tools.ts`**: `zDecisionsToolInput` (space + optional slug) and a
   `wikikit_decisions` read tool mirroring `wikikit_sources` (slug → one
   decision, no slug → list); import `listDecisions`/`getDecision`.
4. **Docs (drift-gated)**: add both endpoints to `llms.txt` and the
   `llms-full.txt` endpoint table; add `wikikit_decisions` to the llms tool
   lists; a line in ARCHITECTURE module map / surfaces; the routes + schemas +
   tool in CONTRACTS; regenerate `docs/openapi.json`.
5. **Tests**: unit handler coverage; integration wire test (approve a meeting
   ingest → `GET /decisions` lists it, `/decisions/{slug}` returns it, proposed
   invisible); MCP integration test for `wikikit_decisions`; update
   mcp-manifest + openapi snapshots deliberately.

Gate: `bun run lint`, `bunx tsc --noEmit`, `bun test test/unit test/contract`,
`RUN_INTEGRATION=1 bun test test/integration` — all green.

## Part B — Ship

6. `gh repo create MikeBild/wikikit --private --source=. --remote=origin`,
   push `main`.
7. Tag `v0.1.0`, push tag → `release.yml` builds `wikikit-linux-x64` +
   `wikikit-macos-arm64` + `SHA256SUMS` and creates the GitHub release
   (fallback: local `build-binary.sh` + `gh release create`).
8. **Deploy** via the deploy repo (own the droplet): verify prerequisites
   (`doctl auth`, `.env.deploy`, ssh) first; `scripts/deploy-wikikit/bootstrap.sh`
   (DNS, user, PG db, `/etc/wikikit/.env`) then `deploy.sh <tag>`. If a
   prerequisite/secret is missing, stop and report the exact operator step —
   never invent production secrets.
9. **Verify**: `smoke.sh` + `e2e.sh` against `https://wikikit.mikebild.dev`.

## Non-negotiables carried

Space scoping on every query; `knowledge:read` scope on the new surface;
proposed/`rejected`-staged decisions never visible (domain enforces
`status IN (active,superseded)`); zod at both boundaries; snapshot changes are
deliberate, reviewed diffs.
