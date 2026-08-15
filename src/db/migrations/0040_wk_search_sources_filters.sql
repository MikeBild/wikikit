-- Filters for the source-evidence tier: an arrival window and the kind a
-- source declared about itself.
--
-- WHY only this tier. Approved retrieval (wk_search) is deliberately NOT
-- touched: the two tiers share no clock — a revision is dated by its review,
-- a source by its arrival — and no kind alphabet (concept|claim on the wire
-- against the transport a client declared about a document). A curated page
-- does not become untrue because it is old, so an age filter over approved
-- knowledge would be a question with no honest answer.
--
-- WHY the earlier signatures are DROPPED rather than left standing beside the
-- widened ones. Appending defaulted parameters to a function whose tail is
-- already defaulted does not extend it, it overloads it — and a three-argument
-- call then matches both candidates, so Postgres refuses it with 'function is
-- not unique' rather than picking the older body. The old overload would be
-- unreachable, not compatible. With it dropped exactly one function remains,
-- and its defaults answer the old three-argument call byte-for-byte as before
-- — which is also what keeps a not-yet-replaced binary working through a
-- rolling upgrade.
--
-- WHY the predicates sit inside the CTEs of the hybrid function rather than
-- around its result. Each arm takes p_limit * 4 candidates BEFORE fusion;
-- filtering after RRF would fuse over unfiltered candidates and then discard
-- most of them, so a filtered search would return a page far shorter than the
-- limit it asked for while matching rows sat one rank below the cut. The
-- filter therefore rides in both arms, before both limits.
--
-- The window is half-open [p_from, p_to) — the convention the stats readers
-- already use, so two adjacent windows partition without double-counting.
-- p_source_kind matches wk_sources.metadata->>'source_kind', which is present
-- only when a client supplied it: filtering by a kind excludes every source
-- that never declared one.

drop function if exists public.wk_search_sources(uuid, text, int);

create or replace function public.wk_search_sources(
  p_space_id uuid,
  p_query text,
  p_limit int default 20,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_source_kind text default null
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
      and (p_from is null or s.created_at >= p_from)
      and (p_to is null or s.created_at < p_to)
      and (p_source_kind is null or s.metadata->>'source_kind' = p_source_kind)
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

-- The hybrid twin exists only where pgvector does — the same guard 0018 wraps
-- all vector DDL in, repeated here because a deployment without the extension
-- must skip this block cleanly rather than fail the migration.
do $guard$
begin
  if not exists (select 1 from pg_available_extensions where name = 'vector') then
    raise notice 'pgvector not available — skipping wk_search_sources_hybrid filters (retrieval stays lexical)';
    return;
  end if;

  execute 'drop function if exists public.wk_search_sources_hybrid(uuid, text, text, int)';

  execute $fn$
    create or replace function public.wk_search_sources_hybrid(
      p_space_id uuid,
      p_query text,
      p_embedding text,
      p_limit int default 20,
      p_from timestamptz default null,
      p_to timestamptz default null,
      p_source_kind text default null
    )
    returns table (
      source_id uuid,
      chunk_id uuid,
      chunk_index int,
      title text,
      url text,
      heading text,
      headline text,
      rank real,
      matched_via text
    )
    language sql
    stable
    set search_path = public
    as $body$
      with query as (
        select public.wk_space_search_config(p_space_id) as cfg,
               public.wk_search_tsquery(public.wk_space_search_config(p_space_id), p_query) as ts,
               p_embedding::vector(1536) as emb
      ),
      lex as (
        select ch.id as chunk_id, ts_rank(ch.search_vector, query.ts) as lex_rank,
               row_number() over (order by ts_rank(ch.search_vector, query.ts) desc) as pos
        from wk_source_chunks ch
        join wk_sources s on s.id = ch.source_id
        cross join query
        where ch.space_id = p_space_id
          and ch.search_vector @@ query.ts
          and (p_from is null or s.created_at >= p_from)
          and (p_to is null or s.created_at < p_to)
          and (p_source_kind is null or s.metadata->>'source_kind' = p_source_kind)
        order by lex_rank desc
        limit (p_limit * 4)
      ),
      vec as (
        select e.object_id as chunk_id,
               row_number() over (order by e.embedding <=> query.emb) as pos
        from wk_embeddings e
        join wk_source_chunks ch on ch.id = e.object_id
        join wk_sources s on s.id = ch.source_id
        cross join query
        where e.space_id = p_space_id
          and e.object_kind = 'source_chunk'
          and (p_from is null or s.created_at >= p_from)
          and (p_to is null or s.created_at < p_to)
          and (p_source_kind is null or s.metadata->>'source_kind' = p_source_kind)
        order by (e.embedding <=> query.emb) asc
        limit (p_limit * 4)
      ),
      fused as (
        select coalesce(l.chunk_id, v.chunk_id) as chunk_id,
               (coalesce(1.0 / (60 + l.pos), 0) + coalesce(1.0 / (60 + v.pos), 0))::real as rrf,
               case
                 when l.pos is not null and v.pos is not null then 'both'
                 when l.pos is not null then 'lexical'
                 else 'vector'
               end as matched_via
        from lex l
        full outer join vec v on l.chunk_id = v.chunk_id
      ),
      page as (
        select * from fused order by rrf desc limit p_limit
      )
      select ch.source_id,
             ch.id as chunk_id,
             ch.chunk_index,
             s.title,
             s.url,
             ch.heading,
             ts_headline(
               (select cfg from query),
               ch.content,
               (select ts from query),
               'StartSel=<mark>,StopSel=</mark>,MaxWords=30'
             ) as headline,
             page.rrf as rank,
             page.matched_via
      from page
      join wk_source_chunks ch on ch.id = page.chunk_id
      join wk_sources s on s.id = ch.source_id
      order by page.rrf desc;
    $body$
  $fn$;
end
$guard$;
