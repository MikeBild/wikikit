-- The cockpit no longer models wikis as production/test environments. Test
-- fixtures are disposable and must remove their own wiki; leaked fixtures from
-- the former model are deleted once, including all ON DELETE CASCADE data.
delete from public.wk_spaces
 where settings->>'environment' = 'test';

update public.wk_spaces
   set settings = settings - 'environment'
 where settings ? 'environment';

-- One ranked search over all wikis visible to the caller. The wrappers keep
-- each wiki's language configuration while applying the limit after the
-- results have been merged, so the browser neither fans out nor embeds the
-- same question repeatedly.
create or replace function public.wk_search_spaces(
  p_space_ids uuid[],
  p_query text,
  p_kind text default null,
  p_limit int default 20
)
returns table (
  space_id uuid,
  kind text,
  concept_slug text,
  claim_id uuid,
  title text,
  headline text,
  rank real
)
language sql
stable
set search_path = public
as $$
  select visible.space_id, hit.*
    from unnest(p_space_ids) as visible(space_id)
    cross join lateral public.wk_search(visible.space_id, p_query, p_kind, p_limit) hit
   order by hit.rank desc, visible.space_id, hit.kind, hit.concept_slug, hit.claim_id
   limit p_limit;
$$;

create or replace function public.wk_search_sources_spaces(
  p_space_ids uuid[],
  p_query text,
  p_limit int default 20,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_source_kind text default null
)
returns table (
  space_id uuid,
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
  select visible.space_id, hit.*
    from unnest(p_space_ids) as visible(space_id)
    cross join lateral public.wk_search_sources(
      visible.space_id, p_query, p_limit, p_from, p_to, p_source_kind
    ) hit
   order by hit.rank desc, visible.space_id, hit.source_id, hit.chunk_id
   limit p_limit;
$$;

-- Hybrid wrappers only exist on installations where pgvector exists, exactly
-- like their single-wiki counterparts.
do $guard$
begin
  if not exists (select 1 from pg_extension where extname = 'vector') then
    raise notice 'pgvector not installed — skipping global hybrid search wrappers';
    return;
  end if;

  execute $fn$
    create or replace function public.wk_search_spaces_hybrid(
      p_space_ids uuid[],
      p_query text,
      p_embedding text,
      p_kind text default null,
      p_limit int default 20
    )
    returns table (
      space_id uuid,
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
      select visible.space_id, hit.*
        from unnest(p_space_ids) as visible(space_id)
        cross join lateral public.wk_search_hybrid(
          visible.space_id, p_query, p_embedding, p_kind, p_limit
        ) hit
       order by hit.rank desc, visible.space_id, hit.kind, hit.concept_slug, hit.claim_id
       limit p_limit;
    $body$
  $fn$;

  execute $fn$
    create or replace function public.wk_search_sources_spaces_hybrid(
      p_space_ids uuid[],
      p_query text,
      p_embedding text,
      p_limit int default 20,
      p_from timestamptz default null,
      p_to timestamptz default null,
      p_source_kind text default null
    )
    returns table (
      space_id uuid,
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
      select visible.space_id, hit.*
        from unnest(p_space_ids) as visible(space_id)
        cross join lateral public.wk_search_sources_hybrid(
          visible.space_id, p_query, p_embedding, p_limit, p_from, p_to, p_source_kind
        ) hit
       order by hit.rank desc, visible.space_id, hit.source_id, hit.chunk_id
       limit p_limit;
    $body$
  $fn$;
end
$guard$;
