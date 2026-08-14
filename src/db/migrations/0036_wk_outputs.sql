-- wk_outputs — what the knowledge base PRODUCED: answers, briefings, health
-- reports. The fourth place in the loop, next to sources (what came in),
-- concepts (what is known) and proposals (what is pending).
--
-- WHY it exists: until now a /query answer existed only in the caller's chat
-- window; the sole trace was the wk_agent_runs audit row, which records that a
-- model call happened but not what it said. Nothing could be re-read, nothing
-- could be handed to a colleague, and — the load-bearing part — nothing could
-- be fed back into the wiki. A good answer is evidence about the domain, and
-- the loop is only closed when it can become a source like any other.
--
-- WHAT THIS IS NOT:
--   * NOT knowledge. Rows here are never read as evidence by synthesis or by
--     /query. Visible knowledge stays concepts+claims behind the review gate;
--     an output is a derived artifact and stays outside that boundary until a
--     human promotes it (promoted_ingest_id), at which point it travels the
--     ORDINARY ingest path and gets an ordinary proposal. Automatic feedback
--     would let a synthesized answer become the source of the next answer.
--   * NOT an archive of record. wk_sources is verbatim and forever; outputs are
--     regenerable and expire (WIKIKIT_OUTPUT_RETENTION_DAYS) — but only while
--     unpromoted, because a promoted output's markdown lives on as a source.
--   * NOT the audit ledger. wk_agent_runs keeps the model/usage/prompt-version
--     accounting; agent_run_id only links the two so an answer can be traced
--     back to the call that produced it.
--
-- WHY one table for three kinds instead of three tables: they differ only in
-- how they were produced (a query, the scheduler's daily roll-up, the health
-- composition) — not in shape, lifecycle, retention, or the promote path. The
-- CHECK keeps the set closed; adding a kind is a migration on purpose, because
-- every kind must answer "is this promotable evidence".
create table if not exists public.wk_outputs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  kind text not null
    check (kind in ('answer', 'briefing', 'health')),
  title text not null,
  -- Only kind='answer' has one; a briefing answers no question.
  question text,
  markdown text not null,
  -- [{slug,title}] of the concept pages the answer cited. Denormalized on
  -- purpose: this is what the output SAID at the time, so a later rename or
  -- deletion of a page must not rewrite history (and must not FK-block it).
  citations jsonb not null default '[]'::jsonb,
  -- Tri-state: true/false for answers (the honest "not covered" flag), null for
  -- kinds where the question does not arise.
  not_in_knowledge_base boolean,
  -- Audit chain into the model call. `set null` on both pointers: these are
  -- provenance links, and a future retention sweep over runs or jobs must not
  -- be blocked by an output row that merely remembers them.
  agent_run_id uuid references public.wk_agent_runs(id) on delete set null,
  -- Set by promote — the ingest job whose proposal a human will review. Non-null
  -- is therefore also the "this row is no longer collectable" marker.
  promoted_ingest_id uuid references public.wk_ingest_jobs(id) on delete set null,
  promoted_at timestamptz,
  created_at timestamptz not null default now()
);

-- The two access patterns, both newest-first: the archive list per space, and
-- the same list filtered to one kind ("show me the briefings"). Keyset
-- pagination orders by (created_at desc, id desc), which these serve.
create index if not exists wk_outputs_space_created_idx
  on public.wk_outputs (space_id, created_at desc);

create index if not exists wk_outputs_space_kind_created_idx
  on public.wk_outputs (space_id, kind, created_at desc);
