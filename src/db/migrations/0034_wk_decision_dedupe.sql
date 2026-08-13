-- Decision deduplication: decisions get their own extraction stage, and a
-- decision can now retire the one it replaces.
--
-- WHY: decisions were mined by synthesis, which runs once per affected
-- concept. Every one of those calls read the same source, so a single settled
-- choice was proposed once per concept under a slightly different slug and the
-- decision log multiplied it (observed: 26 rows for ~9 real decisions). The
-- pipeline now extracts decisions ONCE per ingest (prompt decisions.v1, agent
-- run kind 'extract_decisions') with the space's active decisions in view, so
-- it can mark a find as already recorded or as an update to an existing one.
--
-- Three changes, all additive:
--   1. wk_agent_runs.kind accepts 'extract_decisions' (the 0018 'embed'
--      precedent: drop + re-add the CHECK with the widened whitelist).
--   2. wk_decisions.supersedes_decision_id — the staged pointer, mirroring
--      wk_claims.supersedes_claim_id. ON DELETE SET NULL: losing the ancestor
--      must never take the successor with it.
--   3. wk_apply_proposal_core_0003 gains flip 6c, which finally gives the
--      never-written 'superseded' status of wk_decisions a writer. Same
--      same-signature CREATE OR REPLACE as 0014/0022; body otherwise verbatim
--      from 0022.

alter table public.wk_agent_runs
  drop constraint if exists wk_agent_runs_kind_check;
alter table public.wk_agent_runs
  add constraint wk_agent_runs_kind_check
    check (kind in ('classify', 'synthesize', 'extract_decisions', 'answer', 'distill', 'adjudicate', 'embed'));

alter table public.wk_decisions
  add column if not exists supersedes_decision_id uuid
    references public.wk_decisions(id) on delete set null;

