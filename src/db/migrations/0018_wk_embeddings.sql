-- Optional embeddings — a SECOND ranker for retrieval, never a replacement.
--
--   * Lexical FTS (0016/0017) stays the deterministic floor: everything
--     vector-related in this migration is wrapped in a pgvector guard and
--     no-ops cleanly on a server without the extension. TypeScript only ever
--     calls the hybrid functions after a startup capability probe AND with a
--     configured embedding provider — retrieval never fails because of
--     embeddings, it silently stays lexical.
--   * wk_embeddings is a SIDE table (one row per object × model), not
--     columns on the hot tables: one guarded object instead of three guarded
--     ALTERs, uniform for revisions/claims/source chunks, and hot-table
--     shapes stay identical across deployments with and without pgvector.
--   * Fusion is Reciprocal Rank Fusion (k=60) over RANK POSITIONS, computed
--     in SQL: rrf = 1/(60+lex_pos) + 1/(60+vec_pos), with coalesce so a
--     hit found by only one arm still ranks (partially-embedded corpora stay
--     correct during backfill). Deterministic and explainable — matched_via
--     reports which arm(s) found each hit.
--   * Visibility is restated in BOTH arms (current revisions, visible claim
--     statuses): proposed content stays invisible by construction in the
--     vector arm too, not by filter discipline.
--   * Dimensions are pinned to 1536 (text-embedding-3-small native;
--     gemini requested at 1536) — the provider layer refuses mismatched
--     models loudly.

-- Unconditional: the audit ledger learns the 'embed' kind (adjudicate has
-- been allowed since 0002). Must land before the embedder worker ships.
alter table public.wk_agent_runs
  drop constraint if exists wk_agent_runs_kind_check;

alter table public.wk_agent_runs
  add constraint wk_agent_runs_kind_check
  check (kind in ('classify', 'synthesize', 'answer', 'distill', 'adjudicate', 'embed'));

