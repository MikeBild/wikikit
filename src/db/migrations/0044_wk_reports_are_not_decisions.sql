-- Scheduled reports and generated answers are archive artifacts, not human
-- decision gates. Remove the old overlays before tightening the closed set so
-- runtime code has exactly one current attention model.

delete from public.wk_attention_states where kind = 'output';

alter table public.wk_attention_states
  drop constraint if exists wk_attention_states_kind_check;

alter table public.wk_attention_states
  add constraint wk_attention_states_kind_check
  check (kind in ('proposal', 'triage'));
