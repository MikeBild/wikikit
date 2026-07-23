-- url_elicitation review channel (MCP 2025-11-25 URL-mode elicitation).
--
-- The review page is a thin REST client; when it was opened through a
-- URL-mode elicitation the terminal review should be audited as
-- 'url_elicitation' rather than a bare 'rest'. Same evolve-in-place pattern
-- as 0010/0020: extend the column CHECK and re-create the channel-validating
-- functions with the widened whitelist — bodies otherwise unchanged
-- (wk_request_changes needs no touch: it delegates validation to
-- wk_reject_proposal).
alter table public.wk_change_proposals
  drop constraint if exists wk_change_proposals_review_channel_check;
alter table public.wk_change_proposals
  add constraint wk_change_proposals_review_channel_check
    check (review_channel is null or review_channel in ('rest', 'mcp_elicitation', 'url_elicitation'));

create or replace function public.wk_apply_proposal(
  p_proposal_id uuid,
  p_reviewer text,
  p_note text default null,
  p_review_channel text default 'rest'
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  result jsonb;
begin
  if p_review_channel is null or p_review_channel not in ('rest', 'mcp_elicitation', 'url_elicitation') then
    raise exception 'invalid_review_channel';
  end if;

  select public.wk_apply_proposal_core_0003(p_proposal_id, p_reviewer, p_note)
    into result;

  update public.wk_change_proposals
     set review_channel = p_review_channel
   where id = p_proposal_id;

  update public.wk_outbox_events
     set payload = payload || jsonb_build_object('review_channel', p_review_channel)
   where event_type = 'wikikit.proposal.approved'
     and payload->>'proposal_id' = p_proposal_id::text;

  return result || jsonb_build_object('review_channel', p_review_channel);
end;
$$;

create or replace function public.wk_reject_proposal(
  p_proposal_id uuid,
  p_reviewer text,
  p_note text default null,
  p_review_channel text default 'rest'
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  result jsonb;
begin
  if p_review_channel is null or p_review_channel not in ('rest', 'mcp_elicitation', 'url_elicitation') then
    raise exception 'invalid_review_channel';
  end if;

  select public.wk_reject_proposal_core_0000(p_proposal_id, p_reviewer, p_note)
    into result;

  update public.wk_change_proposals
     set review_channel = p_review_channel
   where id = p_proposal_id;

  update public.wk_outbox_events
     set payload = payload || jsonb_build_object('review_channel', p_review_channel)
   where event_type = 'wikikit.proposal.rejected'
     and payload->>'proposal_id' = p_proposal_id::text;

  return result || jsonb_build_object('review_channel', p_review_channel);
end;
$$;

create or replace function public.wk_split_proposal(
  p_proposal_id uuid,
  p_reviewer text,
  p_concepts text[] default null,
  p_review_channel text default 'rest'
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  proposal record;
  space_slug text;
  staged_slugs text[];
  target_slugs text[];
  decision_count int;
  leftover_markers int;
  v_slug text;
  target_concept_id uuid;
  child_id uuid;
  children jsonb := '[]'::jsonb;
  full_split boolean;
begin
  if p_review_channel is null or p_review_channel not in ('rest', 'mcp_elicitation', 'url_elicitation') then
    raise exception 'invalid_review_channel';
  end if;

  select * into proposal from wk_change_proposals where id = p_proposal_id for update;
  if not found then raise exception 'proposal_not_found'; end if;
  if proposal.status <> 'pending' then raise exception 'proposal_not_pending'; end if;

  select s.slug into space_slug from wk_spaces s where s.id = proposal.space_id;

  select coalesce(array_agg(distinct c.slug), '{}') into staged_slugs
    from wk_concept_revisions r
    join wk_concepts c on c.id = r.concept_id
   where r.proposal_id = p_proposal_id and r.status = 'proposed';

  select count(*) into decision_count
    from wk_decisions where proposal_id = p_proposal_id and status = 'proposed';

  full_split := p_concepts is null;

  if full_split then
    target_slugs := staged_slugs;
    -- Splitting must produce MORE reviewable units than the parent was:
    -- a single-concept proposal without decisions (or an empty/removal-only
    -- one) has nothing to split apart.
    if coalesce(array_length(staged_slugs, 1), 0) = 0
       or (array_length(staged_slugs, 1) = 1 and decision_count = 0) then
      raise exception 'split_nothing_left';
    end if;
  else
    select coalesce(array_agg(distinct s), '{}') into target_slugs from unnest(p_concepts) s;
    if coalesce(array_length(target_slugs, 1), 0) = 0 then raise exception 'unknown_split_slug'; end if;
    if exists (select 1 from unnest(target_slugs) s where s <> all (staged_slugs)) then
      raise exception 'unknown_split_slug';
    end if;
    -- A subset covering EVERY staged concept is a full split the caller
    -- should have asked for (the parent would keep nothing but decisions).
    if not exists (select 1 from unnest(staged_slugs) s where s <> all (target_slugs)) then
      raise exception 'split_nothing_left';
    end if;
  end if;

  foreach v_slug in array target_slugs loop
    select c.id into target_concept_id
      from wk_concepts c where c.space_id = proposal.space_id and c.slug = v_slug;

    insert into wk_change_proposals
      (space_id, status, title, summary, input_hash, source_ids, agent_meta, parent_proposal_id)
    values
      (proposal.space_id,
       'pending',
       proposal.title || ' — ' || v_slug,
       proposal.summary,
       encode(digest(proposal.input_hash || ':' || v_slug, 'sha256'), 'hex'),
       proposal.source_ids,
       coalesce(proposal.agent_meta, '{}'::jsonb) || jsonb_build_object('split_from', p_proposal_id),
       p_proposal_id)
    returning id into child_id;

    update wk_concept_revisions set proposal_id = child_id
     where proposal_id = p_proposal_id and concept_id = target_concept_id and status = 'proposed';
    update wk_claims set proposal_id = child_id
     where proposal_id = p_proposal_id and concept_id = target_concept_id and status = 'proposed';
    update wk_relations set proposal_id = child_id
     where proposal_id = p_proposal_id and from_concept_id = target_concept_id and status = 'proposed';
    -- Removal markers ride on removal_proposal_id (0014), grouped under the
    -- concept the edge leaves from.
    update wk_relations set removal_proposal_id = child_id
     where removal_proposal_id = p_proposal_id and from_concept_id = target_concept_id;

    children := children || jsonb_build_object('proposal_id', child_id, 'concepts', jsonb_build_array(v_slug));
  end loop;

  if full_split then
    select count(*) into leftover_markers
      from wk_relations where removal_proposal_id = p_proposal_id;
    if decision_count > 0 or leftover_markers > 0 then
      -- Decisions (and markers whose from-concept was not staged) get their
      -- own child so nothing staged is orphaned on a terminal parent.
      insert into wk_change_proposals
        (space_id, status, title, summary, input_hash, source_ids, agent_meta, parent_proposal_id)
      values
        (proposal.space_id,
         'pending',
         proposal.title || ' — decisions',
         proposal.summary,
         encode(digest(proposal.input_hash || ':decisions', 'sha256'), 'hex'),
         proposal.source_ids,
         coalesce(proposal.agent_meta, '{}'::jsonb) || jsonb_build_object('split_from', p_proposal_id),
         p_proposal_id)
      returning id into child_id;
      update wk_decisions set proposal_id = child_id
       where proposal_id = p_proposal_id and status = 'proposed';
      update wk_relations set removal_proposal_id = child_id
       where removal_proposal_id = p_proposal_id;
      children := children || jsonb_build_object('proposal_id', child_id, 'concepts', '[]'::jsonb);
    end if;

    update wk_change_proposals
       set status = 'split', reviewer = p_reviewer, reviewed_at = now(), review_channel = p_review_channel
     where id = p_proposal_id;
  else
    -- Defer: the parent stays pending with the remainder. Re-salt its
    -- input_hash so a full re-ingest of the same sources stages a fresh
    -- COMPLETE proposal instead of converging on this partial one.
    update wk_change_proposals
       set input_hash = encode(digest(proposal.input_hash || ':remainder:' || array_to_string(target_slugs, ','), 'sha256'), 'hex')
     where id = p_proposal_id;
  end if;

  insert into wk_outbox_events (space_id, event_type, payload)
  values (proposal.space_id, 'wikikit.proposal.split', jsonb_build_object(
    'space', space_slug,
    'parent_id', p_proposal_id,
    'parent_status', case when full_split then 'split' else 'pending' end,
    'children', children,
    'reviewer', p_reviewer
  ));

  return jsonb_build_object(
    'parent', jsonb_build_object('id', p_proposal_id, 'status', case when full_split then 'split' else 'pending' end),
    'children', children
  );
end;
$$;
