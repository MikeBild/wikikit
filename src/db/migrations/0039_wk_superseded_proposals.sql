-- Retire the proposals a newer stream version made obsolete.
--
-- WHY: a stream's head IS current truth. When a new version supersedes the
-- previous head, a proposal still PENDING on that predecessor was synthesized
-- from bytes the stream has already moved past. For a coding session (stream
-- key 'agent-session:<id>') this is provable rather than merely likely — the
-- newer transcript CONTAINS the older one, so the newer distillate saw
-- everything the older one saw. Left alone, the predecessor survives in the
-- review queue as a competitor to its own replacement, and a reviewer who
-- approves the newer one first burns the older one on stale_base.
--
-- WHY 'failed' and not a new status: 'failed' already means "this can never
-- become knowledge" everywhere (cockpit, lint, overview, docs, §9.2), and the
-- review_note carries the reason. A dedicated status would have to be taught
-- to every one of those surfaces to say the same thing. This mirrors the
-- stale_base auto-termination in src/domain/proposals.ts, including its side
-- effect: the freed (space_id, input_hash) pending-dedup slot.
--
-- WHY a SQL function for a single UPDATE: proposal state changes happen ONLY
-- in SQL functions (0020) — a TypeScript UPDATE that flips a proposal is the
-- exact class of write that invariant exists to keep out of the codebase.
--
-- Staged rows (revisions, claims, decisions) are left untouched, as the
-- stale_base path leaves them: a 'proposed' revision belonging to no pending
-- proposal is invisible to every reader, and keeping it preserves the record
-- of what the older capture would have said. No outbox event either — nobody
-- reviewed anything, and 'wikikit.proposal.*' events report review decisions.
create or replace function public.wk_retire_superseded_proposals(
  p_space_id uuid,
  p_source_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  retired uuid[];
begin
  if p_space_id is null or p_source_id is null then
    raise exception 'space_id_and_source_id_required';
  end if;

  -- Guarded on status = 'pending': approved, rejected, failed and split rows
  -- are terminal and must never be rewritten by a background worker.
  with terminated as (
    update wk_change_proposals
       set status = 'failed',
           review_note = coalesce(p_note, 'superseded by a newer version of the same source stream'),
           reviewed_at = now()
     where space_id = p_space_id
       and status = 'pending'
       and p_source_id = any (source_ids)
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into retired from terminated;

  return jsonb_build_object(
    'source_id', p_source_id,
    'retired', coalesce(array_length(retired, 1), 0),
    'proposal_ids', to_jsonb(retired)
  );
end;
$$;
