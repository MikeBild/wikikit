-- Durable provenance for every new terminal proposal review. Existing rows
-- remain NULL because their historical transport cannot be reconstructed.
alter table public.wk_change_proposals
  add column if not exists review_channel text;

alter table public.wk_change_proposals
  drop constraint if exists wk_change_proposals_review_channel_check;
alter table public.wk_change_proposals
  add constraint wk_change_proposals_review_channel_check
    check (review_channel is null or review_channel in ('rest', 'mcp_elicitation'));

-- Preserve the proven locking/status-flip implementations from the previous
-- migrations as private cores. The public four-argument wrappers add channel
-- provenance and enrich the just-created outbox payload in the SAME database
-- transaction. The default keeps v0.4 binaries and direct three-argument calls
-- operational during a binary rollback.
alter function public.wk_apply_proposal(uuid, text, text)
  rename to wk_apply_proposal_core_0003;

create function public.wk_apply_proposal(
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
  if p_review_channel is null or p_review_channel not in ('rest', 'mcp_elicitation') then
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

alter function public.wk_reject_proposal(uuid, text, text)
  rename to wk_reject_proposal_core_0000;

create function public.wk_reject_proposal(
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
  if p_review_channel is null or p_review_channel not in ('rest', 'mcp_elicitation') then
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
