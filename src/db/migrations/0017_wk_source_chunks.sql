-- Source-chunk index — the second retrieval tier (source evidence).
--
--   * wk_search covers APPROVED knowledge only (current revisions + visible
--     claims). Details that never made it into a synthesized concept were
--     unreachable: the verbatim archive existed but could not be searched.
--     This table makes archived sources retrievable WITHOUT weakening the
--     approval gate — chunk hits are a separate, explicitly labeled tier
--     ('source_evidence'), composed in TypeScript strictly AFTER approved
--     hits and only when the caller opts in (mode=approved_then_sources).
--   * Chunks are heading-aligned projections of wk_sources.markdown
--     (src/ingest/chunk.ts chunkForRetrieval — the single chunking
--     implementation; the backfill worker uses the same code, which is why
--     the backfill is app-level, not in-migration SQL).
--   * Rows are derived data: INSERT-only alongside the immutable source,
--     rebuilt by wk_reindex_space on language changes, healed by the scan
--     worker for sources predating this migration. unique(source_id,
--     chunk_index) makes persistence idempotent.
--   * Ranking stays in SQL behind the db.call whitelist (wk_search_sources),
--     mirroring wk_search. The two functions are never merged: ts_rank
--     values across different corpora are not comparable, and the tier
--     separation IS the explainability story.
create table if not exists public.wk_source_chunks (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  source_id uuid not null references public.wk_sources(id) on delete cascade,
  chunk_index int not null check (chunk_index >= 0),
  heading text,
  content text not null,
  tokens int not null check (tokens > 0),
  search_vector tsvector,
  created_at timestamptz not null default now(),
  unique (source_id, chunk_index)
);

create index if not exists wk_source_chunks_search_idx
  on public.wk_source_chunks using gin (search_vector);

create index if not exists wk_source_chunks_source_idx
  on public.wk_source_chunks (source_id);

create index if not exists wk_source_chunks_space_idx
  on public.wk_source_chunks (space_id);

-- INSERT-only trigger, like revisions/claims: chunk content is immutable
-- (it mirrors the immutable source); language changes go through
-- wk_reindex_space. Weights: heading=A, body=C — a heading match should
-- outrank a body match, but chunks never outrank title-weighted concept
-- vectors in their own tier anyway (tiers are ranked independently).
create or replace function public.wk_source_chunk_search_vector()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cfg regconfig := public.wk_source_search_config(new.source_id);
begin
  new.search_vector :=
       setweight(to_tsvector(cfg, coalesce(new.heading, '')), 'A')
    || setweight(to_tsvector(cfg, new.content), 'C');
  return new;
end;
$$;

drop trigger if exists wk_source_chunk_search_vector_insert on public.wk_source_chunks;
create trigger wk_source_chunk_search_vector_insert
  before insert on public.wk_source_chunks
  for each row execute function public.wk_source_chunk_search_vector();

-- wk_reindex_space grows the chunk arm (same signature; 0016 defined the
-- revisions/claims arms).
create or replace function public.wk_reindex_space(p_space_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  cfg regconfig := public.wk_space_search_config(p_space_id);
  revisions_updated bigint;
  claims_updated bigint;
  chunks_updated bigint;
begin
  update wk_concept_revisions r
  set search_vector =
       setweight(to_tsvector(cfg, coalesce(r.title, '')), 'A')
    || setweight(to_tsvector(cfg, coalesce(r.summary, '')), 'B')
    || setweight(to_tsvector(cfg, regexp_replace(r.markdown, '^---\r?\n.*?\r?\n---(?:\r?\n)?', '')), 'D')
  where r.space_id = p_space_id;
  get diagnostics revisions_updated = row_count;

  update wk_claims cl
  set search_vector =
       setweight(to_tsvector(cfg, coalesce(cl.subject, '')), 'A')
    || setweight(to_tsvector(cfg, coalesce(cl.object, '')), 'B')
    || setweight(to_tsvector(cfg, coalesce(cl.predicate, '')), 'C')
  where cl.space_id = p_space_id;
  get diagnostics claims_updated = row_count;

  -- Chunk vectors resolve per SOURCE (source language overrides the space
  -- default), so the chunk arm recomputes through wk_source_search_config.
  update wk_source_chunks ch
  set search_vector =
       setweight(to_tsvector(public.wk_source_search_config(ch.source_id), coalesce(ch.heading, '')), 'A')
    || setweight(to_tsvector(public.wk_source_search_config(ch.source_id), ch.content), 'C')
  where ch.space_id = p_space_id;
  get diagnostics chunks_updated = row_count;

  return jsonb_build_object(
    'space_id', p_space_id,
    'revisions', revisions_updated,
    'claims', claims_updated,
    'chunks', chunks_updated
  );
end;
$$;

-- Ranked FTS over archived source chunks — the 'source_evidence' tier.
-- Everything archived is searchable here BY DESIGN: this tier exists to
-- surface not-yet-curated material, clearly labeled as such by the caller.
-- The space config parses the query; per-source configs built the vectors
-- (a per-source query parse is impossible in one statement — the accepted
-- asymmetry for mixed-language spaces, bounded by unaccent + the shared
-- stopword repair and measured by the retrieval eval).
create or replace function public.wk_search_sources(
  p_space_id uuid,
  p_query text,
  p_limit int default 20
)
returns table (
  source_id uuid,
  chunk_id uuid,
  chunk_index int,
  title text,
  url text,
  heading text,
  headline text,
  rank real
)
language sql
stable
set search_path = public
as $$
  with query as (
    select public.wk_space_search_config(p_space_id) as cfg,
           public.wk_search_tsquery(public.wk_space_search_config(p_space_id), p_query) as ts
  ),
  hits as (
    select ch.source_id,
           ch.id as chunk_id,
           ch.chunk_index,
           s.title,
           s.url,
           ch.heading,
           ch.content as doc,
           ts_rank(ch.search_vector, query.ts)::real as rank,
           query.ts as ts,
           query.cfg as cfg
    from wk_source_chunks ch
    join wk_sources s on s.id = ch.source_id
    cross join query
    where ch.space_id = p_space_id
      and ch.search_vector @@ query.ts
    order by rank desc
    limit p_limit
  )
  select hits.source_id,
         hits.chunk_id,
         hits.chunk_index,
         hits.title,
         hits.url,
         hits.heading,
         ts_headline(
           hits.cfg,
           hits.doc,
           hits.ts,
           'StartSel=<mark>,StopSel=</mark>,MaxWords=30'
         ) as headline,
         hits.rank
  from hits
  order by hits.rank desc;
$$;
