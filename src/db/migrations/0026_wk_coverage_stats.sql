-- Coverage-insight primitives for the maintainer report
-- (GET /v1/spaces/{space}/stats/coverage):
--
--   * wk_concept_reads — per-day aggregate counters for EXPLICIT concept
--     reads (REST read_concept + MCP wikikit_read). Internal loads (answer
--     evidence, ingest pipeline) never count. Deliberately actor-free: a
--     counter per (concept, day) can never profile a reader, so it lives
--     outside the wk_usage_events privacy envelope.
--   * wk_coverage_gaps — opt-in via WIKIKIT_COVERAGE_GAP_TOPICS_ENABLED
--     (default off): when /query answers honestly that the base does not
--     cover a question, the question's STEMMED LEXEMES (space search config:
--     stopwords stripped, words stemmed) are stored — never the question
--     text. Rows expire with the usage retention window.
create table if not exists public.wk_concept_reads (
  concept_id uuid not null references public.wk_concepts(id) on delete cascade,
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  day date not null,
  reads integer not null default 0,
  primary key (concept_id, day)
);

create index if not exists wk_concept_reads_space_day_idx
  on public.wk_concept_reads (space_id, day);

create table if not exists public.wk_coverage_gaps (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  lexeme text not null check (char_length(lexeme) between 1 and 60),
  created_at timestamptz not null default now()
);

create index if not exists wk_coverage_gaps_space_created_idx
  on public.wk_coverage_gaps (space_id, created_at);
