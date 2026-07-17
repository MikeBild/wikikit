# Contributing to WikiKit

Thanks for taking the time to contribute! WikiKit is a small, focused
project — contributions of every size are welcome, from typo fixes to new
features.

## Development setup

Requirements: [Bun](https://bun.sh) 1.1+ and Docker Desktop (for local
PostgreSQL).

```bash
bun install
bun run dev
```

`bun run dev` boots a zero-config local stack: PostgreSQL 16 in Docker
(container `wikikit-local-postgres`, port `55442`), self-applied migrations,
a `default` space and a one-time-printed bootstrap API key, with the API on
`http://127.0.0.1:4060`. No `.env` file is needed — development defaults come
from the committed `.env.defaults`. Reset all local data with
`bun scripts/reset-local.ts`.

## Running checks

One command runs everything CI runs:

```bash
bun run gate
```

Install it as a `pre-push` hook once per clone, and you cannot push something
that CI will reject:

```bash
bun run hooks:install     # sets core.hooksPath=.githooks
```

The gate needs Docker (for the integration and e2e tiers) and takes ~60s. If
Docker is off it **fails loudly** rather than quietly checking less than you
think. Deliberate bypasses are honoured and printed in the summary:

```bash
SKIP=integration,e2e bun run gate    # or: SKIP=integration,e2e git push
git push --no-verify                 # skip the hook entirely
```

The individual tiers, cheapest first:

```bash
bun run lint              # ESLint + Prettier
bun run typecheck         # tsc --noEmit (strict)
bun test                  # unit + contract — no external services
bun run test:integration  # real PostgreSQL via Docker    (RUN_INTEGRATION=1)
bun run test:e2e          # real AI SDK → stub endpoint    (RUN_INTEGRATION=1)
bun run bench             # deterministic benchmarks — reports, never gates
bun run build:binary      # compile + self-verify dist/wikikit
```

Format with `bun run format` before committing.

### Which tier does a change need?

Each tier exists because the one below it cannot see a whole class of bug.
Write the cheapest test that can actually fail for your change:

| Tier            | Runs against                                      | Catches what nothing else can                                                                  |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **unit**        | FakeProvider, no I/O                              | Logic and branches. Also the drift gates: docs, env templates, tool lists, prompt budgets.     |
| **contract**    | Snapshots of what foreign systems consume         | A silent break in the OpenAPI document, MCP manifest, webhook payloads or OKF bundles.         |
| **integration** | Real Docker PostgreSQL, FakeProvider              | SQL, constraints, migrations, transactions — everything a fake database cannot be wrong about. |
| **e2e**         | Real `ai` + `@ai-sdk/anthropic` → a stub endpoint | The vendor edge: request shape, `cache_control` placement, usage mapping, error mapping.       |
| **bench**       | Nothing — it reports                              | Nothing. It measures; the cost gate that _does_ fail is `test/unit/prompt-budget.test.ts`.     |

The split that matters: **integration** injects `FakeProvider`, so everything
between our code and the vendor is untested there. **e2e** replaces the vendor's
HTTP endpoint instead (`config.anthropicBaseUrl` → `test/e2e/llm-stub.ts`), so
the real SDK code path executes. A dependency bump that breaks prompt caching —
a 5x bill, and nothing else fails — is only visible in e2e.

## Conventions

- TypeScript strict ESM on Bun — no build step in dev; Bun runs the TS
  directly.
- Factory-function dependency injection: `createX(config, deps)` — no classes
  with singletons.
- zod v4 validation at every boundary (HTTP, MCP tool input, LLM structured
  output).
- Explain **why** in comments, not what — design rationale belongs next to
  the code it justifies.
- Tables are prefixed `wk_`, API keys `wk_`, environment variables
  `WIKIKIT_*`.
- WikiKit is headless: no CLI commands (only the `--migrate`/`--version` ops
  flags) and no web UI. New capabilities land as REST routes and/or MCP
  tools over the same domain functions.

## Making changes

- Open an issue first for anything larger than a small fix, so we can agree
  on the approach before you invest time.
- Follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat: …`, `fix: …`, `docs: …`, `chore: …`).
- Add or update tests for behavior changes — see
  [which tier does a change need?](#which-tier-does-a-change-need) above.
  Contract snapshots (OpenAPI, MCP manifest, webhook payloads, OKF bundles)
  are what foreign systems rely on: changing one requires a deliberate
  snapshot commit.
- **Interface changes start in [`docs/CONTRACTS.md`](docs/CONTRACTS.md)** —
  the binding contract document wins over code on interface details; change
  it first, then the implementation.
- If you change the HTTP API, update the `ROUTES` registry, run
  `bun scripts/gen-openapi-doc.ts` and commit the regenerated
  `docs/openapi.json`; keep the endpoint lists in `docs/llms.txt` and
  `docs/llms-full.txt` in sync — the drift tests enforce all of this.
- If you add or change a `WIKIKIT_*` environment variable, document it in
  `docs/CONFIGURATION.md` **and** `docs/llms-full.txt` (drift-tested), and
  update `.env.example`/`.env.defaults`.
- If you add a migration, add ordered `.sql` files plus a journal entry under
  `src/db/migrations/` and run `bun run gen:migrations` to regenerate the
  embedded bundle.
- If you change a prompt, add a **new** version constant and prompt file
  (`synthesize.v2`, …) — prompt regression is product regression, and the
  version is part of every row's audit trail.

## Pull requests

Keep pull requests focused on one change. Describe what changed and why; link
the related issue. CI must pass before review.

## Reporting bugs and requesting features

Use the issue templates. For security vulnerabilities, do **not** open a
public issue — see [SECURITY.md](SECURITY.md).
