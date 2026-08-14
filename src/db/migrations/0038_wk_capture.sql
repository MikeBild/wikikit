-- Capture — a place to park a thought without paying for it.
--
-- WHY: ingest is processing, not an inbox. Submitting anything demanded an LLM
-- key, a slot under the per-space queue ceiling, and started model work — so
-- there was no cheap, decision-free way to hold a raw note until a human says
-- "now read it". A capture is an ordinary wk_ingest_jobs row parked in
-- status='captured': the text sits verbatim in the existing `input` jsonb, no
-- wk_sources row, no LLM call, invisible to the worker's claim query (which
-- selects only 'queued'). Promotion flips it to 'queued' and the unchanged
-- pipeline runs; 'discarded' is terminal and the row stays for the record.
--
-- Same DROP+ADD pattern as 0008 (the quota_blocked widening): the CHECK is a
-- strict superset, so a previous binary keeps running against rows in the new
-- statuses — it merely never claims or counts them.

alter table public.wk_ingest_jobs
  drop constraint if exists wk_ingest_jobs_status_check;
alter table public.wk_ingest_jobs
  add constraint wk_ingest_jobs_status_check
    check (status in ('queued', 'running', 'done', 'failed', 'quota_blocked', 'captured', 'discarded'));

-- The parked-notes strip: one space's captures, oldest first (the stale-capture
-- age question). Partial, so the queue and the archive pay nothing for it.
create index if not exists wk_ingest_jobs_captured_idx
  on public.wk_ingest_jobs (space_id, created_at)
  where status = 'captured';
