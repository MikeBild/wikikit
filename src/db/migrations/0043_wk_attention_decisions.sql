-- A check finding is an observation, not a human decision. Remove the old
-- operator overlays once, normalize the remaining snapshots to the one current
-- wire shape, then tighten the table so no runtime fallback can revive `care`.

delete from public.wk_attention_states where kind = 'care';

update public.wk_attention_states
   set snapshot = (snapshot - 'source' - 'finding') ||
                  jsonb_build_object('origins', '[]'::jsonb, 'targets', '[]'::jsonb)
 where snapshot ? 'source' or snapshot ? 'finding' or not (snapshot ? 'origins') or not (snapshot ? 'targets');

alter table public.wk_attention_states
  drop constraint if exists wk_attention_states_kind_check;

alter table public.wk_attention_states
  add constraint wk_attention_states_kind_check
  check (kind in ('proposal', 'triage', 'output'));

-- Concurrent retries of "Wissen vorschlagen" converge on the active job.
create unique index if not exists wk_ingest_jobs_active_resynthesis_idx
  on public.wk_ingest_jobs (space_id, ((input->>'resynthesize_source_id')))
  where status in ('queued', 'running', 'quota_blocked')
    and input ? 'resynthesize_source_id';
