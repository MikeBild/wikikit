-- Reusable, revocable browser sessions for MCP OAuth consent. The opaque
-- browser token is represented only by its keyed hash; source API keys and
-- external-provider assertions are never persisted here.
create table if not exists public.wk_oauth_operator_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  principal_kind text not null check (principal_kind in ('api_key', 'identity')),
  principal_key_id text not null,
  principal_key_hash text not null,
  principal_name text not null,
  principal_space_id uuid references public.wk_spaces(id) on delete cascade,
  provider_id text,
  provider_subject text,
  scopes text[] not null,
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (principal_kind = 'api_key' and provider_id is null and provider_subject is null)
    or
    (principal_kind = 'identity' and provider_id is not null and provider_subject is not null)
  )
);

create index if not exists wk_oauth_operator_sessions_expiry_idx
  on public.wk_oauth_operator_sessions (absolute_expires_at)
  where revoked_at is null;
