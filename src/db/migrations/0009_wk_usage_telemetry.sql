-- Opt-in, privacy-bounded product usage telemetry. Events contain no source
-- content, prompts, query strings, tool arguments/results, network identifiers,
-- credentials or dynamic resource ids. Actor/session values are product-local
-- HMACs computed before the append-only row is written.
create table if not exists public.wk_usage_events (
  id bigserial primary key,
  space_id uuid references public.wk_spaces(id) on delete cascade,
  surface text not null check (surface in ('http', 'mcp', 'knowledge', 'review')),
  operation text not null check (operation ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  route text check (route is null or (length(route) between 1 and 200 and route not like '%?%')),
  method text check (method is null or method in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')),
  status_code integer check (status_code is null or status_code between 100 and 599),
  outcome text not null check (outcome in ('success', 'client_error', 'server_error', 'rejected', 'timeout', 'cancelled')),
  traffic_class text not null default 'organic' check (traffic_class in ('organic', 'synthetic', 'internal')),
  request_source text not null default 'api' check (request_source in ('api', 'gateway', 'scheduler', 'manual', 'mcp')),
  actor_hmac text check (actor_hmac is null or actor_hmac ~ '^[0-9a-f]{64}$'),
  session_hmac text check (session_hmac is null or session_hmac ~ '^[0-9a-f]{64}$'),
  duration_ms bigint not null default 0 check (duration_ms >= 0),
  request_bytes bigint check (request_bytes is null or request_bytes >= 0),
  response_bytes bigint check (response_bytes is null or response_bytes >= 0),
  result_count integer check (result_count is null or result_count >= 0),
  tool_name text check (tool_name is null or tool_name ~ '^[a-z][a-z0-9_]{0,79}$'),
  response_mode text check (response_mode is null or response_mode in ('json', 'sse', 'none')),
  active_sessions integer check (active_sessions is null or active_sessions >= 0),
  created_at timestamptz not null default now()
);

create index if not exists wk_usage_events_space_created_idx
  on public.wk_usage_events (space_id, created_at);
create index if not exists wk_usage_events_surface_created_idx
  on public.wk_usage_events (surface, created_at);
create index if not exists wk_usage_events_space_surface_created_idx
  on public.wk_usage_events (space_id, surface, created_at);
create index if not exists wk_usage_events_created_idx
  on public.wk_usage_events (created_at);
