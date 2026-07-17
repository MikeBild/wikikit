-- Operational-integrity follow-up: durable ingest leases, domain-aware
-- contradiction semantics, migration-reference hygiene and exact-slug search.

alter table public.wk_ingest_jobs
  add column if not exists heartbeat_at timestamptz,
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz;

update public.wk_ingest_jobs
set heartbeat_at = coalesce(heartbeat_at, started_at),
    lease_expires_at = coalesce(lease_expires_at, started_at + interval '15 minutes')
where status = 'running';

create index if not exists wk_ingest_jobs_expired_lease_idx
  on public.wk_ingest_jobs (lease_expires_at)
  where status = 'running';

-- Predicate cardinality is domain configuration, never inferred from a vague
-- predicate name. No declaration means multi-valued.
create or replace function public.wk_functional_predicates(p_space_id uuid)
returns text[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(item.value), '{}'::text[])
  from wk_spaces s
  cross join lateral jsonb_array_elements_text(
    case
      when jsonb_typeof(s.settings->'functional_predicates') = 'array'
        then s.settings->'functional_predicates'
      else '[]'::jsonb
    end
  ) as item(value)
  where s.id = p_space_id;
$$;

-- Remove only relations whose exact shape proves they were synthesized by the
-- old apply-time matcher from a now-multi-valued frame. Preserve a relation
-- whenever any declared-functional collision still supports it.
update public.wk_relations rel
set status = 'removed'
where rel.kind = 'contradicts'
  and rel.status = 'active'
  and rel.proposal_id is not null
  and exists (
    select 1
    from wk_claims fresh
    join wk_claims old
      on old.space_id = fresh.space_id
     and old.subject = fresh.subject
     and old.predicate = fresh.predicate
     and old.object <> fresh.object
    where fresh.proposal_id = rel.proposal_id
      and fresh.concept_id = rel.from_concept_id
      and old.concept_id = rel.to_concept_id
      and not (fresh.predicate = any(public.wk_functional_predicates(fresh.space_id)))
  )
  and not exists (
    select 1
    from wk_claims a
    join wk_claims b
      on b.space_id = a.space_id
     and b.subject = a.subject
     and b.predicate = a.predicate
     and b.object <> a.object
    where a.space_id = rel.space_id
      and a.concept_id = rel.from_concept_id
      and b.concept_id = rel.to_concept_id
      and a.status in ('verified', 'disputed')
      and b.status in ('verified', 'disputed')
      and a.predicate = any(public.wk_functional_predicates(a.space_id))
  );

update public.wk_claims cl
set status = 'verified'
where cl.status = 'disputed'
  and not (cl.predicate = any(public.wk_functional_predicates(cl.space_id)));

-- Migrated domain pages that have no graph edge are attached to their visible
-- domain root. This is deterministic, idempotent and limited to the migration
-- marker; no content or claims are fabricated.
insert into public.wk_relations (
  space_id, from_concept_id, to_concept_id, kind, status, proposal_id
)
select s.id, root.id, orphan.id, 'related', 'active', null
from wk_spaces s
join wk_concepts root
  on root.space_id = s.id
 and root.slug = s.slug
 and root.current_revision_id is not null
join wk_concepts orphan
  on orphan.space_id = s.id
 and orphan.current_revision_id is not null
 and orphan.id <> root.id
where s.settings->>'migration' = 'subkit-domain-v1'
  and not exists (
    select 1
    from wk_relations rel
    where rel.status = 'active'
      and (rel.from_concept_id = orphan.id or rel.to_concept_id = orphan.id)
  )
on conflict (space_id, from_concept_id, to_concept_id, kind)
do update set status = 'active';

-- The Supabase migration has no concept whose slug equals the space slug.
-- Use explicit, semantically close anchors rather than a fuzzy title match.
insert into public.wk_relations (
  space_id, from_concept_id, to_concept_id, kind, status, proposal_id
)
select s.id, anchor.id, target.id, 'related', 'active', null
from (
  values
    ('supabase-content-type-rewriting', 'supabase-edge-functions'),
    ('supabase-edge-functions-common-pitfalls', 'supabase-edge-functions'),
    ('supabase-edge-functions-mechanics', 'supabase-edge-functions'),
    ('supabase-xhtml-deployment', 'supabase-storage-static-hosting')
) as link(target_slug, anchor_slug)
join wk_spaces s on s.slug = 'supabase' and s.settings->>'migration' = 'subkit-domain-v1'
join wk_concepts anchor
  on anchor.space_id = s.id and anchor.slug = link.anchor_slug and anchor.current_revision_id is not null
