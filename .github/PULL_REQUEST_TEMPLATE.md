# What & why

<!-- What does this change and what problem does it solve? Link the issue. -->

## Checklist

- [ ] `bun run lint && bun run typecheck && bun test` passes locally
- [ ] Tests added/updated for behavior changes
- [ ] `RUN_INTEGRATION=1 bun run test:integration` passes if the schema, SQL functions, auth, or the HTTP/MCP servers changed (needs Docker)
- [ ] `bun run gen:migrations` run if `src/db/migrations/*.sql` changed (embedded-drift test enforces)
- [ ] Docs kept in lockstep if routes, env vars, or MCP tools changed — `docs/CONFIGURATION.md`, `docs/llms.txt`, `docs/llms-full.txt`, `docs/openapi.json` (drift tests enforce)
- [ ] Contract snapshot diffs (`test/contract/__snapshots__/`) are intentional — they are the API foreign systems rely on
- [ ] No new runtime dependencies (or justified — each must survive `bun build --compile`)
