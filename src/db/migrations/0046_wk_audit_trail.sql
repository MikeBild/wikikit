-- audit.v1 — the append-only audit trail (Cockpit convention §15.5).
--
-- WikiKit had four append-only records (page revisions, guideline revisions,
-- decisions, agent runs) and no trail: nothing carried a sequence, a hash, a
-- result, a transport, or a request id, and nothing recorded a REFUSAL. This
-- migration adds the engine those four records can hang off; it replaces none
-- of them — wk_audit_events points AT them via resource_type/resource_id.
--
-- Four properties this file is responsible for, in order of importance:
--
--   1. APPEND-ONLY BY PRIVILEGE, NOT BY DISCIPLINE. Update, delete and
--      truncate are revoked from PUBLIC and from the role that runs this
--      migration (which in every current WikiKit deployment is also the
--      runtime role). A trigger repeats the same refusal, because a superuser
--      DATABASE_URL bypasses the ACL entirely and a table owner can re-grant
--      what it revoked from itself. Neither mechanism alone is honest; both
--      together fail the same way for every non-superuser, and the trigger
--      alone still fails for a superuser.
--   2. SEQUENCE AND HASH ARE ASSIGNED ATOMICALLY UNDER A LOCK.
--      wk_append_audit_event locks the single chain-head row FOR UPDATE, so
--      two concurrent appends cannot read the same predecessor. A bigserial
--      would hand out gaps on rollback and would not chain.
--   3. NO FOREIGN KEY TO wk_spaces. Deliberate: `on delete cascade` would
--      delete audit rows with the wiki, and `on delete set null` is an UPDATE
--      the immutability trigger must refuse. The trail outlives its referents,
--      so space_id is a plain uuid and the reader tolerates a dangling one.
--   4. NOTHING HERE EXPIRES. There is no retention column, no expires_at, and
--      no sweep may be written against this table.
create table if not exists public.wk_audit_events (
  id uuid primary key default gen_random_uuid(),
  -- Monotone, gapless within a committed chain. Assigned by the append
  -- function under the chain-head lock, never by a sequence.
  seq bigint not null unique,
  schema_version text not null default 'audit.v1',
  -- UTC. The instant the event happened, as the writer observed it.
  occurred_at timestamptz not null default now(),
  -- The product area. WikiKit's is the Space (wiki). No FK: see (3) above.
  space_id uuid,
  -- The actor, as TRUSTWORTHILY DETERMINED by the authenticated request —
  -- never a caller-supplied name. actor_kind names how it was established.
  actor_kind text not null
    check (actor_kind in ('identity', 'api_key', 'operator_session', 'system', 'anonymous')),
  -- Stable id of the principal (identity id, api key id, session id).
  actor_id text,
  -- What to show a human. NULL where the credential carries no name: §15.2
  -- renders a dash, and nothing is ever inferred from a timestamp or a route.
  actor_label text,
  action text not null check (action ~ '^[a-z][a-z0-9_.]{0,79}$'),
  resource_type text not null check (resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  resource_id text,
  -- Revision of the resource where it has one (page rev, charter rev).
  resource_revision text,
  result text not null check (result in ('success', 'denied', 'error', 'cancelled')),
  transport text not null
    check (transport in ('http', 'mcp', 'a2a', 'cockpit', 'cli', 'worker', 'webhook', 'channel', 'tick', 'system')),
  request_id text,
  trace_id text,
  -- Redacted by the writer before it arrives here: no secrets, no tokens, no
  -- full document bodies. jsonb (not json) because the hash canonicalization
  -- below relies on jsonb's deterministic key order.
  before jsonb,
  after jsonb,
  metadata jsonb not null default '{}'::jsonb,
  -- The chain. Genesis carries 64 zeros; every later row carries its
  -- predecessor's sha256.
  prev_sha256 text not null check (prev_sha256 ~ '^[0-9a-f]{64}$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

-- The chain head. One row per stream; WikiKit runs a single 'global' stream so
-- the sequence is total across wikis (a per-wiki chain would let a whole wiki's
-- history be dropped without breaking anything). This table IS mutable — it is
-- a pointer, not evidence, and the evidence it points at is the trail itself.
create table if not exists public.wk_audit_chain_head (
  stream text primary key,
  seq bigint not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

insert into public.wk_audit_chain_head (stream, seq, sha256)
values ('global', 0, repeat('0', 64))
on conflict (stream) do nothing;

create index if not exists wk_audit_events_seq_desc_idx on public.wk_audit_events (seq desc);
create index if not exists wk_audit_events_space_seq_idx on public.wk_audit_events (space_id, seq desc);
create index if not exists wk_audit_events_occurred_idx on public.wk_audit_events (occurred_at desc, seq desc);
create index if not exists wk_audit_events_action_idx on public.wk_audit_events (action, seq desc);
create index if not exists wk_audit_events_resource_idx on public.wk_audit_events (resource_type, resource_id, seq desc);
create index if not exists wk_audit_events_actor_idx on public.wk_audit_events (actor_kind, actor_id, seq desc);
create index if not exists wk_audit_events_result_idx on public.wk_audit_events (result, seq desc);

-- The immutability refusal. One function, three triggers: row-level for update
-- and delete, statement-level for truncate (no row trigger ever sees a
-- TRUNCATE, which is exactly how audit tables get emptied by accident).
create or replace function public.wk_audit_events_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'wk_audit_events is append-only: % refused', tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists wk_audit_events_no_update on public.wk_audit_events;
create trigger wk_audit_events_no_update
  before update on public.wk_audit_events
  for each row execute function public.wk_audit_events_append_only();

drop trigger if exists wk_audit_events_no_delete on public.wk_audit_events;
create trigger wk_audit_events_no_delete
  before delete on public.wk_audit_events
  for each row execute function public.wk_audit_events_append_only();

drop trigger if exists wk_audit_events_no_truncate on public.wk_audit_events;
create trigger wk_audit_events_no_truncate
  before truncate on public.wk_audit_events
  for each statement execute function public.wk_audit_events_append_only();

-- The privilege half of property (1). REVOKE FROM CURRENT_USER strips the
-- owner's own implicit rights; the owner can grant them back, which is why the
-- triggers above exist and why a two-role deployment (a runtime role that is
-- not the owner) is the only configuration where this is airtight.
revoke update, delete, truncate on public.wk_audit_events from public;
revoke update, delete, truncate on public.wk_audit_events from current_user;

-- The one write path. Locks the chain head, derives seq and sha256 from the
-- predecessor, inserts, advances the head — all inside the CALLER's
-- transaction, so a business change and its audit entry commit together or
-- not at all.
--
-- The hash preimage is a jsonb object rendered to text. jsonb orders keys
-- deterministically (length, then bytewise) and normalizes nested values, so
-- the same event produces the same digest on any server without a hand-rolled
-- canonicalizer. Every column that carries meaning is in the preimage; id and
-- created_at are not, because they are storage facts, not the event.
create or replace function public.wk_append_audit_event(p_event jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_head public.wk_audit_chain_head%rowtype;
  v_seq bigint;
  v_prev text;
  v_occurred timestamptz;
  v_preimage text;
  v_sha text;
  v_id uuid;
begin
  select * into v_head
    from public.wk_audit_chain_head
   where stream = 'global'
     for update;
  if not found then
    raise exception 'audit chain head missing' using errcode = 'P0002';
  end if;

  v_seq := v_head.seq + 1;
  v_prev := v_head.sha256;
  v_occurred := coalesce((p_event->>'occurred_at')::timestamptz, now());

  v_preimage := jsonb_build_object(
    'action', p_event->>'action',
    'actor_id', p_event->>'actor_id',
    'actor_kind', p_event->>'actor_kind',
    'actor_label', p_event->>'actor_label',
    'after', coalesce(p_event->'after', 'null'::jsonb),
    'before', coalesce(p_event->'before', 'null'::jsonb),
    'metadata', coalesce(p_event->'metadata', '{}'::jsonb),
    'occurred_at', to_char(v_occurred at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'prev_sha256', v_prev,
    'request_id', p_event->>'request_id',
    'resource_id', p_event->>'resource_id',
    'resource_revision', p_event->>'resource_revision',
    'resource_type', p_event->>'resource_type',
    'result', p_event->>'result',
    'schema_version', coalesce(p_event->>'schema_version', 'audit.v1'),
    'seq', v_seq,
    'space_id', p_event->>'space_id',
    'trace_id', p_event->>'trace_id',
    'transport', p_event->>'transport'
  )::text;
  v_sha := encode(digest(v_preimage, 'sha256'), 'hex');

  insert into public.wk_audit_events (
    seq, schema_version, occurred_at, space_id,
    actor_kind, actor_id, actor_label,
    action, resource_type, resource_id, resource_revision,
    result, transport, request_id, trace_id,
    before, after, metadata, prev_sha256, sha256
  ) values (
    v_seq,
    coalesce(p_event->>'schema_version', 'audit.v1'),
    v_occurred,
    nullif(p_event->>'space_id', '')::uuid,
    p_event->>'actor_kind',
    nullif(p_event->>'actor_id', ''),
    nullif(p_event->>'actor_label', ''),
    p_event->>'action',
    p_event->>'resource_type',
    nullif(p_event->>'resource_id', ''),
    nullif(p_event->>'resource_revision', ''),
    p_event->>'result',
    p_event->>'transport',
    nullif(p_event->>'request_id', ''),
    nullif(p_event->>'trace_id', ''),
    p_event->'before',
    p_event->'after',
    coalesce(p_event->'metadata', '{}'::jsonb),
    v_prev,
    v_sha
  )
  returning id into v_id;

  update public.wk_audit_chain_head
     set seq = v_seq, sha256 = v_sha, updated_at = now()
   where stream = 'global';

  return jsonb_build_object('id', v_id, 'seq', v_seq, 'sha256', v_sha, 'prev_sha256', v_prev);
end;
$$;

-- The documented changeover point (§15, "Historische Lücken werden nicht
-- schöngerechnet"). Everything that happened before this row exists only in
-- the four fachhistorien, which carry no chain and no refusals — so the trail
-- opens by SAYING that, in a row that is itself chained. Gapless proof starts
-- at seq 2.
select public.wk_append_audit_event(jsonb_build_object(
  'action', 'audit.trail.opened',
  'actor_kind', 'system',
  'resource_type', 'audit_trail',
  'resource_id', 'global',
  'result', 'success',
  'transport', 'system',
  'metadata', jsonb_build_object(
    'legacy_partial', true,
    'schema_version', 'audit.v1',
    'note', 'Events before this row were never chained. The pre-existing records (wk_concept_revisions, wk_charter_revisions, wk_decisions, wk_agent_runs) remain the authority for their own history and carry no hash, no sequence, no result and no refusals.'
  )
));
