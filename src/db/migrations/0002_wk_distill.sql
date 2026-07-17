-- Session distillation (distill.v1) is a fourth kind of LLM call, so the audit
-- ledger's kind whitelist has to admit it. The ledger is the audit contract:
-- every LLM call WikiKit makes lands here, and a call whose kind the CHECK
-- rejects would fail the write rather than go unrecorded — which is the right
-- failure mode, and why this constraint moves in lockstep with the provider
-- interface instead of being loosened to free text.
alter table public.wk_agent_runs
  drop constraint if exists wk_agent_runs_kind_check;

alter table public.wk_agent_runs
  add constraint wk_agent_runs_kind_check
  check (kind in ('classify', 'synthesize', 'answer', 'distill', 'adjudicate'));
