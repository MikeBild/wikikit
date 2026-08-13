-- Ingest progress: what the job is doing, and how far along it is.
--
-- WHY: a job that classified ten concepts runs ten sequential synthesis calls
-- of one to three minutes each. For twenty-three minutes the only observable
-- state was status='running' with proposal_id null — identical to the state of
-- a job wedged inside a hung HTTP call. An operator could not tell "slow" from
-- "stuck", and nothing in the row said which of the two it was.
--
-- The lease already answers "is a worker alive" (heartbeat_at renews it). What
-- was missing is what the live worker is DOING, so these three columns carry
-- the stage and, where the stage is a loop over a known set, its position in
-- it.
--
-- No CHECK on phase: it is an advisory diagnostic, and adding a stage to the
-- pipeline must not require a migration. The wire schema documents the values
-- and readers treat an unknown one as "running".
--
-- Kept on terminal rows on purpose — "failed while synthesizing 3 of 10" is
-- precisely the post-mortem the incident lacked. The claim UPDATE resets them,
-- so a requeued job never shows the previous attempt's position.
alter table public.wk_ingest_jobs
  add column if not exists phase text,
  add column if not exists progress_done integer,
  add column if not exists progress_total integer;