create or replace function public.wk_apply_proposal_core_0003(p_proposal_id uuid, p_reviewer text, p_note text default null)
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
  claims_deprecated integer := 0;
  relations_removed_count integer := 0;
  decisions_superseded integer := 0;
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
  -- concept subset can never deadlock. Includes the endpoints of relations
  -- this proposal marks for removal — they may have no staged revision.
  perform 1
  from wk_concepts c
  where c.id in (
    select r.concept_id from wk_concept_revisions r where r.proposal_id = p_proposal_id
    union
    select rel.from_concept_id from wk_relations rel where rel.removal_proposal_id = p_proposal_id
    union
    select rel.to_concept_id from wk_relations rel where rel.removal_proposal_id = p_proposal_id
  )
  order by c.id
  for update;

  -- Stale-base check (unchanged).
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

  -- Flip 5c: explicit supersession — deterministic, staged, reviewer-visible.
  update wk_claims old
  set status = 'deprecated'
  from wk_claims fresh
  where fresh.proposal_id = p_proposal_id
    and fresh.status = 'verified'
    and fresh.supersedes_claim_id = old.id
    and old.status in ('verified', 'disputed');
  get diagnostics claims_deprecated = row_count;

  -- Supersedes relation between the carrying concepts (mirror of flip 5b).
  insert into wk_relations (space_id, from_concept_id, to_concept_id, kind, status, proposal_id)
  select distinct fresh.space_id, fresh.concept_id, old.concept_id, 'supersedes', 'active', p_proposal_id
  from wk_claims fresh
  join wk_claims old on old.id = fresh.supersedes_claim_id
  where fresh.proposal_id = p_proposal_id
    and fresh.status = 'verified'
    and old.status = 'deprecated'
    and fresh.concept_id <> old.concept_id
  on conflict (space_id, from_concept_id, to_concept_id, kind)
    do update set status = 'active', removal_proposal_id = null;

  -- Flip 5: interval-, context- and normalization-aware disputes on
  -- functional predicates. The status filters are stable under the flip
  -- itself ({verified,disputed} on either side), so the pair set is
  -- identical when recomputed for the relation insert below.
  with pairs as (
    select fresh.id as fresh_id, old.id as old_id
    from wk_claims fresh
    join wk_claims old
      on old.space_id = fresh.space_id
     and old.subject = fresh.subject
     and old.predicate = fresh.predicate
     and coalesce(old.context, '') = coalesce(fresh.context, '')
     and coalesce(old.object_normalized, old.object) <> coalesce(fresh.object_normalized, fresh.object)
    where fresh.proposal_id = p_proposal_id
      and fresh.predicate = any(public.wk_functional_predicates(fresh.space_id))
      and fresh.status in ('verified', 'disputed')
      and old.proposal_id is distinct from p_proposal_id
      and old.status in ('verified', 'disputed')
      and coalesce(fresh.valid_from, '-infinity'::timestamptz) < coalesce(old.valid_until, 'infinity'::timestamptz)
      and coalesce(old.valid_from, '-infinity'::timestamptz) < coalesce(fresh.valid_until, 'infinity'::timestamptz)
      and coalesce(fresh.agent_meta->>'adjudication', '') <> 'complementary'
      and (fresh.supersedes_claim_id is null or fresh.supersedes_claim_id <> old.id)
  )
  update wk_claims
  set status = 'disputed'
  where status <> 'disputed'
    and id in (select fresh_id from pairs union select old_id from pairs);
  get diagnostics claims_disputed = row_count;

  -- Flip 5b: ensure a 'contradicts' relation between the concepts carrying a
  -- disputed pair. The DO UPDATE also CLEARS any pending removal marker (see
  -- 0014 rationale: a re-derived contradiction supersedes a staged removal
  -- of the same edge).
  insert into wk_relations (space_id, from_concept_id, to_concept_id, kind, status, proposal_id)
  select distinct fresh.space_id, fresh.concept_id, old.concept_id, 'contradicts', 'active', p_proposal_id
  from wk_claims fresh
  join wk_claims old
    on old.space_id = fresh.space_id
   and old.subject = fresh.subject
   and old.predicate = fresh.predicate
   and coalesce(old.context, '') = coalesce(fresh.context, '')
   and coalesce(old.object_normalized, old.object) <> coalesce(fresh.object_normalized, fresh.object)
  where fresh.proposal_id = p_proposal_id
    and fresh.predicate = any(public.wk_functional_predicates(fresh.space_id))
    and fresh.status = 'disputed'
    and old.proposal_id is distinct from p_proposal_id
    and old.status = 'disputed'
    and coalesce(fresh.valid_from, '-infinity'::timestamptz) < coalesce(old.valid_until, 'infinity'::timestamptz)
    and coalesce(old.valid_from, '-infinity'::timestamptz) < coalesce(fresh.valid_until, 'infinity'::timestamptz)
    and coalesce(fresh.agent_meta->>'adjudication', '') <> 'complementary'
    and (fresh.supersedes_claim_id is null or fresh.supersedes_claim_id <> old.id)
    and fresh.concept_id <> old.concept_id
  on conflict (space_id, from_concept_id, to_concept_id, kind)
    do update set status = 'active', removal_proposal_id = null;

  -- Flip 6: relations and decisions staged by this proposal → active.
  update wk_relations
  set status = 'active'
  where proposal_id = p_proposal_id and status = 'proposed';

  -- Flip 6c (0034): a staged decision carrying supersedes_decision_id
  -- retires the decision it replaces. Runs BEFORE the activation below so a
  -- proposal can never both retire and re-activate the same row, and the
  -- target must still be active — a decision already superseded by an earlier
  -- approval stays as it is.
  update wk_decisions old
  set status = 'superseded'
  from wk_decisions fresh
  where fresh.proposal_id = p_proposal_id
    and fresh.status = 'proposed'
    and fresh.supersedes_decision_id = old.id
    and old.space_id = fresh.space_id
    and old.status = 'active';
  get diagnostics decisions_superseded = row_count;

  update wk_decisions
  set status = 'active'
  where proposal_id = p_proposal_id and status = 'proposed';

  -- Flip 6b: relations MARKED for removal by this proposal → removed (0014).
  update wk_relations
  set status = 'removed'
  where removal_proposal_id = p_proposal_id and status = 'active';
  get diagnostics relations_removed_count = row_count;

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
    'claims_disputed', claims_disputed,
    'claims_deprecated', claims_deprecated,
    'relations_removed', relations_removed_count,
    'decisions_superseded', decisions_superseded
  );
end;
$$;
