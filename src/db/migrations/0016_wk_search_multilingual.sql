-- Multilingual search: per-space (and per-source) text search configuration,
-- accent-insensitive matching and trigram fallback.
--
--   * 0001 pinned 'english' in the immutable wk_search_config() and named
--     wk_spaces.settings as the v0.2 landing zone for a per-space language.
--     This migration is that landing zone becoming real:
--     settings->>'language' ('en' | 'de' | 'simple', default 'en') now
--     selects the configuration. The superseded wk_search_config() pin is
--     DROPPED at the end of this migration — no legacy objects.
--   * wk_english / wk_german are COPIES of the built-in configurations with
--     unaccent installed as a FILTERING dictionary. Putting unaccent inside
--     the configuration (instead of unaccent() calls in expressions) applies
--     it symmetrically to indexing, websearch_to_tsquery and ts_headline,
--     and sidesteps unaccent()'s STABLE-not-IMMUTABLE problem entirely.
--   * search_vector stays a STORED trigger-filled column (plain GIN index,
--     no expression index), so config resolution may be STABLE — the
--     IMMUTABLE constraint on the 0001 function only existed to keep one
--     pinned config, not for index correctness.
--   * Language changes after the fact go through wk_reindex_space(), which
--     recomputes the derived vectors for one space. Revisions and claims
--     stay immutable in CONTENT — the derived search_vector is the one
--     column the 0001/0003 backfills already updated in place.
--   * pg_trgm adds typo tolerance on concept slugs and revision titles with
--     fixed, documented constants: similarity >= 0.45 on the slug,
--     word_similarity >= 0.6 on the title; trigram rank contributions are
--     5.0 * slug-similarity and 3.0 * title-word-similarity, so a trigram
--     match outranks plain text hits (ts_rank rarely exceeds 1.0) but never
--     the exact-slug boost (10.0). Deterministic and explainable by design.
--   * The final backfill re-vectorizes EVERY revision and claim (not just
--     null vectors): existing 'english'-stemmed vectors must be restemmed
--     under the new per-space configuration, and unaccent must apply to
--     spaces that stay English.
create extension if not exists unaccent;

create extension if not exists pg_trgm;

-- Text search configurations are not idempotent to create — guard on
-- pg_ts_config so the migration is safe on a dirty dev database.
do $do$
begin
  if not exists (
    select 1 from pg_ts_config c join pg_namespace n on n.oid = c.cfgnamespace
    where c.cfgname = 'wk_english' and n.nspname = 'public'
  ) then
    execute 'create text search configuration public.wk_english (copy = english)';
    execute 'alter text search configuration public.wk_english
               alter mapping for hword, hword_part, word with unaccent, english_stem';
  end if;
  if not exists (
    select 1 from pg_ts_config c join pg_namespace n on n.oid = c.cfgnamespace
    where c.cfgname = 'wk_german' and n.nspname = 'public'
  ) then
    execute 'create text search configuration public.wk_german (copy = german)';
    execute 'alter text search configuration public.wk_german
               alter mapping for hword, hword_part, word with unaccent, german_stem';
  end if;
end
$do$;

-- Per-source language override (null = space default). A real column, not a
-- metadata jsonb path: retrieval-critical values do not live behind an
-- unconstrained blob.
alter table public.wk_sources
  add column if not exists language text
  check (language is null or language in ('en', 'de', 'simple'));

-- Space-level configuration resolution. STABLE (reads wk_spaces), used by
-- the insert triggers, wk_search and the backfills below. Unknown or missing
-- language falls back to wk_english — today's behavior plus unaccent.
-- (Replaces the 0001 immutable wk_search_config() pin, dropped below.)
create or replace function public.wk_space_search_config(p_space_id uuid)
returns regconfig
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select case s.settings->>'language'
              when 'de' then 'public.wk_german'::regconfig
              when 'simple' then 'simple'::regconfig
              else 'public.wk_english'::regconfig
            end
     from wk_spaces s
     where s.id = p_space_id),
    'public.wk_english'::regconfig
  );
$$;

-- Source-level resolution: explicit source language wins, else the space
-- default. Consumed by the source-chunk index (later migration); defined
-- here so the language column and its resolution ship together.
create or replace function public.wk_source_search_config(p_source_id uuid)
returns regconfig
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select case src.language
              when 'de' then 'public.wk_german'::regconfig
              when 'en' then 'public.wk_english'::regconfig
              when 'simple' then 'simple'::regconfig
              else public.wk_space_search_config(src.space_id)
            end
     from wk_sources src
     where src.id = p_source_id),
    'public.wk_english'::regconfig
  );
$$;

-- Same triggers as 0001, now resolving the configuration from NEW.space_id.
-- INSERT-only remains correct: content is immutable after insert; language
-- changes are handled by wk_reindex_space below.
create or replace function public.wk_revision_search_vector()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cfg regconfig := public.wk_space_search_config(new.space_id);
  body text;
begin
  body := regexp_replace(new.markdown, '^---\r?\n.*?\r?\n---(?:\r?\n)?', '');
  new.search_vector :=
       setweight(to_tsvector(cfg, coalesce(new.title, '')), 'A')
    || setweight(to_tsvector(cfg, coalesce(new.summary, '')), 'B')
    || setweight(to_tsvector(cfg, body), 'D');
  return new;
end;
$$;

create or replace function public.wk_claim_search_vector()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cfg regconfig := public.wk_space_search_config(new.space_id);
begin
  new.search_vector :=
       setweight(to_tsvector(cfg, coalesce(new.subject, '')), 'A')
    || setweight(to_tsvector(cfg, coalesce(new.object, '')), 'B')
    || setweight(to_tsvector(cfg, coalesce(new.predicate, '')), 'C');
  return new;
