-- 'no_answer': a /query call completed correctly (HTTP 200) but the knowledge
-- base did not cover the question — the answer said so instead of inventing
-- content. Counted separately from 'success' on the knowledge surface so
-- operators can measure demand the curated base does not yet cover
-- (demand-vs-coverage); the http-surface row keeps transport semantics.
alter table public.wk_usage_events
  drop constraint if exists wk_usage_events_outcome_check;
alter table public.wk_usage_events
  add constraint wk_usage_events_outcome_check
    check (outcome in ('success', 'client_error', 'server_error', 'rejected', 'timeout', 'cancelled', 'handoff', 'no_answer'));
