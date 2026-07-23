-- Versioned source-sync contract — the connector-facing ingest surface.
--
--   * WikiKit builds no connectors; an external workflow platform pushes
--     documents. What was missing is a stable identity ACROSS pushes: until
--     now a source was identified only by content hash, so two versions of
--     the same external document were two unrelated rows and upstream
--     deletion was inexpressible.
--   * wk_source_streams holds the MUTABLE per-external-id state: the head
--     pointer, latest version marker and the tombstone. wk_sources stays
--     100% immutable — every new column below is written once at INSERT and
--     never touched; content-hash dedup and the append-only verbatim archive
--     are unchanged.
--   * A content REVERT (v3 byte-identical to v1) is the case that forces
--     this shape: unique(space_id, content_hash) correctly refuses a second
--     row, so per-row version columns record the version under which the
--     content was FIRST observed, while the stream's head pointer and
--     latest_version carry current truth.
--   * Tombstone is a soft flag on the stream (deleted_at), never a delete:
--     cited sources are undeletable by design (wk_citations RESTRICT), and
--     the archived bytes remain evidence of what the document said. A
--     re-push after a tombstone resurrects the stream (the connector says
--     the document exists again).
--   * No backfill and no retro-streams from URLs: a URL was never identity,
--     and inventing streams for historical rows would be non-deterministic.
create table if not exists public.wk_source_streams (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.wk_spaces(id) on delete cascade,
  external_source_id text not null check (length(external_source_id) between 1 and 500),
  latest_source_id uuid references public.wk_sources(id),
  latest_version text,
  latest_observed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, external_source_id)
);

drop trigger if exists wk_source_streams_touch_updated_at on public.wk_source_streams;
create trigger wk_source_streams_touch_updated_at
  before update on public.wk_source_streams
  for each row execute function public.wk_touch_updated_at();

-- Write-once version columns on the immutable archive rows.
alter table public.wk_sources
  add column if not exists stream_id uuid references public.wk_source_streams(id) on delete set null,
  add column if not exists source_version text,
  add column if not exists observed_at timestamptz,
  add column if not exists effective_at timestamptz,
  add column if not exists supersedes_source_id uuid references public.wk_sources(id);

create index if not exists wk_sources_stream_idx
  on public.wk_sources (stream_id, created_at desc)
  where stream_id is not null;