-- Everything below requires pgvector. A deployment without it gets a clean
-- no-op — and must re-run migrations (or install the extension and call this
-- block manually) after adding pgvector; restoring a post-0018 dump onto a
-- server without pgvector is out of scope (documented).
do $guard$
begin
  if not exists (select 1 from pg_available_extensions where name = 'vector') then
    raise notice 'pgvector not available — skipping wk_embeddings (retrieval stays lexical)';
    return;
  end if;

  execute 'create extension if not exists vector';

  execute $ddl$
    create table if not exists public.wk_embeddings (
      id uuid primary key default gen_random_uuid(),
      space_id uuid not null references public.wk_spaces(id) on delete cascade,
      object_kind text not null check (object_kind in ('revision', 'claim', 'source_chunk')),
      object_id uuid not null,
      model text not null,
      embedding vector(1536) not null,
      created_at timestamptz not null default now(),
      unique (object_kind, object_id, model)
    )
  $ddl$;

  execute 'create index if not exists wk_embeddings_hnsw_idx on public.wk_embeddings using hnsw (embedding vector_cosine_ops)';
  execute 'create index if not exists wk_embeddings_space_idx on public.wk_embeddings (space_id)';

  -- Hybrid search over approved knowledge: wk_search's lexical arms + a
  -- cosine-distance arm over wk_embeddings, fused by RRF. Same visibility
  -- joins as wk_search, same headline pass; new columns rank (= rrf score)
  -- and matched_via. Both arms read 4x the page size so fusion has depth.
  execute $fn$
    create or replace function public.wk_search_hybrid(
      p_space_id uuid,
      p_query text,
      p_embedding text,
      p_kind text default null,
      p_limit int default 20
    )
    returns table (
      kind text,
      concept_slug text,
      claim_id uuid,
      title text,
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
               btrim(p_query) as needle,
               p_embedding::vector(1536) as emb
      ),
      lex_raw as (
        select 'concept'::text as kind,
               c.slug as concept_slug,
               null::uuid as claim_id,
               r.title as title,
               (r.title || E'\n' || r.summary || E'\n' ||
                regexp_replace(r.markdown, '^---\r?\n.*?\r?\n---(?:\r?\n)?', '')) as doc,
               greatest(
                 (case when lower(c.slug) = lower(query.needle) then 10.0
                       else ts_rank(r.search_vector, query.ts) end),
                 5.0 * similarity(c.slug, query.needle),
                 3.0 * word_similarity(query.needle, r.title)
               )::real as lex_rank
        from wk_concepts c
        join wk_concept_revisions r on r.id = c.current_revision_id
        cross join query
        where c.space_id = p_space_id
          and (p_kind is null or p_kind = 'concept')
          and (r.search_vector @@ query.ts
               or lower(c.slug) = lower(query.needle)
               or similarity(c.slug, query.needle) >= 0.45
               or word_similarity(query.needle, r.title) >= 0.6)
        union all
        select 'claim'::text,
               c.slug,
               cl.id,
               (cl.subject || ' ' || cl.predicate || ' ' || cl.object),
               (cl.subject || ' ' || cl.predicate || ' ' || cl.object),
               ts_rank(cl.search_vector, query.ts)::real
        from wk_claims cl
        join wk_concepts c on c.id = cl.concept_id
        cross join query
        where cl.space_id = p_space_id
          and cl.status in ('verified', 'disputed', 'deprecated')
          and (p_kind is null or p_kind = 'claim')
          and cl.search_vector @@ query.ts
      ),
      lex as (
        select *, row_number() over (order by lex_rank desc) as pos
        from lex_raw
        order by lex_rank desc
        limit (p_limit * 4)
      ),
      vec_raw as (
        select 'concept'::text as kind,
               c.slug as concept_slug,
               null::uuid as claim_id,
               r.title as title,
               (r.title || E'\n' || r.summary || E'\n' ||
                regexp_replace(r.markdown, '^---\r?\n.*?\r?\n---(?:\r?\n)?', '')) as doc,
               (e.embedding <=> query.emb) as dist
        from wk_embeddings e
        join wk_concept_revisions r on e.object_kind = 'revision' and r.id = e.object_id
        join wk_concepts c on c.current_revision_id = r.id
        cross join query
        where e.space_id = p_space_id
          and (p_kind is null or p_kind = 'concept')
        union all
        select 'claim'::text,
               c.slug,
               cl.id,
               (cl.subject || ' ' || cl.predicate || ' ' || cl.object),
               (cl.subject || ' ' || cl.predicate || ' ' || cl.object),
               (e.embedding <=> query.emb)
        from wk_embeddings e
        join wk_claims cl on e.object_kind = 'claim' and cl.id = e.object_id
        join wk_concepts c on c.id = cl.concept_id
        cross join query
        where e.space_id = p_space_id
          and cl.status in ('verified', 'disputed', 'deprecated')
          and (p_kind is null or p_kind = 'claim')
      ),
      vec as (
        select *, row_number() over (order by dist asc) as pos
        from vec_raw
        order by dist asc
        limit (p_limit * 4)
      ),
      fused as (
        select coalesce(l.kind, v.kind) as kind,
               coalesce(l.concept_slug, v.concept_slug) as concept_slug,
               coalesce(l.claim_id, v.claim_id) as claim_id,
               coalesce(l.title, v.title) as title,
               coalesce(l.doc, v.doc) as doc,
               (coalesce(1.0 / (60 + l.pos), 0) + coalesce(1.0 / (60 + v.pos), 0))::real as rrf,
               case
                 when l.pos is not null and v.pos is not null then 'both'
                 when l.pos is not null then 'lexical'
                 else 'vector'
               end as matched_via
        from lex l
        full outer join vec v
          on l.kind = v.kind
         and l.concept_slug is not distinct from v.concept_slug
         and l.claim_id is not distinct from v.claim_id
      ),
      page as (
        select * from fused order by rrf desc limit p_limit
      )
      select page.kind,
             page.concept_slug,
             page.claim_id,
             page.title,
             ts_headline(
               (select cfg from query),
               page.doc,
               (select ts from query),
               'StartSel=<mark>,StopSel=</mark>,MaxWords=30'
             ) as headline,
             page.rrf as rank,
             page.matched_via
      from page
      order by page.rrf desc;
    $body$
  $fn$;

  -- Hybrid over the source-evidence tier (wk_source_chunks), same fusion.
  execute $fn$
    create or replace function public.wk_search_sources_hybrid(
      p_space_id uuid,
      p_query text,
      p_embedding text,
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
        cross join query
        where ch.space_id = p_space_id
          and ch.search_vector @@ query.ts
        order by lex_rank desc
        limit (p_limit * 4)
      ),
      vec as (
        select e.object_id as chunk_id,
               row_number() over (order by e.embedding <=> query.emb) as pos
        from wk_embeddings e
        cross join query
        where e.space_id = p_space_id
          and e.object_kind = 'source_chunk'
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
