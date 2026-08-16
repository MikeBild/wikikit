-- Repair path for an installation that gained pgvector AFTER 0018 was
-- journalled. It creates nothing new: it restores the objects 0018 and 0040
-- would have created had the extension been available when they ran.
--
-- WHY a new tag rather than re-running 0018. The runner never re-executes a
-- recorded tag — a matching hash is skipped and a drifted hash is backfilled
-- in place, without running the file (src/db/migrate.ts). A host that ran 0018
-- while pgvector was absent has 0018 recorded and none of its guarded objects,
-- and no re-run of migrations will ever create them. A tag the journal has not
-- seen is the only thing the runner will execute.
--
-- WHY the bodies are duplicated. 0018 and 0040 remain authoritative for a
-- fresh install: they run in order and produce exactly this shape. This file
-- is the repair path only, and on a host that already owns the objects it
-- replaces them with definitions identical to the ones already there.
--
-- WHY wk_search_sources_hybrid is copied from 0040 and not from 0018. 0040
-- dropped 0018's four-argument signature and redeclared it with seven;
-- src/db/postgres.ts pins the seven-argument call. Replaying 0018's body here
-- would leave the narrow signature standing and break every
-- approved_then_sources search. The copy is verbatim so the two cannot
-- diverge.
--
-- Every statement is idempotent (if not exists / or replace) and the whole
-- block carries 0018's guard: without the extension this is a clean no-op and
-- retrieval stays lexical.
do $guard$
begin
  if not exists (select 1 from pg_available_extensions where name = 'vector') then
    raise notice 'pgvector not available — skipping wk_embeddings repair (retrieval stays lexical)';
    return;
  end if;

  -- Availability is not permission. The package can be installed while the
  -- application role may not run CREATE EXTENSION — pgvector is not a trusted
  -- extension, so on a least-privilege database this statement raises
  -- insufficient_privilege. Unhandled it aborts the migration, and a migration
  -- that aborts refuses the boot: an OPTIONAL second ranker would take the
  -- server down. Catching it keeps the promise the guard above makes — no
  -- pgvector, no hybrid, lexical retrieval, a running server. The operator
  -- fixes it by creating the extension once as a superuser; the next boot then
  -- finds it present and this statement is a no-op.
  begin
    execute 'create extension if not exists vector';
  exception
    when insufficient_privilege then
      raise notice 'pgvector is installed but this role may not create it — retrieval stays lexical until a superuser runs CREATE EXTENSION vector';
  end;

  -- The only question that matters from here on: does the `vector` type exist?
  -- Everything below names it, and asking pg_extension rather than trusting the
  -- statement above keeps one gate for every way the creation can have failed.
  if not exists (select 1 from pg_extension where extname = 'vector') then
    raise notice 'pgvector not installed — skipping wk_embeddings repair (retrieval stays lexical)';
    return;
  end if;

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

  -- Source-evidence tier — body verbatim from 0040 (see header).
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
