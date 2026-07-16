-- Server-side full-text search over the knowledge base.
--   * wk_search_config() pins the text search configuration in ONE place so
--     the index expressions, the insert triggers and the query side always
--     stem identically. WikiKit has no per-space locale in v0.1 — 'english'
--     is the deliberate default (per-space language via wk_spaces.settings is
--     a v0.2 landing zone; changing the config then requires a backfill
--     migration, which is why the function is immutable and versioned here).
--   * wk_concept_revisions.search_vector is filled by a BEFORE INSERT trigger
--     only — revisions are immutable after insert, so no UPDATE trigger
--     exists. The frontmatter block is stripped before vectorizing so
--     structured metadata never pollutes the index.
--   * wk_claims content (subject/predicate/object) is likewise immutable —
--     only status flips after insert — so claims also get an INSERT-only
--     trigger.
--   * wk_search() joins revisions exclusively over
--     wk_concepts.current_revision_id and claims over visible statuses:
--     proposed content is invisible BY CONSTRUCTION, not by filter discipline.
create or replace function public.wk_search_config()
returns regconfig
language sql
immutable
as $$
  select 'english'::regconfig;
$$;

create or replace function public.wk_revision_search_vector()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  body text;
begin
  body := regexp_replace(new.markdown, '^---\r?\n.*?\r?\n---(?:\r?\n)?', '');
  new.search_vector :=
       setweight(to_tsvector(public.wk_search_config(), coalesce(new.title, '')), 'A')
    || setweight(to_tsvector(public.wk_search_config(), coalesce(new.summary, '')), 'B')
    || setweight(to_tsvector(public.wk_search_config(), body), 'D');
  return new;
end;
$$;

drop trigger if exists wk_revision_search_vector_insert on public.wk_concept_revisions;
create trigger wk_revision_search_vector_insert
  before insert on public.wk_concept_revisions
  for each row execute function public.wk_revision_search_vector();

create or replace function public.wk_claim_search_vector()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search_vector :=
       setweight(to_tsvector(public.wk_search_config(), coalesce(new.subject, '')), 'A')
    || setweight(to_tsvector(public.wk_search_config(), coalesce(new.object, '')), 'B')
    || setweight(to_tsvector(public.wk_search_config(), coalesce(new.predicate, '')), 'C');
  return new;
end;
$$;

drop trigger if exists wk_claim_search_vector_insert on public.wk_claims;
create trigger wk_claim_search_vector_insert
  before insert on public.wk_claims
  for each row execute function public.wk_claim_search_vector();

-- Backfill any pre-trigger rows (no-op on a fresh database; kept so this
-- migration is correct even if it ever lands on a database that already has
-- content — same expressions as the triggers).
update public.wk_concept_revisions
set search_vector =
     setweight(to_tsvector(public.wk_search_config(), coalesce(title, '')), 'A')
  || setweight(to_tsvector(public.wk_search_config(), coalesce(summary, '')), 'B')
  || setweight(to_tsvector(public.wk_search_config(), regexp_replace(markdown, '^---\r?\n.*?\r?\n---(?:\r?\n)?', '')), 'D')
where search_vector is null;

update public.wk_claims
set search_vector =
     setweight(to_tsvector(public.wk_search_config(), coalesce(subject, '')), 'A')
  || setweight(to_tsvector(public.wk_search_config(), coalesce(object, '')), 'B')
  || setweight(to_tsvector(public.wk_search_config(), coalesce(predicate, '')), 'C')
where search_vector is null;

-- wk_search — ranked FTS over current revisions + visible claims.
-- p_kind: NULL (both) | 'concept' | 'claim'. ts_headline is expensive, so it
-- runs in a second step over the returned page only.
create or replace function public.wk_search(
  p_space_id uuid,
  p_query text,
  p_kind text default null,
  p_limit int default 20
)
returns table (
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
  with query as (
    select websearch_to_tsquery(public.wk_search_config(), p_query) as ts
  ),
  concept_hits as (
    select 'concept'::text as kind,
           c.slug as concept_slug,
           null::uuid as claim_id,
           r.title as title,
           (r.title || E'\n' || r.summary || E'\n' ||
            regexp_replace(r.markdown, '^---\r?\n.*?\r?\n---(?:\r?\n)?', '')) as doc,
           ts_rank(r.search_vector, query.ts)::real as rank,
           query.ts as ts
    from wk_concepts c
    join wk_concept_revisions r on r.id = c.current_revision_id
    cross join query
    where c.space_id = p_space_id
      and (p_kind is null or p_kind = 'concept')
      and r.search_vector @@ query.ts
  ),
  claim_hits as (
    select 'claim'::text as kind,
           c.slug as concept_slug,
           cl.id as claim_id,
           (cl.subject || ' ' || cl.predicate || ' ' || cl.object) as title,
           (cl.subject || ' ' || cl.predicate || ' ' || cl.object) as doc,
           ts_rank(cl.search_vector, query.ts)::real as rank,
           query.ts as ts
    from wk_claims cl
    join wk_concepts c on c.id = cl.concept_id
    cross join query
    where cl.space_id = p_space_id
      and cl.status in ('verified', 'disputed', 'deprecated')
      and (p_kind is null or p_kind = 'claim')
      and cl.search_vector @@ query.ts
  ),
  hits as (
    select * from concept_hits
    union all
    select * from claim_hits
    order by rank desc
    limit p_limit
  )
  select hits.kind,
         hits.concept_slug,
         hits.claim_id,
         hits.title,
         ts_headline(
           public.wk_search_config(),
           hits.doc,
           hits.ts,
           'StartSel=<mark>,StopSel=</mark>,MaxWords=30'
         ) as headline,
         hits.rank
  from hits
  order by hits.rank desc;
$$;
