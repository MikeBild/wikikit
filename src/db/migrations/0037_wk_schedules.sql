-- wk_schedules — recurring maintenance, durable in Postgres (CONTRACTS §1, §4).
--
-- WHY a table instead of an entry in the host's crontab: WikiKit is one process
-- an operator starts once. A crontab line is invisible to the API, cannot be
-- per-wiki, is lost on the next redeploy, and needs a second credential to call
-- back in. The row is the truth; `next_run_at` is what two binaries against one
-- database arbitrate over with FOR UPDATE SKIP LOCKED, so exactly one of them
-- produces the morning briefing.
--
-- WHY NOT a cron expression — the deliberate limit of this table: only
-- "daily at HH:MM" and "weekly on DOW at HH:MM" exist. A full cron parser is a
-- configuration surface nobody can verify: neither the operator typing
-- `*/7 3 * * 1-5` nor the reviewer reading it can say what it will do without
-- running it, and every one of the five fields is a new way to accidentally
-- schedule a hundred runs. What is actually being asked for is "every morning",
-- and the field that makes that mean the OPERATOR's morning rather than UTC's
-- is `timezone`, not expression power. An installation that genuinely needs
-- Nth-weekday or minute-level firing already owns a cron and can drive the REST
-- route from it.
--
-- WHY at_time is `time` and not timestamptz: the promise of the row is that
-- 07:00 stays 07:00 across a DST boundary — a stored instant would drift by an
-- hour twice a year and nothing would explain why. The instant that wall clock
-- means is derived per run (src/schedule.ts computeNextRun, which resolves the
-- gap and the fold explicitly) and cached in next_run_at, so the due-check
-- stays a plain indexed comparison in SQL.
--
-- UNIQUE (space_id, kind): one briefing schedule per wiki, not a list. Two
-- briefings a day is not a thing anybody asked for, and the uniqueness is what
-- lets PUT /v1/spaces/{space}/schedules be an idempotent replace rather than an
-- append that silently accumulates duplicates.
create table if not exists public.wk_schedules (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  kind text not null check (kind in ('briefing', 'health')),
  at_time time not null,
  -- null = daily. Otherwise 0 = Sunday … 6 = Saturday — the convention shared
  -- by Postgres extract(dow) and JavaScript getUTCDay, so neither side of the
  -- fence has to convert and get it wrong.
  weekday integer check (weekday is null or (weekday between 0 and 6)),
  -- IANA zone name. Validated by the write path (src/schedule.ts) against the
  -- runtime's own zone database rather than by a CHECK: the set of valid names
  -- belongs to ICU and changes with it, and a CHECK listing them would be a
  -- migration every time a country renames a zone.
  timezone text not null default 'UTC',
  enabled boolean not null default true,
  last_run_at timestamptz,
  -- The armed instant. NULL means "not armed": a disabled schedule, or one
  -- whose window the scheduler has not computed yet. NULL never fires — a
  -- freshly saved briefing must not go off the second it is saved.
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, kind)
);

-- The claim path, verbatim: enabled rows whose window has opened, oldest first.
-- Partial on `enabled` so a switched-off schedule costs the poll nothing.
create index if not exists wk_schedules_due_idx
  on public.wk_schedules (next_run_at) where enabled;

drop trigger if exists wk_schedules_touch_updated_at on public.wk_schedules;
create trigger wk_schedules_touch_updated_at
  before update on public.wk_schedules
  for each row execute function public.wk_touch_updated_at();