join wk_concepts target
  on target.space_id = s.id and target.slug = link.target_slug and target.current_revision_id is not null
on conflict (space_id, from_concept_id, to_concept_id, kind)
do update set status = 'active';

update public.wk_spaces s
set epoch = epoch + 1
where s.settings->>'migration' = 'subkit-domain-v1';

create or replace function public.wk_apply_proposal(p_proposal_id uuid, p_reviewer text, p_note text default null)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  proposal public.wk_change_proposals%rowtype;
  space_slug text;
  concept_slugs text[] := '{}';
  claims_verified integer := 0;
  claims_disputed integer := 0;
begin
  select * into proposal from wk_change_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'proposal_not_found';
  end if;
  if proposal.status <> 'pending' then
    raise exception 'proposal_not_pending';
  end if;

  select slug into space_slug from wk_spaces where id = proposal.space_id;

  -- Lock every affected concept row, in id order so two proposals sharing a
  -- concept subset can never deadlock.
  perform 1
  from wk_concepts c
  where c.id in (
    select r.concept_id from wk_concept_revisions r where r.proposal_id = p_proposal_id
  )
  order by c.id
  for update;

  -- Stale-base check: every proposed revision must have been synthesized
  -- against what is STILL the concept's current revision (NULL = new concept,
  -- matched via IS DISTINCT FROM). Anything else means the base moved under
  -- the proposal → the reviewer approved a diff that no longer applies.
  if exists (
    select 1
    from wk_concept_revisions r
    join wk_concepts c on c.id = r.concept_id
    where r.proposal_id = p_proposal_id
      and r.status = 'proposed'
      and c.current_revision_id is distinct from r.base_revision_id
  ) then
    raise exception 'stale_base';
  end if;

  -- Flip 1: previous current revisions of the touched concepts → superseded.
  update wk_concept_revisions old
  set status = 'superseded'
  from wk_concept_revisions fresh
  join wk_concepts c on c.id = fresh.concept_id
  where fresh.proposal_id = p_proposal_id
    and fresh.status = 'proposed'
    and old.id = c.current_revision_id;

  -- Flip 2: proposed revisions → current.
  update wk_concept_revisions
  set status = 'current'
  where proposal_id = p_proposal_id and status = 'proposed';

  -- Flip 3: repoint the concept (and mirror the revision title so list
  -- endpoints never show a stale title).
  update wk_concepts c
  set current_revision_id = fresh.id,
      title = fresh.title,
      updated_at = now()
  from wk_concept_revisions fresh
  where fresh.proposal_id = p_proposal_id
    and fresh.status = 'current'
    and c.id = fresh.concept_id;

  -- Flip 4: proposed claims → verified.
  update wk_claims
  set status = 'verified'
  where proposal_id = p_proposal_id and status = 'proposed';
  get diagnostics claims_verified = row_count;

  -- Flip 5: only predicates explicitly declared functional for this space
  -- with a pre-existing visible claim on the same (space, subject, predicate)
  -- but a different object disputes BOTH sides. The status filters are stable
  -- under the flip itself ({verified,disputed} on either side), so the pair
  -- set is identical when recomputed for the relation insert below.
  with pairs as (
    select fresh.id as fresh_id, old.id as old_id
    from wk_claims fresh
    join wk_claims old
      on old.space_id = fresh.space_id
     and old.subject = fresh.subject
     and old.predicate = fresh.predicate
     and old.object <> fresh.object
    where fresh.proposal_id = p_proposal_id
      and fresh.predicate = any(public.wk_functional_predicates(fresh.space_id))
      and fresh.status in ('verified', 'disputed')
      and old.proposal_id is distinct from p_proposal_id
      and old.status in ('verified', 'disputed')
  )
  update wk_claims
  set status = 'disputed'
  where status <> 'disputed'
    and id in (select fresh_id from pairs union select old_id from pairs);
  get diagnostics claims_disputed = row_count;

  -- Flip 5b: ensure a 'contradicts' relation between the concepts carrying a
  -- disputed pair. Upsert via the (space, from, to, kind) unique constraint.
  insert into wk_relations (space_id, from_concept_id, to_concept_id, kind, status, proposal_id)
  select distinct fresh.space_id, fresh.concept_id, old.concept_id, 'contradicts', 'active', p_proposal_id
  from wk_claims fresh
  join wk_claims old
    on old.space_id = fresh.space_id
   and old.subject = fresh.subject
   and old.predicate = fresh.predicate
   and old.object <> fresh.object
  where fresh.proposal_id = p_proposal_id
    and fresh.predicate = any(public.wk_functional_predicates(fresh.space_id))
    and fresh.status = 'disputed'
    and old.proposal_id is distinct from p_proposal_id
    and old.status = 'disputed'
    and fresh.concept_id <> old.concept_id
  on conflict (space_id, from_concept_id, to_concept_id, kind)
    do update set status = 'active';

  -- Flip 6: relations and decisions staged by this proposal → active.
  update wk_relations
  set status = 'active'
  where proposal_id = p_proposal_id and status = 'proposed';

  update wk_decisions
  set status = 'active'
  where proposal_id = p_proposal_id and status = 'proposed';

  -- Flip 7: the proposal itself, plus the space epoch (ETag driver).
  update wk_change_proposals
  set status = 'approved', reviewer = p_reviewer, review_note = p_note, reviewed_at = now()
  where id = p_proposal_id;

  update wk_spaces
  set epoch = epoch + 1, updated_at = now()
  where id = proposal.space_id;

  select coalesce(array_agg(distinct c.slug), '{}')
  into concept_slugs
  from wk_concept_revisions r
  join wk_concepts c on c.id = r.concept_id
  where r.proposal_id = p_proposal_id;

  -- Outbox events in the SAME transaction — the transactional-outbox
  -- guarantee webhooks depend on.
  insert into wk_outbox_events (space_id, event_type, payload)
  values (
    proposal.space_id,
    'wikikit.proposal.approved',
    jsonb_build_object(
      'proposal_id', p_proposal_id,
      'space', space_slug,
      'reviewer', p_reviewer,
      'note', p_note,
      'concepts', to_jsonb(concept_slugs)
    )
  );

  insert into wk_outbox_events (space_id, event_type, payload)
  select proposal.space_id,
         'wikikit.concept.updated',
         jsonb_build_object('space', space_slug, 'slug', c.slug, 'rev', r.rev, 'proposal_id', p_proposal_id)
  from wk_concept_revisions r
  join wk_concepts c on c.id = r.concept_id
  where r.proposal_id = p_proposal_id and r.status = 'current';

  return jsonb_build_object(
    'proposal_id', p_proposal_id,
    'status', 'approved',
    'concepts', to_jsonb(concept_slugs),
    'claims_verified', claims_verified,
    'claims_disputed', claims_disputed
  );
