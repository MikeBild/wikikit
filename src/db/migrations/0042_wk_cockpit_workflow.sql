-- Cockpit workflow cutover: canonical source presentation, explicit wiki
-- environments and the one operator-state table behind the attention queue.
--
-- This migration deliberately normalizes existing rows before tightening the
-- constraints. Runtime code therefore has one shape to handle after startup;
-- there is no old-row fallback and no parallel v2 table.

alter table public.wk_sources
  add column if not exists raw_title text,
  add column if not exists summary text;

update public.wk_sources
   set raw_title = nullif(btrim(title), '')
 where raw_title is null;

update public.wk_sources
   set title = coalesce(
         nullif(btrim(title), ''),
         nullif(substring(markdown from '(?m)^#\s+([^\n]+)'), ''),
         'Source ' || left(content_hash, 12)
       );

update public.wk_sources
   set summary = left(
         btrim(regexp_replace(regexp_replace(markdown, '(?m)^#{1,6}\s+', '', 'g'), '\s+', ' ', 'g')),
         320
       )
 where summary is null;

update public.wk_sources set summary = '' where summary is null;

alter table public.wk_sources
  alter column title set not null,
  alter column summary set not null;

-- Every wiki says whether it is ordinary work or an explicit test probe.
-- Existing installations are normalized once; new spaces receive the same
-- value from the domain write and the boundary validates the closed set.
update public.wk_spaces
   set settings = jsonb_set(
         settings,
         '{environment}',
         to_jsonb(
           case
             when slug ~ '(^|-)(test|e2e|scout)(-|$)' then 'test'::text
             else 'production'::text
           end
         ),
         true
       )
 where not (settings ? 'environment');

-- Operator-only state for the heterogeneous attention queue. The underlying
-- proposal/capture/output/finding remains authoritative; snapshot is only the
-- human-readable card retained on the deferred/discarded shelves.
create table if not exists public.wk_attention_states (
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  item_key text not null,
  kind text not null check (kind in ('proposal', 'triage', 'output', 'care')),
  state text not null check (state in ('open', 'deferred', 'discarded')),
  remind_at timestamptz,
  note text,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (space_id, item_key),
  check (state = 'deferred' or remind_at is null)
);

create index if not exists wk_attention_states_space_state_idx
  on public.wk_attention_states (space_id, state, updated_at desc);

-- Triage is a first-class audited model call, not a classify call wearing a
-- different label.
alter table public.wk_agent_runs
  drop constraint if exists wk_agent_runs_kind_check;
alter table public.wk_agent_runs
  add constraint wk_agent_runs_kind_check
    check (kind in ('classify', 'synthesize', 'extract_decisions', 'answer', 'distill', 'adjudicate', 'embed', 'triage'));
