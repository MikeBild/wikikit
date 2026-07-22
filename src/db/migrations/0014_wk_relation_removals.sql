-- relations_removed: a pending removal is a MARKER (removal_proposal_id) on
-- the still-ACTIVE wk_relations row — never a status flip before approval,
-- because every reader filters status = 'active' and the unique
-- (space_id, from_concept_id, to_concept_id, kind) constraint allows exactly
-- one row per edge. Approve flips the marked row to 'removed' (soft delete;
-- the marker is KEPT for the audit trail — rows are never hard-deleted).
-- Reject touches nothing: the marker stays pinned to the rejected proposal so
-- its diff remains reviewable after the fact, exactly like rejected claims
-- and decisions. A later proposal re-staging the same removal overwrites the
-- marker (single-slot provenance — the same accepted trade-off as
-- proposal_id re-adoption in createProposal).
alter table public.wk_relations
  add column if not exists removal_proposal_id uuid;

alter table public.wk_relations
  drop constraint if exists wk_relations_removal_proposal_fk;
alter table public.wk_relations
  add constraint wk_relations_removal_proposal_fk
  foreign key (removal_proposal_id) references public.wk_change_proposals(id) on delete set null;

create index if not exists wk_relations_removal_proposal_idx
  on public.wk_relations (removal_proposal_id)
  where removal_proposal_id is not null;

-- Same-signature redefinition of the apply core (the 0003 precedent: CREATE
-- OR REPLACE under the existing name — the 0010 four-argument public wrapper
-- keeps calling wk_apply_proposal_core_0003 unchanged, and the raise messages
-- stay exactly 'proposal_not_found' / 'proposal_not_pending' / 'stale_base').
-- Additions over 0003: the concept-lock set also covers removal endpoints,
-- Flip 6b deactivates marked relations, and the result carries
-- relations_removed. wk_reject_proposal_core_0000 needs NO change: its
-- relation flip is guarded status = 'proposed', so marked ACTIVE rows are
-- untouched by rejection by construction.
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
  -- concept subset can never deadlock. Now includes the endpoints of
  -- relations this proposal marks for removal — they may have no staged
  -- revision of their own.
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
  -- The DO UPDATE also CLEARS any pending removal marker: the apply function
  -- itself just re-derived this contradiction, which supersedes a staged
  -- removal of the same edge — otherwise Flip 6b below would deactivate, in
  -- the same transaction, the very relation Flip 5b asserted, leaving two
  -- freshly disputed claims without their contradicts signal.
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
    do update set status = 'active', removal_proposal_id = null;

  -- Flip 6: relations and decisions staged by this proposal → active.
  update wk_relations
  set status = 'active'
  where proposal_id = p_proposal_id and status = 'proposed';

  update wk_decisions
  set status = 'active'
  where proposal_id = p_proposal_id and status = 'proposed';

  -- Flip 6b: relations MARKED for removal by this proposal → removed. The
  -- row stayed 'active' (visible to every reader) throughout review; only
  -- approval deactivates it. removal_proposal_id is kept for the audit
  -- trail — never hard-deleted. Idempotent under races: a marker stolen by a
  -- later proposal, or an edge already removed by a concurrently approved
  -- one, simply matches nothing and the count reports it.
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
    'relations_removed', relations_removed_count
  );
end;
$$;
