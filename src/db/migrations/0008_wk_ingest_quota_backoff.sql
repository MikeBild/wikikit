-- Provider quota exhaustion must pause ingest, not fail it: a burst of jobs
-- hitting "You have reached your specified API usage limits" was flipped to
-- failed and the work lost until a human re-submitted — days after the quota
-- reset. quota_blocked parks the job with a resume_at; the worker requeues it
-- once the provider window reopens.

alter table public.wk_ingest_jobs
  drop constraint if exists wk_ingest_jobs_status_check;
alter table public.wk_ingest_jobs
  add constraint wk_ingest_jobs_status_check
    check (status in ('queued', 'running', 'done', 'failed', 'quota_blocked'));

alter table public.wk_ingest_jobs
  add column if not exists resume_at timestamptz;

create index if not exists wk_ingest_jobs_quota_blocked_idx
  on public.wk_ingest_jobs (resume_at)
  where status = 'quota_blocked';