end;
$$;

-- Exact slug lookup bypasses websearch hyphen operators and receives a stable
-- rank boost. Existing vectors were inspected in PROD and are populated; the
-- derived-column backfill remains defensive for any older/null row.
update public.wk_concept_revisions
set search_vector =
     setweight(to_tsvector(public.wk_search_config(), coalesce(title, '')), 'A')
  || setweight(to_tsvector(public.wk_search_config(), coalesce(summary, '')), 'B')
  || setweight(to_tsvector(public.wk_search_config(), regexp_replace(markdown, '^---\r?\n.*?\r?\n---(?:\r?\n)?', '')), 'D')
where search_vector is null;

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
    select websearch_to_tsquery(public.wk_search_config(), p_query) as ts
  ),
  concept_hits as (
    select 'concept'::text as kind,
           c.slug as concept_slug,
           null::uuid as claim_id,
           r.title as title,
           (r.title || E'\n' || r.summary || E'\n' ||
            regexp_replace(r.markdown, '^---\r?\n.*?\r?\n---(?:\r?\n)?', '')) as doc,
           (case when lower(c.slug) = lower(btrim(p_query)) then 10.0 else ts_rank(r.search_vector, query.ts) end)::real as rank,
           query.ts as ts
    from wk_concepts c
    join wk_concept_revisions r on r.id = c.current_revision_id
    cross join query
    where c.space_id = p_space_id
      and (p_kind is null or p_kind = 'concept')
      and (r.search_vector @@ query.ts or lower(c.slug) = lower(btrim(p_query)))
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
