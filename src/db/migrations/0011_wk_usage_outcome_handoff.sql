-- 'handoff': a review request on a client without form elicitation completed
-- correctly WITHOUT a mutation — the proposal stays pending for an out-of-band
-- human review. Counted separately from 'success' so operators can see how
-- often clients cannot finish the review natively.
alter table public.wk_usage_events
  drop constraint if exists wk_usage_events_outcome_check;
alter table public.wk_usage_events
  add constraint wk_usage_events_outcome_check
    check (outcome in ('success', 'client_error', 'server_error', 'rejected', 'timeout', 'cancelled', 'handoff'));