end;
$$;

-- Recomputes one space's derived search vectors under its current language
-- setting. Idempotent; called by the settings handler when
-- settings.language changes (and available for manual repair). Reached only
-- through the db.call whitelist like every other wk_ function.
create or replace function public.wk_reindex_space(p_space_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  cfg regconfig := public.wk_space_search_config(p_space_id);
  revisions_updated bigint;
  claims_updated bigint;
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

  return jsonb_build_object(
    'space_id', p_space_id,
    'revisions', revisions_updated,
    'claims', claims_updated
  );
end;
$$;

-- Query parsing with a German stopword repair. unaccent runs BEFORE the
-- stemmer (filtering dictionary), so the stemmer no longer recognizes the
-- umlauted entries of its stopword list — 'für' arrives as 'fur' and
-- survives as a content-bearing term, breaking websearch AND semantics for
-- any document that lacks the function word. The complete set of surviving
-- lexemes is small and fixed (the german stoplist has exactly these
-- non-ASCII entries: daß für können könnte während würde würden über), so
-- they are stripped from the parsed query here. German-only: 'fur' is a
-- legitimate English word, so wk_english queries pass through untouched.
-- Index-side occurrences of these lexemes remain as harmless noise (queries
-- never contain them after this). client_min_messages suppresses the
-- "doesn't contain lexemes" NOTICE the empty-substitute rewrites emit.
create or replace function public.wk_search_tsquery(p_cfg regconfig, p_query text)
returns tsquery
language sql
stable
set search_path = public
set client_min_messages = warning
as $$
  select case
    when p_cfg = 'public.wk_german'::regconfig then
      ts_rewrite(ts_rewrite(ts_rewrite(ts_rewrite(ts_rewrite(ts_rewrite(ts_rewrite(
        websearch_to_tsquery(p_cfg, p_query),
        'dass'::tsquery, ''::tsquery),
        'fur'::tsquery, ''::tsquery),
        'konn'::tsquery, ''::tsquery),
        'konnt'::tsquery, ''::tsquery),
        'wahrend'::tsquery, ''::tsquery),
        'wurd'::tsquery, ''::tsquery),
        'uber'::tsquery, ''::tsquery)
    else websearch_to_tsquery(p_cfg, p_query)
  end;
$$;

-- Trigram indexes for the slug/title fallback arm of wk_search.
create index if not exists wk_concepts_slug_trgm_idx
  on public.wk_concepts using gin (slug gin_trgm_ops);

create index if not exists wk_concept_revisions_title_trgm_idx
  on public.wk_concept_revisions using gin (title gin_trgm_ops);

-- Same signature and return shape as 0003 (CREATE OR REPLACE cannot change
-- RETURNS TABLE — new result columns belong to new functions). Changes:
-- per-space configuration everywhere the 0001 pin was used, plus the trigram
-- fallback arm on concepts.
create or replace function public.wk_search(p_space_id uuid,
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
    select public.wk_space_search_config(p_space_id) as cfg,
           public.wk_search_tsquery(public.wk_space_search_config(p_space_id), p_query) as ts,
           btrim(p_query) as needle
  ),
  concept_hits as (
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
           )::real as rank,
           query.ts as ts,
           query.cfg as cfg
    from wk_concepts c
    join wk_concept_revisions r on r.id = c.current_revision_id
    cross join query
    where c.space_id = p_space_id
      and (p_kind is null or p_kind = 'concept')
      and (r.search_vector @@ query.ts
           or lower(c.slug) = lower(query.needle)
           or similarity(c.slug, query.needle) >= 0.45
           or word_similarity(query.needle, r.title) >= 0.6)
  ),
  claim_hits as (
    select 'claim'::text as kind,
           c.slug as concept_slug,
           cl.id as claim_id,
           (cl.subject || ' ' || cl.predicate || ' ' || cl.object) as title,
           (cl.subject || ' ' || cl.predicate || ' ' || cl.object) as doc,
           ts_rank(cl.search_vector, query.ts)::real as rank,
           query.ts as ts,
           query.cfg as cfg
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
           hits.cfg,
           hits.doc,
           hits.ts,
           'StartSel=<mark>,StopSel=</mark>,MaxWords=30'
         ) as headline,
         hits.rank
  from hits
  order by hits.rank desc;
$$;

-- Unconditional re-vectorization: every existing vector was built with the
-- 0001 'english' pin and must be restemmed/unaccented under the per-space
-- configuration. Runs once; on large deployments this rewrites every
-- revision/claim row (document expected duration in release notes).
update public.wk_concept_revisions r
set search_vector =
     setweight(to_tsvector(public.wk_space_search_config(r.space_id), coalesce(r.title, '')), 'A')
  || setweight(to_tsvector(public.wk_space_search_config(r.space_id), coalesce(r.summary, '')), 'B')
  || setweight(to_tsvector(public.wk_space_search_config(r.space_id), regexp_replace(r.markdown, '^---\r?\n.*?\r?\n---(?:\r?\n)?', '')), 'D');

update public.wk_claims cl
set search_vector =
     setweight(to_tsvector(public.wk_space_search_config(cl.space_id), coalesce(cl.subject, '')), 'A')
  || setweight(to_tsvector(public.wk_space_search_config(cl.space_id), coalesce(cl.object, '')), 'B')
  || setweight(to_tsvector(public.wk_space_search_config(cl.space_id), coalesce(cl.predicate, '')), 'C');

-- No legacy objects: every trigger, function and backfill above resolves the
-- configuration per space/source — the 0001 pinned-config function has no
-- caller left and is dropped (fresh replays: 0001/0003 used it BEFORE this
-- statement runs; existing databases: the trigger bodies were replaced above).
drop function if exists public.wk_search_config();
