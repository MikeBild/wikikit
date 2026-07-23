-- Apply-core rewrite for the 0021 claim semantics — interval-, context- and
-- normalization-aware disputes plus deterministic supersession.
-- Same-signature CREATE OR REPLACE of wk_apply_proposal_core_0003 (the 0014
-- precedent; the name is the historical rename anchor from the RELEASED 0010
-- migration and cannot change): the 0010 four-argument public wrapper keeps
-- calling the core unchanged, and the raise messages stay exactly
-- 'proposal_not_found' / 'proposal_not_pending' / 'stale_base'.
--
-- Changes over 0014, all confined to the claim flips:
--   * Flip 5 pairs additionally require: same context partition
--     (coalesce(context,'')), NORMALIZED object inequality
--     (coalesce(object_normalized, object)), OVERLAPPING validity intervals
--     (disjoint validity = succession, not contradiction), no
--     adjudication='complementary' stamp on the incoming claim (the
--     adjudicator's verdict is staged in agent_meta and visible in the
--     review diff — the human approved it), and the pair is not an explicit
--     supersession (those take flip 5c).
--   * Flip 5c (new, runs BEFORE flip 5): fresh verified claims carrying
--     supersedes_claim_id deprecate their target deterministically and
--     upsert a 'supersedes' relation between differing concepts. Running
--     first removes the deprecated side from the visible statuses flip 5
--     joins on — a superseded claim never also becomes disputed.
--   * The result carries claims_deprecated (wire: ApplyResult).
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
    'relations_removed', relations_removed_count
  );
end;
$$;
